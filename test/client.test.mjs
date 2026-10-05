import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClientPlugin } from '../client/index.mjs';

/** Minimal store with the shape of a config form. */
function store(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { snapshot = next; for (const fn of listeners) fn(); },
  };
}

const REGISTERED = [
  { id: 'a-router', name: 'a-router' },
  { id: 'deepseek-official', name: 'DeepSeek' },
];
const CATALOG = {
  default: { provider: 'a-router', model: 'cc/claude-a' },
  routableProviders: ['a-router', 'deepseek-official'],
  groups: [
    { id: 'a-router', name: 'a-router', models: [
      { id: 'cc/claude-a', name: 'Claude A' },
      { id: 'cc/claude-b', name: 'Claude B' },
      { id: 'cx/gpt-a', name: 'GPT A' },
    ] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  ],
  failures: [],
};

/** Fake React + fake DSH client services (configForms, DSH 0.2.0+). */
function harness({ value = { providers: {} }, form: formState = {}, mutateImpl, remote = {} } = {}) {
  const mirror = store({ view: { writable: true, namespaces: [{ ns: 'include:dsh-image-edge-cap', value }] } });
  mirror.ensure = () => Promise.resolve();
  const form = store({ status: 'ready', value, revision: 4, writable: true, mode: 'host', ...formState });
  const calls = [];
  form.mutate = async (ops, revision) => {
    calls.push({ ops, revision });
    if (mutateImpl) return mutateImpl(ops, revision, form);
    const current = form.getSnapshot();
    const providers = { ...current.value.providers };
    for (const op of ops) {
      if (op.op === 'unset') delete providers[op.path[1]];
      else providers[op.path[1]] = op.value;
    }
    form.set({ ...current, revision: current.revision + 1, value: { providers } });
    return true;
  };
  const events = new Map();
  const services = {
    remote: {
      llm: { listProviders: remote.listProviders ?? (async () => ({ ok: true, value: REGISTERED })) },
      session: { modelCatalog: remote.modelCatalog ?? (async () => ({ ok: true, value: CATALOG })) },
      $on(event, fn) { events.set(event, fn); return () => events.delete(event); },
    },
  };
  const formsRequested = [];
  services.configForms = { describe: () => mirror, get(ns) { formsRequested.push(ns); return form; } };

  let active;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const instance = active, index = instance.cursor++;
      if (!(index in instance.state)) instance.state[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.state[index], next => {
        instance.state[index] = typeof next === 'function' ? next(instance.state[index]) : next;
      }];
    },
    useRef(initial) {
      const instance = active, index = instance.cursor++;
      return instance.state[index] ??= { current: initial };
    },
    useCallback(fn, deps) {
      const instance = active, index = instance.cursor++;
      const previous = instance.state[index];
      if (previous && deps.every((dep, i) => dep === previous.deps[i])) return previous.fn;
      instance.state[index] = { fn, deps };
      return fn;
    },
    useEffect(fn, deps) {
      const instance = active, index = instance.cursor++;
      const previous = instance.state[index];
      const changed = !previous || !deps || deps.some((dep, i) => dep !== previous.deps[i]);
      if (!changed) return;
      instance.state[index] = { deps };
      instance.pendingEffects.push(() => { instance.state[index] = { deps, cleanup: fn() }; });
    },
    useId: () => `id-${active.cursor++}`,
    useSyncExternalStore(subscribe, getSnapshot) {
      const instance = active, index = instance.cursor++;
      if (!(index in instance.state)) instance.state[index] = subscribe(() => { instance.notifications++; });
      return getSnapshot();
    },
  };
  const plugin = createClientPlugin(name => { assert.equal(name, 'react'); return React; });
  const registrations = [];
  const ctx = {
    ...services,
    inject(names, callback) {
      if (names.every(name => name in services)) callback(ctx);
    },
    slots: {
      inject(name, callback) { assert.equal(name, 'settings.section'); callback(); },
      register(options, view) { registrations.push({ options, view }); },
    },
  };
  plugin.apply(ctx);
  function page() {
    const instance = { state: [], cursor: 0, notifications: 0, pendingEffects: [] };
    const children = new Map();
    function expand(node) {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      if (typeof node.type === 'function') {
        const key = node.props.key ?? node.props.row?.route;
        if (!children.has(key)) children.set(key, { state: [], cursor: 0, notifications: 0, pendingEffects: [] });
        const child = children.get(key);
        const outer = active;
        active = child; child.cursor = 0;
        const tree = node.type(node.props);
        for (const effect of child.pendingEffects.splice(0)) effect();
        active = outer;
        return expand(tree);
      }
      return { ...node, children: node.children.map(expand) };
    }
    const { options, view } = registrations[0];
    return {
      render() {
        active = instance; active.cursor = 0;
        const tree = view({ ...options.inject() });
        for (const effect of instance.pendingEffects.splice(0)) effect();
        return expand(tree);
      },
    };
  }
  return { plugin, registrations, page, calls, form, mirror, events, formsRequested };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, predicate))];
}
const rowsOf = tree => nodes(tree, n => n.type === 'li');
const selectOf = row => nodes(row, n => n.type === 'select')[0].props;
const edgeOf = row => nodes(row, n => n.type === 'input' && n.props.type === 'number')[0]?.props;
const checksOf = row => nodes(row, n => n.type === 'input' && n.props.type === 'checkbox').map(n => n.props);
const applyOf = row => nodes(row, n => n.type === 'button' && n.children.includes('Apply'))[0].props;
const textOf = tree => JSON.stringify(tree);
const labels = tree => nodes(tree, n => n.type === 'label' && typeof n.props.htmlFor === 'string' && n.children.length === 1 && typeof n.children[0] === 'string' && n.children[0] !== 'Max edge').map(n => n.children[0]);

