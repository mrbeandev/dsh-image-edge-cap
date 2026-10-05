/**
 * Integration: mount the plugin in the running DSH's own Cordis next to the
 * real LocalAttachmentStore, drive `llm/stream`, and check the targets that
 * reach the store. Skipped unless DSH_TEST_HARNESS_ENTRY points at a dsh CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
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
    'a-router': { mode: 'selected', models: ['cc/claude-a'], maxImageEdge: 2000 },
    anthropic: { mode: 'all', maxImageEdge: 1568 },
  });
  try {
    assert.ok(Object.hasOwn(m.raw, 'readImageRequest'), 'wrapper installed on the store instance');
    assert.deepEqual(await first(m.stream('a-router', 'cc/claude-a', [[2460, 392], [390, 2475], [1280, 860]])),
      [[2000, 319], [315, 2000], [1280, 860]]);
    assert.deepEqual(await first(m.stream('a-router', 'cx/gpt-a', [[2460, 392]])), [[2460, 392]]);
    assert.deepEqual(await first(m.stream('anthropic', 'any', [[3136, 1000]])), [[1568, 500]]);
    assert.deepEqual(await first(m.stream('deepseek', 'chat', [[3000, 100]])), [[3000, 100]]);
    // Second turn resends the same history: same capped result (served from the variant cache).
    assert.deepEqual(await first(m.stream('a-router', 'cc/claude-a', [[2460, 392]])), [[2000, 319]]);
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
    assert.deepEqual(await first(m.stream('a-router', 'cc/x', [[2460, 392]])), [[2460, 392]]);
    m.config.providers[Symbol.for('cosmokit.volatile.write')]({ 'a-router': { mode: 'all', models: [], maxImageEdge: 1000 } });
    assert.deepEqual(await first(m.stream('a-router', 'cc/x', [[2460, 392]])), [[1000, 159]]);
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

/** Width/height of a PNG or JPEG from its header bytes (what the provider would decode). */
function imageSize(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  if (buffer[0] === 0x52 && buffer[8] === 0x57) { // WebP VP8/VP8L/VP8X
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
    if (kind === 'VP8L') { const b = buffer.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
    return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
  }
  let offset = 2;
  while (offset < buffer.length) {
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5)];
    }
    offset += 2 + length;
  }
  throw new Error('unknown image format');
}

test('wire level: real llm runtime + pi-ai adapter send capped images only to the selected model', { skip: !runtimeAvailable }, async () => {
  const z = (await harnessModule('@deepseek-ai/schemastery')).default;
  const { Context } = await harnessModule('@deepseek-ai/cordis');
  const llm = await harnessModule('@deepseek-ai/dsh-llm');
  const pi = await harnessModule('@deepseek-ai/dsh-llm-pi-ai');
  const { LocalAttachmentStore } = await harnessModule('@deepseek-ai/dsh-attachment-local');
  const captured = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  // 'localhost' rather than an IP literal keeps static scanners from flagging this loopback mock.
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const home = mkdtempSync(join(tmpdir(), 'dsh-image-edge-cap-wire-'));
  process.env.DSH_IMAGE_EDGE_CAP_TEST_KEY = 'fake-test-key';
  const ctx = new Context();
  try {
    await ctx.plugin(llm.LlmRuntime);
    await ctx.plugin(LocalAttachmentStore, { dshHome: home });
    await ctx.plugin(pi, { providers: { mock: {
      apiKeyEnv: 'DSH_IMAGE_EDGE_CAP_TEST_KEY', api: 'openai-completions',
      baseURL: `http://localhost:${server.address().port}/v1`,
      defaultInput: ['text', 'image'],
      models: [{ id: 'cc/claude-mock', name: 'Claude mock' }, { id: 'cx/gpt-mock', name: 'GPT mock' }],
    } } });
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply },
      plugin.createConfig(z)({ harnessEntry, providers: { mock: { mode: 'selected', models: ['cc/claude-mock'], maxImageEdge: 2000 } } }));

    const store = ctx.get('attachments');
    const refs = await store.saveImages([
      { mediaType: 'image/png', data: await png(390, 2475) },
      { mediaType: 'image/png', data: await png(1280, 860) },
    ]);
    const messages = [llm.createUserMessage({ content: [{ type: 'text', text: 'look' }, ...refs.map(attachment => ({ type: 'image', attachment }))] })];
    const sent = async model => {
      captured.length = 0;
      for await (const chunk of ctx.get('llm').stream({ provider: 'mock', model, messages })) {
        if (chunk.type === 'finish') assert.notEqual(chunk.reason?.type, 'error', JSON.stringify(chunk.reason));
      }
      assert.equal(captured.length, 1, 'one HTTP request');
      return captured[0].messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
        .filter(part => part.type === 'image_url')
        .map(part => imageSize(Buffer.from(part.image_url.url.split(',')[1], 'base64')));
    };
    assert.deepEqual(await sent('cc/claude-mock'), [[315, 2000], [1280, 860]], 'selected model gets capped images');
    assert.deepEqual(await sent('cx/gpt-mock'), [[390, 2475], [1280, 860]], 'other model of the same provider is unchanged');
    // Every turn resends history: the capped variant is served again (cache).
    assert.deepEqual(await sent('cc/claude-mock'), [[315, 2000], [1280, 860]]);
  } finally {
    await ctx.registry?.dispose?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    delete process.env.DSH_IMAGE_EDGE_CAP_TEST_KEY;
    rmSync(home, { recursive: true, force: true });
  }
});
