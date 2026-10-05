import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capFor, capTarget, DEFAULT_MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, MIN_IMAGE_EDGE } from './cap.mjs';

export const name = 'dsh-image-edge-cap';
export const inject = ['llm'];
const LOG_PREFIX = 'dsh-image-edge-cap:';
const ORIGINAL = Symbol.for('cordis.original');
/** Marks the wrapper this plugin installs, so disposal never removes someone else's. */
const WRAPPED = Symbol.for('dsh-image-edge-cap.wrapped');

/** DSH releases this version was tested against (unit tests plus a real Cordis mount). */
export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.0-rc.1']);

/**
 * Versions accepted without `allowUntestedHarness`. The request-image path
 * this plugin relies on (`attachments.readImageRequest` with a route target)
 * first shipped in 0.2.0-rc.1; 0.3.0 and its prereleases are refused until tested.
 */
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.2.0-rc.1', below: '0.3.0' });

/** Compare two semver strings, prerelease aware (`0.2.0-rc.1` < `0.2.0`). */
export function compareVersions(left, right) {
  const parse = version => {
    const [core, pre] = String(version).split('-', 2);
    return { core: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre: pre === undefined ? null : pre.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a.core[index] ?? 0) !== (b.core[index] ?? 0)) return (a.core[index] ?? 0) < (b.core[index] ?? 0) ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1;
    if (nx !== null || ny !== null) return nx !== null ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** @returns {'tested' | 'compatible' | 'unsupported' | 'unknown'} */
export function classifyVersion(version) {
  if (version === undefined) return 'unknown';
  if (TESTED_DSH_VERSIONS.includes(version)) return 'tested';
  const core = String(version).split('-', 1)[0];
  const inRange = compareVersions(version, SUPPORTED_DSH_RANGE.min) >= 0
    && compareVersions(core, SUPPORTED_DSH_RANGE.below) < 0;
  return inRange ? 'compatible' : 'unsupported';
}

/** Locate the running `@deepseek-ai/dsh` package from its CLI entry. */
export function harnessRoot(entry) {
  let dir = dirname(realpathSync(entry));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * One provider's rule:
 * - `mode`: `off` (default), `all` models of the provider, or only `selected` models;
 * - `models`: model ids capped in `selected` mode;
 * - `maxImageEdge`: longest side, in pixels, of every image sent on a capped route.
 */
export function ruleSchema(z) {
  return z.object({
    mode: z.union(['off', 'all', 'selected']).default('off')
      .description('off, all models of this provider, or only the selected models.'),
    models: z.array(z.string()).default([])
      .description('Model ids capped when mode is "selected".'),
    maxImageEdge: z.natural().min(MIN_IMAGE_EDGE).max(MAX_IMAGE_EDGE).default(DEFAULT_MAX_IMAGE_EDGE)
      .description('Longest side, in pixels, of each image sent to a capped model.'),
  });
}

/**
 * This entry's Config. `providers` is volatile: Settings edits it and changes
 * apply to the next request without a restart.
 */
export function createConfig(z) {
  return z.object({
    enabled: z.boolean().description('Set false to load the plugin without capping images.'),
    harnessEntry: z.string().description('Path of the running dsh CLI entry; detected automatically.'),
    allowUntestedHarness: z.boolean().description('Load on a DSH version outside the supported range (not recommended).'),
    providers: z.dict(ruleSchema(z)).default({}).volatile()
      .description('Per-provider image long-edge caps (absent = off).'),
  });
}

function tryHarnessSchemastery(entry) {
  try {
    if (!entry) return undefined;
    const require = createRequire(realpathSync(entry));
    return pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href;
  } catch {
    return undefined;
  }
}

// Build Config with the running harness's own schemastery, never a second
// copy. Outside a harness (plain `node --test`) there is no Config.
const harnessSchemastery = tryHarnessSchemastery(process.argv[1]);
export const Config = harnessSchemastery === undefined
  ? undefined
  : createConfig((await import(harnessSchemastery)).default);

/** Resolve the running dsh version through the CLI entry and gate on it. */
export async function loadRuntime(harnessEntry = process.argv[1], options = {}) {
  if (!harnessEntry) throw new Error(`${LOG_PREFIX} cannot locate the running dsh; set harnessEntry`);
  const root = harnessRoot(harnessEntry);
  const versionStatus = classifyVersion(root?.version);
  if (versionStatus === 'unsupported' && options.allowUntested !== true) {
    throw new Error(`${LOG_PREFIX} dsh ${root.version} is outside the supported range (>= ${SUPPORTED_DSH_RANGE.min} and < ${SUPPORTED_DSH_RANGE.below}); refusing to load. Upgrade dsh-image-edge-cap, or set allowUntestedHarness: true to override.`);
  }
  return { dshVersion: root?.version, versionStatus };
}

/**
 * Per-request scope. `llm/stream` decides the cap for its route and runs every
 * step of the adapter stream inside the scope, so the adapter's
 * `readImageRequest` calls (made while the stream is being consumed) see it.
 */
export function createScope() {
  const storage = new AsyncLocalStorage();
  return {
    current: () => storage.getStore(),
    /** Re-enter `cap` for each step of `iterable`; returns a new async iterable. */
    wrap(cap, iterable) {
      return (async function* scoped() {
        const iterator = storage.run(cap, () => iterable[Symbol.asyncIterator]());
        let finished = false;
        try {
          for (;;) {
            const step = await storage.run(cap, () => iterator.next());
            if (step.done) {
              finished = true;
              return step.value;
            }
            yield step.value;
          }
        } finally {
          if (!finished && typeof iterator.return === 'function') {
            await storage.run(cap, () => iterator.return());
          }
        }
      })();
    },
  };
}

/**
 * Install the capping wrapper on one attachment store instance (the raw
 * object behind Cordis's service proxy).
 * @returns a disposer that restores the store, if still ours.
 */
export function wrapStore(store, scope, onCap = () => {}) {
  const raw = store?.[ORIGINAL] ?? store;
  if (raw === null || typeof raw !== 'object' || typeof raw.readImageRequest !== 'function') return () => {};
  if (raw.readImageRequest[WRAPPED] === true) return () => {};
  const hadOwn = Object.hasOwn(raw, 'readImageRequest');
  const previous = raw.readImageRequest;
  const wrapper = function readImageRequest(ref, target, signal) {
    const cap = scope.current();
    const next = capTarget(ref, target, cap);
    if (next !== target) onCap(ref, target, next, cap);
    return previous.call(this, ref, next, signal);
  };
  Object.defineProperty(wrapper, WRAPPED, { value: true });
  raw.readImageRequest = wrapper;
  return () => {
    if (raw.readImageRequest !== wrapper) return;
    if (hadOwn) raw.readImageRequest = previous;
    else delete raw.readImageRequest;
  };
}

function rulesReader(config) {
  const providers = config.providers;
  if (providers !== null && typeof providers === 'object' && typeof providers.get === 'function') {
    return { kind: 'plugin config (providers)', read: () => providers.get() };
  }
  throw new Error(`${LOG_PREFIX} this dsh offers no volatile plugin Config; refusing to load (DSH ${SUPPORTED_DSH_RANGE.min} or later is required)`);
}

export async function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const runtime = await loadRuntime(config.harnessEntry, { allowUntested: config.allowUntestedHarness === true });
  if (runtime.versionStatus !== 'tested') {
    ctx.logger.warn(`${LOG_PREFIX} dsh ${runtime.dshVersion ?? '(unknown)'} has not been tested with this plugin (tested dsh: ${TESTED_DSH_VERSIONS.join(', ')}); loading anyway`);
  }
  const rules = rulesReader(config);
  const scope = createScope();

  const capOf = (provider, model) => {
    try {
      return capFor(rules.read(), provider, model);
    } catch {
      return undefined;
    }
  };

  ctx.on('llm/stream', (options, next) => {
    const cap = capOf(options?.provider, options?.model);
    // No cap: pass the stream through untouched (byte-identical requests).
    if (cap === undefined) return next();
    return scope.wrap(cap, next());
  });

  // Log each (image, size) once per process; every turn resends old images.
  const logged = new Set();
  const onCap = (ref, from, to, cap) => {
    const key = `${ref?.attachmentId}:${to.width}x${to.height}`;
    if (logged.has(key)) return;
    if (logged.size > 4096) logged.clear();
    logged.add(key);
    ctx.logger.info(`${LOG_PREFIX} capped a request image ${from.width}×${from.height} → ${to.width}×${to.height} (max edge ${cap})`);
  };

  // Follow the attachment store: re-wrap when it is (re)provided, restore on dispose.
  ctx.inject(['attachments'], inner => {
    const restore = wrapStore(inner.attachments, scope, onCap);
    inner.effect(() => restore, 'dsh-image-edge-cap: attachments.readImageRequest wrapper');
  });

  ctx.logger.info(`${LOG_PREFIX} image long-edge caps ready (default off; stored in ${rules.kind}; dsh ${runtime.dshVersion ?? '(unknown)'}); Settings → Image size`);
}