async function loaded(h) {
  const p = h.page();
  p.render();
  await flush();
  return p;
}
/** Act on row `index` with `fn(row)`, re-rendering in between like React would. */
function act(p, index, fn) {
  fn(rowsOf(p.render())[index]);
  return rowsOf(p.render())[index];
}
async function apply(p, index) {
  applyOf(rowsOf(p.render())[index]).onClick();
  await flush();
  p.render();
}

test('registers its own Settings tab, independent of other plugins', () => {
  const h = harness();
  assert.deepEqual(h.plugin.inject, ['slots', 'remote', 'remote.llm', 'remote.session']);
  assert.equal(h.registrations.length, 1);
  const { options } = h.registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'dsh-image-edge-cap');
  assert.equal(options.label(), 'Image size');
  assert.doesNotMatch(createClientPlugin.toString(), /provider-card|dsh-rpm|short-tool-ids/);
});

test('uses configForms with the include:dsh-image-edge-cap entry', async () => {
  const h = harness();
  const p = await loaded(h);
  assert.deepEqual(h.formsRequested, ['include:dsh-image-edge-cap']);
  assert.equal(rowsOf(p.render()).length, 2);
});

test('every provider starts Off, with no edge input or model list', async () => {
  const tree = (await loaded(harness())).render();
  assert.equal(nodes(tree, n => n.type === 'h2')[0].children.join(''), 'Image size');
  assert.equal(nodes(tree, n => n.props?.role === 'note').length, 1);
  assert.deepEqual(labels(tree), ['a-router', 'DeepSeek']);
  for (const row of rowsOf(tree)) {
    assert.equal(selectOf(row).value, 'off');
    assert.equal(edgeOf(row), undefined);
    assert.equal(checksOf(row).length, 0);
    assert.equal(applyOf(row).disabled, true, 'Apply is disabled until something changes');
  }
  assert.match(textOf(tree), /Providers \(0 capped\)/);
});

test('All models: writes the whole-provider rule with the default edge', async () => {
  const h = harness();
  const p = await loaded(h);
  act(p, 0, row => selectOf(row).onChange({ currentTarget: { value: 'all' } }));
  assert.equal(edgeOf(rowsOf(p.render())[0]).value, '2000');
  await apply(p, 0);
  assert.deepEqual(h.calls, [{ ops: [{ op: 'set', path: ['providers', 'a-router'], value: { mode: 'all', models: [], maxImageEdge: 2000 } }], revision: 4 }]);
  assert.match(textOf(p.render()), /all models capped at 2000 px/);
  assert.match(textOf(p.render()), /Providers \(1 capped\)/);
});

