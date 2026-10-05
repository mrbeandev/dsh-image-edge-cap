# Release checklist

## Current release: 0.1.0 (not yet published)

`dsh-image-edge-cap` is a new package. The repository is
`https://github.com/mrbeandev/dsh-image-edge-cap`, and the package is
MIT-licensed. The owner publishes manually.

`prepublishOnly` runs the release gate (`scripts/check-release.mjs`). The gate
blocks a publish if any of these is true:

- the package metadata or the injected client services are wrong;
- the generated `lib/client.js` is stale;
- a module fails to parse;
- runtime code makes a network request or evaluates strings;
- a source or doc contains an absolute user path or a real session/request id;
- anything private (session logs, `.env`, `.npmrc`, caches, screenshots, the
  local design brief) would be packed.

## Before publishing

1. Verify the npm name is still free (`npm view dsh-image-edge-cap` → 404) or
   owned by the publishing account.
2. Confirm the version in `package.json` has not been published.
3. Confirm the tested DSH versions (`TESTED_DSH_VERSIONS` in `index.mjs`), the
   supported range (`SUPPORTED_DSH_RANGE`, `peerDependencies`,
   `dsh.engines.dsh`) and the README version table agree.
4. Run `npm run verify`.
5. Run `npm run test:integration` once per tested DSH version (see
   [LOCAL-SETUP.md](LOCAL-SETUP.md)).
6. Install the packed tarball into an isolated `DSH_HOME` and run
   `npm run test:e2e` on the newest and oldest tested DSH, including a restart
   and a remove/reinstall.
7. Run `npm run pack:check` and inspect every packed file.
8. Commit, tag `v<version>`, push.
9. Publish only on explicit owner instruction:

```bash
npm whoami
npm publish --dry-run --json
npm publish
```

The package publishes publicly because `publishConfig.access` is `public`. A
dry run does not authenticate or publish.

## After publishing

1. `npm view dsh-image-edge-cap` shows the new version.
2. In a disposable `DSH_HOME`: `dsh plugin --profile web add dsh-image-edge-cap`,
   restart, open **Settings → Image size**, save a rule, restart again, and
   confirm it persisted.
3. `dsh plugin --profile web remove dsh-image-edge-cap`, restart, and confirm
   the tab is gone and DSH starts normally.
