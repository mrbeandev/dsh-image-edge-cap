import test from 'node:test';
import assert from 'node:assert/strict';
import { capFor, capTarget, longEdgeDimensions, DEFAULT_MAX_IMAGE_EDGE } from '../cap.mjs';
import { createScope, wrapStore } from '../index.mjs';

const target = (width, height, maxBytes = 1048576) => ({ width, height, maxBytes });
const ref = (width, height) => ({ attachmentId: `a-${width}x${height}`, width, height });

test('brief cases: 2460×392 → 2000×319 (sharp rounding), 390×2475 → 315×2000', () => {
  // The brief's "2000×318" floors; dsh-attachment-local resizes by the long
  // edge and sharp rounds the short edge (verified: 2460×392 → 2000×319).
  assert.deepEqual(capTarget(ref(2460, 392), target(2460, 392), 2000), target(2000, 319));
  assert.deepEqual(capTarget(ref(390, 2475), target(390, 2475), 2000), target(315, 2000));
});

test('targets within the cap pass through with the same identity', () => {
  const t = target(1280, 860);
  assert.equal(capTarget(ref(1280, 860), t, 2000), t);
  const square = target(2000, 2000);
  assert.equal(capTarget(ref(2000, 2000), square, 2000), square);
});

test('no cap (disabled) returns the exact target object', () => {
  const t = target(2460, 392);
  assert.equal(capTarget(ref(2460, 392), t, undefined), t);
});

test('pixel budget already applied: cap keeps the smaller budget size', () => {
  // 2718×1346 → 1524×755 under 1.15 MP: already under 2000, unchanged.
  const t = target(1524, 755);
  assert.equal(capTarget(ref(2718, 1346), t, 2000), t);
  // Budget target still over the cap: shrink from the source ratio.
  assert.deepEqual(capTarget(ref(4000, 400), target(3390, 339), 2000), target(2000, 200));
});

test('maxBytes and other target fields are preserved', () => {
  const out = capTarget(ref(3000, 1000), { width: 3000, height: 1000, maxBytes: 77, extra: 'x' }, 1500);
  assert.deepEqual(out, { width: 1500, height: 500, maxBytes: 77, extra: 'x' });
});

test('malformed targets and refs are passed through or handled', () => {
  assert.equal(capTarget(ref(1, 1), null, 2000), null);
  const bad = { width: 'x', height: 10, maxBytes: 1 };
  assert.equal(capTarget(ref(1, 1), bad, 2000), bad);
  assert.deepEqual(capTarget({}, target(4000, 1000), 2000), target(2000, 500));
});

test('longEdgeDimensions never returns a zero side', () => {
  assert.deepEqual(longEdgeDimensions(100000, 1, 2000), { width: 2000, height: 1 });
  assert.deepEqual(longEdgeDimensions(1, 100000, 2000), { width: 1, height: 2000 });
});

test('capFor: off, all, selected models', () => {
  const rules = {
    'a-router': { mode: 'selected', models: ['cc/claude-a', 'cc/claude-b'], maxImageEdge: 2000 },
    anthropic: { mode: 'all', models: [], maxImageEdge: 1568 },
    deepseek: { mode: 'off', models: ['x'], maxImageEdge: 1000 },
  };
  assert.equal(capFor(rules, 'a-router', 'cc/claude-a'), 2000);
  assert.equal(capFor(rules, 'a-router', 'cx/gpt-a'), undefined, 'unselected model of a selected provider');
  assert.equal(capFor(rules, 'anthropic', 'anything'), 1568);
  assert.equal(capFor(rules, 'anthropic', undefined), 1568);
  assert.equal(capFor(rules, 'deepseek', 'x'), undefined);
  assert.equal(capFor(rules, 'unknown', 'x'), undefined);
});

test('capFor: defaults and malformed rules', () => {
  assert.equal(capFor({ p: { mode: 'all' } }, 'p', 'm'), DEFAULT_MAX_IMAGE_EDGE);
  assert.equal(capFor({ p: { mode: 'all', maxImageEdge: 0 } }, 'p', 'm'), undefined);
  assert.equal(capFor({ p: { mode: 'all', maxImageEdge: 1.5 } }, 'p', 'm'), undefined);
  assert.equal(capFor({ p: { mode: 'selected', models: 'm' } }, 'p', 'm'), undefined);
  assert.equal(capFor({ p: { mode: 'weird' } }, 'p', 'm'), undefined);
  assert.equal(capFor({ p: null }, 'p', 'm'), undefined);
  assert.equal(capFor(null, 'p', 'm'), undefined);
  assert.equal(capFor({ ['__proto__']: { mode: 'all' } }, 'toString', 'm'), undefined);
});