test('Selected models: lists the provider models as checkboxes and saves only the chosen ones', async () => {
  const h = harness();
  const p = await loaded(h);
  let row = act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'selected' } }));
  assert.equal(checksOf(row).length, 3);
  assert.ok(checksOf(row).every(c => c.checked === false));
  act(p, 0, r => checksOf(r)[1].onChange());
  row = act(p, 0, r => checksOf(r)[0].onChange());
  act(p, 0, r => edgeOf(r).onChange({ currentTarget: { value: '1568' } }));
  await apply(p, 0);
  assert.deepEqual(h.calls[0].ops, [{ op: 'set', path: ['providers', 'a-router'], value: {
    mode: 'selected', models: ['cc/claude-a', 'cc/claude-b'], maxImageEdge: 1568,
  } }]);
  row = rowsOf(p.render())[0];
  assert.deepEqual(checksOf(row).map(c => c.checked), [true, true, false]);
  assert.match(textOf(row), /2 models capped at 1568 px/);
});

test('Selected with no model checked is refused without a write', async () => {
  const h = harness();
  const p = await loaded(h);
  act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'selected' } }));
  await apply(p, 0);
  assert.equal(h.calls.length, 0);
  assert.match(textOf(p.render()), /Select at least one model/);
});

test('saved rules restore: mode, edge and checked models', async () => {
  const value = { providers: { 'a-router': { mode: 'selected', models: ['cx/gpt-a'], maxImageEdge: 1800 } } };
  const row = rowsOf((await loaded(harness({ value }))).render())[0];
  assert.equal(selectOf(row).value, 'selected');
  assert.equal(edgeOf(row).value, '1800');
  assert.deepEqual(checksOf(row).map(c => c.checked), [false, false, true]);
});

test('Off removes the provider rule', async () => {
  const h = harness({ value: { providers: { 'a-router': { mode: 'all', models: [], maxImageEdge: 2000 } } } });
  const p = await loaded(h);
  act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'off' } }));
  await apply(p, 0);
  assert.deepEqual(h.calls, [{ ops: [{ op: 'unset', path: ['providers', 'a-router'] }], revision: 4 }]);
  assert.equal(selectOf(rowsOf(p.render())[0]).value, 'off');
});

test('invalid edges are refused without a write', async () => {
  for (const value of ['0', '15', '16385', '1.5', 'abc', '-5']) {
    const h = harness();
    const p = await loaded(h);
    act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'all' } }));
    act(p, 0, r => edgeOf(r).onChange({ currentTarget: { value } }));
    await apply(p, 0);
    assert.equal(h.calls.length, 0, value);
    assert.match(textOf(p.render()), /whole number of pixels from 16 to 16384/);
  }
});

test('a selected model the catalog no longer lists stays visible so it can be cleared', async () => {
  const value = { providers: { 'a-router': { mode: 'selected', models: ['cc/retired-model'], maxImageEdge: 2000 } } };
  const row = rowsOf((await loaded(harness({ value }))).render())[0];
  assert.equal(checksOf(row).length, 4);
  assert.equal(checksOf(row)[3].checked, true);
  assert.match(textOf(row), /cc\/retired-model \(no longer listed\)/);
});

test('a configured provider that no longer exists stays listed', async () => {
  const tree = (await loaded(harness({ value: { providers: { gone: { mode: 'all', models: [], maxImageEdge: 2000 } } } }))).render();
  assert.ok(labels(tree).includes('gone'));
  assert.match(textOf(tree), /no longer configured/);
});

test('model catalog failure: explains, offers Retry, whole-provider mode still works', async () => {
  let fail = true;
  const h = harness({ remote: { modelCatalog: async () => (fail ? { ok: false, error: { code: 'x', message: 'SECRET' } } : { ok: true, value: CATALOG }) } });
  const p = await loaded(h);
  let tree = p.render();
  assert.match(textOf(tree), /Could not load the model list/);
  assert.doesNotMatch(textOf(tree), /SECRET/);
  const row = act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'selected' } }));
  assert.match(textOf(row), /Could not load this provider’s models/);
  fail = false;
  nodes(p.render(), n => n.type === 'button' && n.children.includes('Retry'))[0].props.onClick();
  await flush();
  tree = p.render();
  assert.equal(checksOf(rowsOf(tree)[0]).length, 3);
});

