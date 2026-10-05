# dsh-image-edge-cap

Caps the **longest side of every image sent to the providers or models you
choose** in DeepSeek Harness (DSH), with its own **Settings → Image size** tab.

[![npm version](https://img.shields.io/npm/v/dsh-image-edge-cap.svg)](https://www.npmjs.com/package/dsh-image-edge-cap)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.1%20%E2%86%92%20%3C0.3.0-informational.svg)](#supported-dsh-versions)

- **Source code:** [github.com/mrbeandev/dsh-image-edge-cap](https://github.com/mrbeandev/dsh-image-edge-cap)
- **npm package:** [npmjs.com/package/dsh-image-edge-cap](https://www.npmjs.com/package/dsh-image-edge-cap)

Images are shrunk with the aspect ratio kept (default limit **2000 px**). Only
the copy sent in the model request is resized: stored attachments and session
logs never change. Providers and models you don't choose get exactly the same
requests as before.

**Contents:** [Supported DSH versions](#supported-dsh-versions) ·
[Why this plugin exists](#why-this-plugin-exists) · [Install](#install-from-npm) ·
[Settings tab](#the-settings-tab) · [How it works](#how-it-works) ·
[Compatibility and risk](#compatibility-and-risk) · [Development](#development)

## Supported DSH versions

**Supported range: DSH `0.2.0-rc.1` up to (not including) `0.3.0`.** Check
yours with `dsh --version`.

| DSH version | npm tag (at the time of this release) | Status |
|---|---|---|
| `0.2.0-rc.2` | `latest`, `next` | ✅ Tested |
| `0.2.0-rc.1` | — | ✅ Tested |
| `0.2.1-alpha.1` | `alpha` | ⚠️ Integration tests pass; loads with an "untested" warning |
| other releases from `0.2.0-rc.1` up to `0.3.0` (not included) | — | ⚠️ Untested: loads with a warning |
| older than `0.2.0-rc.1` (0.1.x) | — | ❌ Not supported: they have no route-chosen request-image targets |
| `0.3.0` and newer (prereleases included) | — | ❌ Refused until tested (override with `allowUntestedHarness: true`) |

**Node.js:** `^22.19.0` or `>=24.0.0`.

The plugin has no runtime dependencies and does not need any other community
plugin. A refused plugin logs a clear error at startup and does not load; the
Settings tab then says the host plugin is not running. It never half-loads.

## Why this plugin exists

Anthropic's Messages API rejects a request that has **more than 20 images**
when any image is **over 2000 px on either side**:

```text
400 invalid_request_error: messages.N.content.1.image.source.base64.data:
At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels
```

Every turn resends the whole history. Once a session passes 20 images and one
of them is a tall screenshot, every later turn fails, and `/compact` fails too
(it sends the same history). Full-page screenshots of mobile layouts are the
usual cause.

DSH's own `requestImagePixelBudget` limits **total pixels** (width × height),
not side length. Long thin images pass it unchanged:

| Image | Pixels | After a 1.15 MP budget | Anthropic many-image rule |
|---|---|---|---|
| 2460 × 392 (wide strip) | 0.96 MP | 2460 × 392 | ❌ over 2000 |
| 390 × 2475 (full-page mobile screenshot) | 0.97 MP | 390 × 2475 | ❌ over 2000 |
| 2718 × 1346 | 3.7 MP | 1524 × 755 | ✅ |

With this plugin set to 2000 px, those become 2000 × 319 and 315 × 2000, and
the stuck session continues. The same limit is discussed in
[anthropics/claude-code#12351](https://github.com/anthropics/claude-code/issues/12351).

## Install from npm

```bash
dsh plugin --profile web add dsh-image-edge-cap
```

Stop the running DSH Web process when your active work is finished, then start
it again (for example `dsh web --no-open --port 3080`) and refresh the page.
Open **Settings → Image size** and choose which providers or models to cap.

To install from a local checkout instead (keep the folder in place, the
profile links to it):

```bash
dsh plugin --profile web add "/absolute/path/to/dsh-image-edge-cap"
```

To remove it:

```bash
dsh plugin --profile web remove dsh-image-edge-cap
```

Alternatively, set a provider to **Off**; its next request goes out unchanged.

## The Settings tab

The plugin adds its own **Image size** tab to Settings. It lists every
registered model provider, and for each one you choose a mode:

| Mode | Effect |
|---|---|
| **Off** (default) | Nothing changes for this provider. |
| **All models** | Every model of this provider gets capped images. |
| **Selected models** | A checklist of the provider's models appears; only the checked models get capped images. Other models of the same provider are left alone. |

Then set **Max edge** (16–16384 px, default `2000`) and press **Apply**.

- A rule applies from the next request, including resumed sessions, subagents
  and retries. No restart is needed.
- The model checklist comes from DSH's live model catalog, the same list as
  the model picker.
- A model that a provider no longer lists, or a provider that was removed,
  stays visible while it still has a rule, so the rule can be cleared.
- A failed or conflicting save shows an error instead of false success. If the
  host plugin is not running (for example on an unsupported DSH), the tab says
  so and the controls are disabled.

Typical setup: a router provider that serves both Claude and GPT models →
**Selected models**, tick only the Claude models, max edge `2000`. The other
models keep full-size images.

The rules are stored in this plugin's entry of the profile patch
(`cordis.patch.yml`), so you can also edit them by hand:

```yaml
- id: dsh-image-edge-cap
  name: dsh-image-edge-cap
  config:
    providers:
      my-router:
        mode: selected          # off | all | selected
        models: [cc/claude-a, cc/claude-b]
        maxImageEdge: 2000
```

## How it works

1. An `llm/stream` listener reads the request's `provider` and `model`. If no
   rule matches, it returns the stream untouched, so the request is
   byte-identical to the one sent without the plugin.
2. If a rule matches, the listener runs the adapter stream inside an
   `AsyncLocalStorage` scope that holds the cap. The scope reaches the image
   reads the adapter makes while the stream is consumed, even through other
   `llm/stream` listeners (such as a rate limiter) and concurrent requests.
3. The plugin wraps `readImageRequest` on the `attachments` service. When the
   pi-ai adapter asks for an image target inside a capped scope, the wrapper
   lowers the target so its long edge is at most the cap. The short edge is
   rounded the same way the store resizes, so the store's checks and cache
   still match.
4. The attachment store resizes and caches the image under a new variant id
   using its own code. The plugin contains no image code.

Each capped image is logged once per process, for example:
`dsh-image-edge-cap: capped a request image 390×2475 → 315×2000 (max edge 2000)`.

## Compatibility and risk

The plugin wraps one method of DSH's attachment store, and does it reversibly.
This is not an official extension API. It is installed when the `attachments`
service appears, removed when the plugin is disposed, and never installed
twice. The version gate refuses DSH releases outside the tested range, so a
changed internal API makes the plugin refuse to load instead of misbehaving.

- It only affects images the **pi-ai** adapter sends (custom OpenAI-compatible,
  Anthropic and other pi-ai providers). Native DeepSeek adapters don't send
  images through this path.
- It never enlarges an image and never undoes DSH's own pixel or byte budgets;
  it can only make the request image smaller.
- Images DSH has already offloaded from the request are not touched.

Plugin config keys (on the `dsh-image-edge-cap` entry):

| Key | Meaning |
|---|---|
| `providers` | The per-provider rules edited by the Settings tab. |
| `enabled: false` | Load without capping anything. |
| `harnessEntry` | Path of the running dsh CLI entry (detected automatically). |
| `allowUntestedHarness: true` | Load on a DSH outside the supported range. Not recommended. |

## Development

The plugin has zero npm runtime or build dependencies. The host code is plain
ESM, and a dependency-free builder writes the browser bundle in DSH's
ModuleLoader format, using the shell's own React.

| File | Role |
|---|---|
| `index.mjs` | Host entry: version gate, Config, `llm/stream` scope, store wrapper. |
| `cap.mjs` | Pure rule matching and target math. |
| `client/index.mjs` | **Source** of the Settings tab. |
| `lib/client.js` | **Generated** by `npm run build`; never edit it by hand. |
| `scripts/check-release.mjs` | Release gate (metadata, stale bundle, private data, packed files). |
| `scripts/e2e-gui.mjs` | Headless-Chrome smoke test of the tab in a running DSH Web. |

```bash
npm run build       # generate lib/client.js from client/index.mjs
npm test            # unit tests: rules, scoping, wrapper, version gate, Settings tab
DSH_TEST_HARNESS_ENTRY="/absolute/path/to/dsh/lib/bin.js" npm run test:integration
npm run verify      # build + tests + release gate
npm run pack:check  # inspect the exact published file set
```

To run the integration suite against another DSH version, install that version
in a scratch folder and point `DSH_TEST_HARNESS_ENTRY` at it:

```bash
npm install --prefix /tmp/dsh-020rc2 @deepseek-ai/dsh@0.2.0-rc.2 --ignore-scripts
DSH_TEST_HARNESS_ENTRY=/tmp/dsh-020rc2/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:integration
```

The integration suite mounts the plugin in that DSH's own Cordis, next to the
real `LocalAttachmentStore`, the real LLM runtime and the real pi-ai adapter.
It saves real PNGs and sends real requests to a loopback mock server (fake
credentials, no paid API calls). Then it decodes the images in the HTTP body
and checks:

- the selected model received capped images and the other model on the same
  provider received the originals;
- the resend served the cached capped version;
- settings changed live applied to the next request.

The UI tests use a fake React harness. Version 0.1.0 was also checked in the
real DSH Web app on 0.2.0-rc.2 and 0.2.0-rc.1, by installing the packed tarball
into an isolated `DSH_HOME` with a mock provider (see
[LOCAL-SETUP.md](LOCAL-SETUP.md)). On each version:

- the tab rendered with every provider Off;
- the model checklist came from the live catalog;
- a rule saved and persisted across a page reload, and on 0.2.0-rc.2 also
  across a server restart and a remove/reinstall;
- the browser console showed no errors from the plugin.

## License

[MIT](LICENSE). Maintainer release steps are in [RELEASE.md](RELEASE.md).
