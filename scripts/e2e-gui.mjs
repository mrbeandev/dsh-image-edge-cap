#!/usr/bin/env node
/**
 * Browser smoke test of the Settings → Image size tab against a running DSH
 * Web (use a disposable DSH_HOME; see LOCAL-SETUP.md). Drives a headless
 * Chrome over the DevTools protocol with Node built-ins only.
 *
 *   DSH_E2E_URL='http://127.0.0.1:18765/?token=…' node scripts/e2e-gui.mjs
 *
 * Optional: CHROME=/path/to/chrome, DSH_E2E_SHOTS=/dir for screenshots,
 * DSH_E2E_PROVIDER=<route> to exercise a save on that provider,
 * DSH_E2E_EXPECT='<route>=<summary text>' to only verify a rule saved earlier
 * (for example after a server restart).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DSH_E2E_URL;
if (!url) {
  console.error('Set DSH_E2E_URL to the dsh web URL printed at startup (including ?token=…).');
  process.exit(2);
}
const chromePath = process.env.CHROME ?? 'google-chrome';
const shots = process.env.DSH_E2E_SHOTS;
const provider = process.env.DSH_E2E_PROVIDER;
const expect = process.env.DSH_E2E_EXPECT;
const profileDir = mkdtempSync(join(tmpdir(), 'iec-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function target() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
};
const send = (method, params = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return res.result?.result?.value;
};
const waitFor = async (expression, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
};
const shot = async name => {
  if (!shots) return;
  const res = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(res.result.data, 'base64'));
};
/** Click the first element whose own text is exactly `label` (buttons, links, tabs). */
const clickText = label => evaluate(`(() => {
  const want = ${JSON.stringify(label)};
  const all = [...document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="option"], li, div, span')];
  const el = all.find(e => e.textContent.trim() === want && e.offsetParent !== null);
  if (!el) return false;
  (el.closest('button, a, [role="tab"], [role="menuitem"], [role="option"]') ?? el).click();
  return true;
})()`);
const clickLabel = label => evaluate(`(() => {
  const el = [...document.querySelectorAll('[aria-label], [title]')].find(e => (e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '').toLowerCase() === ${JSON.stringify(label.toLowerCase())});
  if (!el) return false; el.click(); return true;
})()`);

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  check('DSH Web loads', await waitFor(`document.readyState === 'complete' && document.body.innerText.length > 50`, 30000));

  const loaded = await waitFor(`(window.__DSH_BOOT__ ? JSON.stringify(window.__DSH_BOOT__) : document.documentElement.outerHTML).includes('dsh-image-edge-cap')`, 20000);
  check('client bundle dsh-image-edge-cap is in the boot graph', loaded);

  // A fresh profile shows a one-time welcome dialog; dismiss it.
  await sleep(1000);
  if (await clickText('Continue')) await sleep(800);
  // Open Settings: try the common entry points.
  let opened = await clickLabel('Settings') || await clickText('Settings');
  if (!opened) opened = await evaluate(`(() => { location.hash = '#/settings'; return true; })()`);
  await sleep(1500);
  const tab = await waitFor(`[...document.querySelectorAll('*')].some(e => e.children.length === 0 && e.textContent.trim() === 'Image size')`, 15000);
  check('Settings shows an "Image size" tab', tab);
  await shot('01-settings');

  await clickText('Image size');
  const page = await waitFor(`!!document.querySelector('#dsh-image-edge-cap-title')`, 15000);
  check('Image size page renders its heading', page);
  await sleep(1500);
  await shot('02-image-size');

  const state = await evaluate(`(() => {
    const section = document.querySelector('#dsh-image-edge-cap-title')?.closest('section');
    if (!section) return null;
    const rows = [...section.querySelectorAll('li')].map(li => ({
      name: li.querySelector('label')?.textContent ?? '',
      mode: li.querySelector('select')?.value,
      disabled: li.querySelector('select')?.disabled,
    }));
    return { text: section.innerText, rows };
  })()`);
  check('page lists providers', Boolean(state?.rows?.length), state ? `${state.rows.length} row(s): ${state.rows.map(r => r.name).join(', ')}` : 'no section');
  if (!expect) check('every provider is Off by default', Boolean(state?.rows?.length) && state.rows.every(r => r.mode === 'off'));
  if (expect) {
    const [route, summary] = expect.split('=');
    const kept = await waitFor(`[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(route)}))?.textContent.includes(${JSON.stringify(summary)})`, 15000);
    check(`saved rule for ${route} is still "${summary}"`, kept);
  }
  check('settings are writable (host plugin running)', Boolean(state?.rows?.length) && state.rows.every(r => r.disabled === false), state?.text?.includes('not running') ? 'host plugin not running' : '');
  check('no undefined/NaN/empty labels', Boolean(state) && !/undefined|NaN|\[object/.test(state.text) && state.rows.every(r => r.name.trim() !== ''));

  if (provider && state?.rows?.length) {
    // Choose "Selected models", tick the first model, Apply, then confirm it persisted after reload.
    const setSelect = await evaluate(`(() => {
      const li = [...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)}));
      const select = li?.querySelector('select');
      if (!select) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'selected');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    check(`switch ${provider} to Selected models`, setSelect);
    const models = await waitFor(`[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)}))?.querySelectorAll('input[type=checkbox]').length > 0`, 15000);
    const modelNames = await evaluate(`[...[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)}))?.querySelectorAll('fieldset label') ?? []].map(l => l.textContent)`);
    check('model checklist comes from the live model catalog', models, (modelNames ?? []).join(', '));
    await evaluate(`[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)})).querySelector('input[type=checkbox]').click()`);
    await sleep(300);
    await evaluate(`[...[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)})).querySelectorAll('button')].find(b => b.textContent === 'Apply').click()`);
    const saved = await waitFor(`[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)}))?.textContent.includes('1 model capped at 2000 px')`, 15000);
    check('Apply saves the rule (summary updates)', saved);
    await shot('03-saved');
    const alert = await evaluate(`document.querySelector('section [role=alert]')?.textContent ?? ''`);
    check('no save error shown', alert === '', alert);

    await send('Page.reload');
    await waitFor(`document.readyState === 'complete'`, 30000);
    await sleep(1500);
    (await clickLabel('Settings')) || (await clickText('Settings'));
    await waitFor(`[...document.querySelectorAll('*')].some(e => e.children.length === 0 && e.textContent.trim() === 'Image size')`, 15000);
    await clickText('Image size');
    const persisted = await waitFor(`[...document.querySelectorAll('section li')].find(li => li.textContent.includes(${JSON.stringify(provider)}))?.textContent.includes('1 model capped at 2000 px')`, 15000);
    check('rule persists after reload', persisted);
    await shot('04-after-reload');
  }

  const related = consoleErrors.filter(line => /image-edge-cap|edge-cap/i.test(String(line)));
  check('no console errors from this plugin', related.length === 0, related.slice(0, 3).join(' | '));
  if (consoleErrors.length) console.log(`(other console errors: ${consoleErrors.length})`);
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