test('loading, unavailable, read-only and memory states cannot write', async () => {
  for (const state of [{ status: 'loading' }, { status: 'unavailable' }, { writable: false }, { mode: 'memory' }]) {
    const h = harness({ form: state });
    const p = await loaded(h);
    assert.ok(rowsOf(p.render()).every(row => selectOf(row).disabled), JSON.stringify(state));
    act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'all' } }));
    await apply(p, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('host plugin not running: explains why instead of failing silently', async () => {
  const h = harness();
  h.mirror.set({ view: { writable: true, namespaces: [] } });
  const tree = (await loaded(h)).render();
  assert.match(textOf(tree), /dsh-image-edge-cap host plugin is not running/);
  assert.ok(rowsOf(tree).every(row => selectOf(row).disabled));
});

test('failure shows a safe error only; refused write that settles is detected', async () => {
  const h = harness({ mutateImpl: async () => { throw new Error('SECRET_CONFIGURATION_DETAILS'); } });
  const p = await loaded(h);
  act(p, 0, r => selectOf(r).onChange({ currentTarget: { value: 'all' } }));
  await apply(p, 0);
  let tree = p.render();
  assert.equal(nodes(tree, n => n.props?.role === 'alert').length, 1);
  assert.doesNotMatch(textOf(tree), /SECRET_CONFIGURATION_DETAILS/);

  const quiet = harness({ mutateImpl: async () => false });
  const q = await loaded(quiet);
  act(q, 0, r => selectOf(r).onChange({ currentTarget: { value: 'all' } }));
  await apply(q, 0);
  tree = q.render();
  assert.equal(nodes(tree, n => n.props?.role === 'alert').length, 1);
});

test('provider list failure offers a retry; empty list explains what to do', async () => {
  let fail = true;
  const h = harness({ remote: { listProviders: async () => (fail ? { ok: false, error: { message: 'x' } } : { ok: true, value: [] }) } });
  const p = await loaded(h);
  let tree = p.render();
  assert.match(textOf(tree), /Could not load the provider list/);
  fail = false;
  nodes(tree, n => n.type === 'button' && n.children.includes('Retry'))[0].props.onClick();
  await flush();
  tree = p.render();
  assert.match(textOf(tree), /No model providers are configured yet/);
});

test('provider changes pushed by the host refresh the list', async () => {
  let list = REGISTERED.slice(0, 1);
  const h = harness({ remote: { listProviders: async () => ({ ok: true, value: list }) } });
  const p = await loaded(h);
  assert.equal(rowsOf(p.render()).length, 1);
  list = REGISTERED;
  h.events.get('llm/adapters-updated')();
  await flush();
  assert.equal(rowsOf(p.render()).length, 2);
});

test('pure helpers ignore malformed data', () => {
  const { buildRows, findEntryNamespace, normalizeRule, draftToOp } = createClientPlugin(() => ({}));
  assert.equal(buildRows({ registered: null, groups: null, rules: null }).length, 0);
  const rows = buildRows({
    registered: [{ id: 'cc', name: 'a-router' }, { id: '' }, null, { id: 7 }],
    groups: [{ id: 'cc', models: [{ id: 'm1' }, null, { id: '' }] }, { id: 5 }],
    rules: { weird: { mode: 'selected', models: [] }, bad: 'x', cc: { mode: 'all' } },
  });
  assert.deepEqual(rows.map(r => r.route), ['cc']);
  assert.deepEqual(rows[0].models, [{ id: 'm1', name: 'm1' }]);
  assert.deepEqual(normalizeRule({ mode: 'all', maxImageEdge: 9 }), { mode: 'all', models: [], maxImageEdge: 2000 });
  assert.deepEqual(normalizeRule('x'), { mode: 'off', models: [], maxImageEdge: 2000 });
  assert.equal(draftToOp('cc', { mode: 'all', edge: '', models: [] }).op.value.maxImageEdge, 2000);
  const ns = (...ids) => ids.map(id => ({ ns: id }));
  assert.equal(findEntryNamespace(ns('llm-deepseek', 'include:dsh-image-edge-cap')), 'include:dsh-image-edge-cap');
  assert.equal(findEntryNamespace(ns('group:x:dsh-image-edge-cap')), 'group:x:dsh-image-edge-cap');
  assert.equal(findEntryNamespace(null), undefined);
});

test('the generated bundle registers through the module loader and matches the source', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let registered;
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load: entry => { registered = entry; } } } });
  assert.equal(registered.id, 'dsh-image-edge-cap');
  assert.equal(registered.factory.toString(), createClientPlugin.toString(), 'lib/client.js is stale; run npm run build');
});
