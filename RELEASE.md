# Release checklist

## Current release: 0.1.0 (not published)

`dsh-image-edge-cap` is a new package and has not been published to npm. The
owner publishes manually. Check that the name is still free right before
publishing (`npm view dsh-image-edge-cap` should return 404).

## Before publishing

1. `npm run build`, then `npm test`
2. `DSH_TEST_HARNESS_ENTRY="$(realpath "$(which dsh)")" npm run test:integration`
3. `npm pack --dry-run`: the list must contain only `index.mjs`, `cap.mjs`,
   `client/index.mjs`, `lib/client.js`, `scripts/*.mjs`, `test/*.test.mjs`,
   `cordis.patch.yml`, `README.md`, `RELEASE.md`, `LICENSE`, `package.json`
4. Install the tarball into a disposable DSH profile, restart, open
   **Settings → Image size**, set a rule, and confirm that the startup log
   contains `dsh-image-edge-cap: image long-edge caps ready`
5. Optional end-to-end check: copy an affected session folder, reopen it on a
   capped Claude route, send `continue`, and confirm the 400 is gone
6. Create the GitHub repository `mrbeandev/dsh-image-edge-cap`, push, and tag `v0.1.0`
7. `npm publish --dry-run --json`, then `npm publish` (owner only)

## After publishing

Install from the registry into a clean profile, restart DSH, smoke-test the
tab and the log line, then uninstall and confirm that the
`attachments.readImageRequest` wrapper is gone (no capped log lines).