/** Fake store that records the targets it receives. */
function fakeStore() {
  const seen = [];
  return {
    seen,
    async readImageRequest(r, t) {
      await new Promise(resolve => setTimeout(resolve, 1));
      seen.push(t);
      return { width: t.width, height: t.height };
    },
  };
}

/** An adapter-like stream that reads images lazily, while being consumed. */
function adapterStream(store, images) {
  return (async function* () {
    await new Promise(resolve => setTimeout(resolve, 1));
    const prepared = await Promise.all(images.map(([w, h]) => store.readImageRequest(ref(w, h), target(w, h))));
    yield { type: 'images', prepared };
    yield { type: 'finish' };
  })();
}

async function drain(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

test('scope reaches readImageRequest calls made while the stream is consumed', async () => {
  const store = fakeStore();
  const scope = createScope();
  const restore = wrapStore(store, scope);
  const capped = scope.wrap(2000, adapterStream(store, [[2460, 392], [1280, 860]]));
  const plain = adapterStream(store, [[2460, 392]]);
  // Interleave: a capped request and an uncapped one at the same time.
  const [a, b] = await Promise.all([drain(capped), drain(plain)]);
  assert.deepEqual(a[0].prepared, [{ width: 2000, height: 319 }, { width: 1280, height: 860 }]);
  assert.deepEqual(b[0].prepared, [{ width: 2460, height: 392 }]);
  restore();
});

test('an outer llm/stream listener (e.g. a rate limiter) does not lose the scope', async () => {
  const store = fakeStore();
  const scope = createScope();
  wrapStore(store, scope);
  const outer = next => (async function* gated() {
    await new Promise(resolve => setTimeout(resolve, 2));
    yield* next();
  })();
  const out = await drain(outer(() => scope.wrap(1000, adapterStream(store, [[390, 2475]]))));
  assert.deepEqual(out[0].prepared, [{ width: 158, height: 1000 }]);
});

test('early consumer exit closes the inner stream inside the scope', async () => {
  const scope = createScope();
  let closedIn;
  const inner = (async function* () {
    try { yield 1; yield 2; } finally { closedIn = scope.current(); }
  })();
  for await (const value of scope.wrap(500, inner)) { assert.equal(value, 1); break; }
  assert.equal(closedIn, 500);
});

test('wrapStore restores the original method and is idempotent', async () => {
  const store = fakeStore();
  const original = store.readImageRequest;
  const scope = createScope();
  const restore = wrapStore(store, scope);
  assert.notEqual(store.readImageRequest, original);
  const again = wrapStore(store, scope);
  again();
  assert.notEqual(store.readImageRequest, original, 'second wrap is a no-op and must not unwrap');
  restore();
  assert.equal(store.readImageRequest, original);
  assert.equal(Object.hasOwn(store, 'readImageRequest'), true);
});

test('wrapStore on a prototype method deletes its own property on restore', () => {
  class Store { readImageRequest() { return 'proto'; } }
  const store = new Store();
  const restore = wrapStore(store, createScope());
  assert.equal(Object.hasOwn(store, 'readImageRequest'), true);
  restore();
  assert.equal(Object.hasOwn(store, 'readImageRequest'), false);
  assert.equal(store.readImageRequest(), 'proto');
});

test('wrapStore unwraps a Cordis proxy through cordis.original', () => {
  const raw = fakeStore();
  const proxy = new Proxy(raw, { get: (t, p) => (p === Symbol.for('cordis.original') ? t : Reflect.get(t, p)) });
  const restore = wrapStore(proxy, createScope());
  assert.equal(Object.hasOwn(raw, 'readImageRequest'), true);
  restore();
});

test('wrapStore ignores stores without readImageRequest', () => {
  assert.doesNotThrow(() => wrapStore(undefined, createScope())());
  assert.doesNotThrow(() => wrapStore({}, createScope())());
});

test('onCap reports only real changes', async () => {
  const store = fakeStore();
  const scope = createScope();
  const events = [];
  wrapStore(store, scope, (r, from, to, cap) => events.push([from.width, to.width, cap]));
  await drain(scope.wrap(2000, adapterStream(store, [[2460, 392], [100, 100]])));
  assert.deepEqual(events, [[2460, 2000, 2000]]);
});
