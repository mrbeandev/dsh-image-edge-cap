import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, classifyVersion, SUPPORTED_DSH_RANGE, TESTED_DSH_VERSIONS } from '../index.mjs';

test('compareVersions orders cores and prereleases', () => {
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0-rc.2'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.3'), 1);
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0-rc.1'), 0);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
});

test('classifyVersion: tested releases are exact', () => {
  for (const v of TESTED_DSH_VERSIONS) assert.equal(classifyVersion(v), 'tested');
});

test('classifyVersion: untested in-range releases load with a warning', () => {
  assert.equal(classifyVersion('0.2.1-alpha.1'), 'compatible');
  assert.equal(classifyVersion('0.2.1'), 'compatible');
});

test('classifyVersion: out-of-range releases are refused', () => {
  assert.equal(classifyVersion('0.1.7'), 'unsupported');
  assert.equal(classifyVersion('0.2.0-beta.1'), 'unsupported');
  assert.equal(classifyVersion('0.3.0'), 'unsupported');
  assert.equal(classifyVersion('0.3.0-alpha.1'), 'unsupported');
  assert.equal(classifyVersion(undefined), 'unknown');
});

test('peer range in package.json matches the supported range', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh'], `>=${SUPPORTED_DSH_RANGE.min} <${SUPPORTED_DSH_RANGE.below}`);
});

test('runtime identities are unique to this plugin', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'dsh-image-edge-cap');
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: dsh-image-edge-cap\n\s+name: dsh-image-edge-cap/);
  for (const file of ['../index.mjs', '../cap.mjs', '../client/index.mjs', '../scripts/build-client.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /dsh-rpm|short-tool-ids|Rate limits/, file);
  }
});
