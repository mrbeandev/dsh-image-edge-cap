# Local setup

This document covers local development of dsh-image-edge-cap. It intentionally
contains no machine-specific paths or private session data.

## Install from this checkout

Stop the current DSH Web process with Ctrl+C, then:

```bash
npm_config_cache="$PWD/.cache/npm" \
  dsh plugin --profile web add "/absolute/path/to/dsh-image-edge-cap"
dsh web --no-open --port 3080
```

Refresh the page and open **Settings → Image size**. Every provider is Off by
default.

Keep the package folder in place if the profile manager installed it as a
link. After editing `client/index.mjs`, run `npm run build` and restart the
profile: the browser bundle is cached until the server restarts.

## Test against several DSH versions

```bash
for v in 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.1; do
  npm install --prefix "/tmp/dsh-$v" "@deepseek-ai/dsh@$v" --ignore-scripts --no-audit --no-fund
  DSH_TEST_HARNESS_ENTRY="/tmp/dsh-$v/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:integration
done
```

## GUI check in a throwaway DSH home

Never use your real profile for this. The throwaway home must be on a
filesystem with POSIX permissions (DSH refuses a credentials file readable
beyond its owner), so use `/tmp` rather than a FAT/NTFS drive.

```bash
npm pack --pack-destination /tmp                      # dsh-image-edge-cap-<version>.tgz
export DSH_HOME=/tmp/dsh-iec-home
dsh plugin --profile web add /tmp/dsh-image-edge-cap-<version>.tgz
```

Add a mock provider so the tab has providers and models to list. It points at
an unreachable loopback port and uses a fake key; no request leaves the
machine. Append to `$DSH_HOME/profiles/web/cordis.patch.yml` (replace the
`[]` line):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      e2e-router:
        displayName: E2E Router
        apiKeyEnv: IEC_E2E_FAKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        defaultInput: [text, image]
        models:
          - { id: cc/claude-test-a, name: Claude Test A }
          - { id: cc/claude-test-b, name: Claude Test B }
          - { id: cx/gpt-test, name: GPT Test }
```

Start it and run the browser smoke test (needs Google Chrome or Chromium):

```bash
IEC_E2E_FAKE_KEY=fake dsh web --no-open --port 18765
# in another terminal, with the URL dsh printed (including ?token=…):
DSH_E2E_URL='http://127.0.0.1:18765/?token=…' DSH_E2E_PROVIDER=e2e-router npm run test:e2e
```

To check persistence after a restart (or a remove/reinstall), restart DSH and
run it again in verify-only mode:

```bash
DSH_E2E_URL='…' DSH_E2E_EXPECT='e2e-router=1 model capped at 2000 px' npm run test:e2e
```

`DSH_E2E_SHOTS=/some/dir` saves screenshots, and `CHROME=/path/to/chrome`
selects the browser.

## Reproducing the original failure

To confirm the fix on a real stuck session, **copy its session folder first**,
then reopen the copy on a capped Claude route and send `continue`. Never
package or commit real session history or screenshots.
