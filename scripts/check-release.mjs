import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const missing = [];
if (!pkg.license || pkg.license === 'UNLICENSED') missing.push('a distribution license');
if (!pkg.repository) missing.push('the real repository URL');
if (missing.length) {
  console.error(`Publication is intentionally gated: supply ${missing.join(' and ')} first. See RELEASE.md.`);
  process.exit(1);
}
