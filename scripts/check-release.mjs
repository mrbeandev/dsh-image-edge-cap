#!/usr/bin/env node
/**
 * Release gate: run by `prepublishOnly` and `npm run verify`.
 *
 * Checks package metadata, that the generated client bundle matches its
 * source, that every module parses, that no forbidden mechanism or private
 * detail crept in, and that the packed file list holds every runtime file and
 * nothing private (session logs, credentials, caches, the local design brief).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const NAME = 'dsh-image-edge-cap';

// ── metadata ────────────────────────────────────────────────────────────────
check(pkg.name === NAME, `package name must be ${NAME}`);
check(pkg.license === 'MIT', 'license must be MIT');
check(pkg.repository?.url === `git+https://github.com/mrbeandev/${NAME}.git`, 'repository URL must point to the public repository');
check(pkg.homepage?.startsWith(`https://github.com/mrbeandev/${NAME}`), 'homepage must point to the public repository');
check(pkg.bugs?.url === `https://github.com/mrbeandev/${NAME}/issues`, 'bugs URL must point to the public repository');
check(pkg.type === 'module', 'package must be ESM');
check(pkg.exports?.['.'] === './index.mjs' && pkg.exports?.['./client'] === './lib/client.js', 'exports must expose ./index.mjs and ./client');
check(pkg.publishConfig?.access === 'public', 'publishConfig.access must be public');
check(pkg.engines?.node !== undefined, 'engines.node is required');
check(pkg.author !== undefined, 'author is required');
check(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, 'runtime dependencies are not allowed; harness packages come from the running dsh');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml');
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web');
for (const injected of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-session-controller']) {
  check(pkg.dsh?.client?.inject?.includes(injected), `dsh.client.inject must include ${injected} (the Settings tab uses it)`);
}

const { SUPPORTED_DSH_RANGE } = await import(pathToFileURL(join(root, 'index.mjs')).href);
const range = `>=${SUPPORTED_DSH_RANGE.min} <${SUPPORTED_DSH_RANGE.below}`;
check(pkg.peerDependencies?.['@deepseek-ai/dsh'] === range, `peerDependencies["@deepseek-ai/dsh"] must be "${range}"`);
check(pkg.dsh?.engines?.dsh === range, `dsh.engines.dsh must be "${range}"`);

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
check(/id: dsh-image-edge-cap\n\s+name: dsh-image-edge-cap/.test(patch), 'cordis.patch.yml must insert entry id/name dsh-image-edge-cap');

for (const doc of ['README.md', 'RELEASE.md', 'LOCAL-SETUP.md']) {
  const text = readFileSync(join(root, doc), 'utf8');
  if (/\/home\/[a-z]|\/mnt\/main_disk|\/Users\/[A-Za-z]/.test(text)) problems.push(`${doc}: contains an absolute user path`);
  if (!text.includes(NAME)) problems.push(`${doc}: does not mention ${NAME}`);
}

// ── generated client bundle is current ──────────────────────────────────────
const { createClientPlugin } = await import(pathToFileURL(join(root, 'client/index.mjs')).href);
const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(bundle.includes(`id: '${NAME}'`), `lib/client.js must register id ${NAME}`);
check(bundle.includes(createClientPlugin.toString()), 'lib/client.js is stale: run npm run build');

// ── forbidden mechanisms and private details in source ──────────────────────
const listed = dir => readdirSync(join(root, dir)).filter(file => file.endsWith('.mjs')).map(file => `${dir}/${file}`);
const sources = ['index.mjs', 'cap.mjs', 'client/index.mjs', ...listed('scripts'), ...listed('test')];
// Runtime code (what DSH loads) must make no network requests at all.
const runtime = new Set(['index.mjs', 'cap.mjs', 'client/index.mjs']);
for (const file of sources) {
  const text = readFileSync(join(root, file), 'utf8');
  if (/\/home\/[a-z]|\/mnt\/main_disk|\/Users\/[A-Za-z]|C:\\\\Users/.test(text)) problems.push(`${file}: contains an absolute user path`);
  if (/session-[0-9a-f]{8}-[0-9a-f]{4}|req_[0-9A-Za-z]{16,}/.test(text)) problems.push(`${file}: contains a real session or request id`);
  // The gate's own pattern list would match itself.
  if (file !== 'scripts/check-release.mjs') {
    check(!/\beval\s*\(|new Function\s*\(/.test(text), `${file}: no dynamic code evaluation`);
    check(!/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(text), `${file}: the Settings tab renders text only`);
  }
  // Tests name other plugins on purpose (to assert their absence); runtime code must not.
  if (runtime.has(file)) check(!/dsh-rpm|short-tool-ids/.test(text), `${file}: must not depend on or reference other community plugins`);
  if (runtime.has(file)) check(!/\bfetch\s*\(|node:https?['"]|XMLHttpRequest|WebSocket/.test(text), `${file}: runtime code must make no network requests`);
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file}: syntax error: ${error.stderr?.toString().trim()}`);
  }
}

// ── packed file list ────────────────────────────────────────────────────────
let packed = [];
try {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packed = JSON.parse(output)[0].files.map(file => file.path);
} catch (error) {
  problems.push(`npm pack --dry-run failed: ${error.message}`);
}
if (packed.length > 0) {
  const required = ['index.mjs', 'cap.mjs', 'client/index.mjs', 'lib/client.js', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml'];
  for (const file of required) check(packed.includes(file), `packed artifact is missing ${file}`);
  const forbidden = /\.(zstd|jsonl|tgz|log|png)$|(^|\/)(fixtures|\.private|\.env|\.cache|\.e2e)(\/|$)|\.npmrc$|(^|\/)INFO\.md$|LOCAL-SETUP\.md$/;
  for (const file of packed) check(!forbidden.test(file), `packed artifact must not contain ${file}`);
}

if (problems.length > 0) {
  console.error(`${NAME} release check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`${NAME} release check passed (${packed.length} files packed).`);
