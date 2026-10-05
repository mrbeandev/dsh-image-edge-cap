/**
 * Integration: mount the plugin in the running DSH's own Cordis next to the
 * real LocalAttachmentStore, drive `llm/stream`, and check the targets that
 * reach the store. Skipped unless DSH_TEST_HARNESS_ENTRY points at a dsh CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.mjs';

const harnessEntry = process.env.DSH_TEST_HARNESS_ENTRY;
const runtimeAvailable = Boolean(harnessEntry && existsSync(harnessEntry));

async function harnessModule(specifier) {
  const require = createRequire(realpathSync(harnessEntry));
  return import(pathToFileURL(require.resolve(specifier)).href);
}

async function png(width, height) {
  const require = createRequire(realpathSync(harnessEntry));
  const sharp = require(createRequire(require.resolve('@deepseek-ai/dsh-attachment-local')).resolve('sharp'));
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#4080c0' } }).png().toBuffer());
}

async function mount(rules) {
  const z = (await harnessModule('@deepseek-ai/schemastery')).default;
  const { Context } = await harnessModule('@deepseek-ai/cordis');
  const { LocalAttachmentStore } = await harnessModule('@deepseek-ai/dsh-attachment-local');
  const home = mkdtempSync(join(tmpdir(), 'dsh-image-edge-cap-'));
  const ctx = new Context();
  // `llm` is only an inject requirement; a stub service satisfies it.
  ctx.provide('llm', {});
  ctx.set('llm', {});
  const logs = [];
  ctx.logger.exporter({ export: message => logs.push(String(message.content ?? message.args?.join(' ') ?? '')) });
  await ctx.plugin(LocalAttachmentStore, { dshHome: home });
  const config = plugin.createConfig(z)({ harnessEntry, providers: rules });
  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config);
  await fiber;
  const raw = ctx.get('attachments')[Symbol.for('cordis.original')];
  const refs = new Map();
  const refOf = async (w, h) => {
    const key = `${w}x${h}`;
    if (!refs.has(key)) {
      const [ref] = await ctx.get('attachments').saveImages([{ mediaType: 'image/png', data: await png(w, h) }]);
      refs.set(key, ref);
    }
    return refs.get(key);
  };
  // Mimic the pi-ai adapter: the target is the source size under a generous
  // pixel budget, and images are read while the stream is being consumed.
  const stream = (provider, model, images) => ctx.waterfall(ctx, 'llm/stream', { provider, model }, () => (async function* adapter() {
    await new Promise(resolve => setTimeout(resolve, 1));
    const store = ctx.get('attachments');
    const out = await Promise.all(images.map(async ([w, h]) => {
      const ref = await refOf(w, h);
      const version = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 });
      return [version.width, version.height];
    }));
    yield out;
  })());
  return {
    ctx, logs, raw, config, stream,
    async dispose() {
      await fiber.dispose?.();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function first(iterable) {
  for await (const value of iterable) return value;
}

test('real Cordis + LocalAttachmentStore: caps only the chosen provider/models', { skip: !runtimeAvailable }, async () => {
  const m = await mount({
    '9router': { mode: 'selected', models: ['cc/claude-opus-5-5'], maxImageEdge: 2000 },
    anthropic: { mode: 'all', maxImageEdge: 1568 },
  });
  try {
    assert.ok(Object.hasOwn(m.raw, 'readImageRequest'), 'wrapper installed on the store instance');
    assert.deepEqual(await first(m.stream('9router', 'cc/claude-opus-5-5', [[2460, 392], [390, 2475], [1280, 860]])),
      [[2000, 319], [315, 2000], [1280, 860]]);
    assert.deepEqual(await first(m.stream('9router', 'cx/gpt-6-sol', [[2460, 392]])), [[2460, 392]]);
    assert.deepEqual(await first(m.stream('anthropic', 'any', [[3136, 1000]])), [[1568, 500]]);
    assert.deepEqual(await first(m.stream('deepseek', 'chat', [[3000, 100]])), [[3000, 100]]);
    // Second turn resends the same history: same capped result (served from the variant cache).
    assert.deepEqual(await first(m.stream('9router', 'cc/claude-opus-5-5', [[2460, 392]])), [[2000, 319]]);
    assert.ok(m.logs.some(line => /capped a request image 2460×392 → 2000×319/.test(line)), JSON.stringify(m.logs));
    // Disposal restores the store.
    await m.dispose();
    assert.equal(Object.hasOwn(m.raw, 'readImageRequest'), false, 'wrapper removed on dispose');
  } finally {
    await m.dispose();
  }
});

test('settings saved live apply to the next request', { skip: !runtimeAvailable }, async () => {
  const m = await mount({});
  try {
    assert.deepEqual(await first(m.stream('9router', 'cc/x', [[2460, 392]])), [[2460, 392]]);
    m.config.providers[Symbol.for('cosmokit.volatile.write')]({ '9router': { mode: 'all', models: [], maxImageEdge: 1000 } });
    assert.deepEqual(await first(m.stream('9router', 'cc/x', [[2460, 392]])), [[1000, 159]]);
  } finally {
    await m.dispose();
  }
});

test('Config rejects malformed rules', { skip: !runtimeAvailable }, async () => {
  const z = (await harnessModule('@deepseek-ai/schemastery')).default;
  const Config = plugin.createConfig(z);
  assert.deepEqual(Config({ providers: { p: {} } }).providers.get(), { p: { mode: 'off', models: [], maxImageEdge: 2000 } });
  for (const bad of [{ mode: 'x' }, { maxImageEdge: 0 }, { maxImageEdge: 20000 }, { maxImageEdge: 1.5 }, { models: 'm' }]) {
    assert.throws(() => Config({ providers: { p: bad } }), JSON.stringify(bad));
  }
});
