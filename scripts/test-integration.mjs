import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = process.env.DSH_TEST_HARNESS_ENTRY;
if (!entry || !existsSync(entry)) {
  console.error('Set DSH_TEST_HARNESS_ENTRY to the installed dsh CLI entry before integration tests.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', 'test/plugin.test.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
