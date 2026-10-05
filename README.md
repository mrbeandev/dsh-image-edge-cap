# dsh-image-edge-cap

Caps the **longest side of every image sent to the providers or models you
choose** in DeepSeek Harness (DSH), with its own **Settings → Image size** tab.

Images are shrunk with the aspect ratio kept (default limit **2000 px**). Only
the copy sent in the model request is resized: stored attachments and session
logs never change, and providers or models you don't choose get exactly the
same requests as before.

**Contents:** [Why](#why) · [Supported DSH versions](#supported-dsh-versions) ·
[Install](#install) · [Settings tab](#the-settings-tab) ·
[How it works](#how-it-works) · [Development](#development)

## Why

Anthropic's Messages API rejects a request that has **more than 20 images**
when any image is **over 2000 px on either side**:

```
400 invalid_request_error: messages.N.content.1.image.source.base64.data:
At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels
```

Every turn resends the whole history, so once a session passes 20 images
with one tall screenshot in it, every later turn fails, `/compact` included.
The pi-ai `requestImagePixelBudget` limits total pixels (w × h), not side
length, so long thin images such as full-page mobile screenshots
(390 × 2475 ≈ 0.97 MP) pass through unchanged. This plugin closes that gap
per provider, or per model.

## Supported DSH versions

| DSH version | Status |
|---|---|
| `0.2.0-rc.1` | ✅ Tested (unit tests plus a real Cordis mount with the real attachment store) |
| later `0.2.x` releases | ⚠️ Untested: loads with a warning |
| older than `0.2.0-rc.1` | ❌ Not supported (no route-chosen request-image targets) |
| `0.3.0` and newer (prereleases included) | ❌ Refused until tested (override with `allowUntestedHarness: true`) |

**Node.js:** `^22.19.0` or `>=24.0.0`. The plugin has no runtime
dependencies, and it does not need any other community plugin.

## Install

From a packed tarball (until it is published to npm):

```bash
npm pack                         # in this repository → dsh-image-edge-cap-0.1.0.tgz
dsh plugin --profile web add "$(pwd)/dsh-image-edge-cap-0.1.0.tgz"
```

After publication: `dsh plugin --profile web add dsh-image-edge-cap`.

Restart DSH Web, then open **Settings → Image size**.

## The Settings tab

*Image size* lists every registered model provider. For each one, choose:

| Mode | Effect |
|---|---|
| **Off** (default) | Nothing changes for this provider. |
| **All models** | Every model of this provider gets capped images. |
| **Selected models** | A checklist of the provider's models appears; only the checked models get capped images. Other models of the same provider are left alone. |

Set **Max edge** (16–16384 px, default 2000), then press **Apply**. Rules
apply to the next request with no restart, including resumed sessions,
subagents and retries.

Typical setup: provider `9router`, **Selected models**, check the `cc/*`
Claude models, max edge `2000`. The `cx/*` and DeepSeek models on the same
router keep full-size images.

Models a provider no longer lists, and providers that were removed, stay
visible while they still have a rule, so the rule can be cleared.

The rules are stored in this plugin's entry (`dsh-image-edge-cap`) of the
profile's `cordis.patch.yml`:

```yaml
- id: dsh-image-edge-cap
  name: dsh-image-edge-cap
  config:
    providers:
      9router:
        mode: selected
        models: [cc/claude-opus-5-5, cc/claude-sonnet-5-5]
        maxImageEdge: 2000
```

## How it works

1. An `llm/stream` listener reads the request's `provider` and `model`. If no
   rule matches, it returns the stream untouched, so the request is
   byte-identical to the one sent without the plugin.
2. If a rule matches, the listener runs the adapter stream inside an
   `AsyncLocalStorage` scope that holds the cap.
3. The plugin wraps `readImageRequest` on the `attachments` service (the
   `LocalAttachmentStore` instance). When the pi-ai adapter asks for an image
   target, the wrapper shrinks the target so that its long edge is at most
   the cap. It does this only inside a capped scope.
4. The attachment store resizes the image with its own code and caches the
   result under a new variant id. The plugin contains no image code.

The wrapper is installed when the `attachments` service becomes available
and is removed when the plugin is disposed. Each newly capped image is
logged once:
`dsh-image-edge-cap: capped a request image 390×2475 → 315×2000 (max edge 2000)`.

## Development

The browser entry (`lib/client.js`) is generated from `client/index.mjs`.
Edit the source, then rebuild.

```bash
npm run build       # generate lib/client.js from client/index.mjs
npm test            # cap math, scoping, version gate, Settings tab tests
DSH_TEST_HARNESS_ENTRY="$(realpath "$(which dsh)")" npm run test:integration
npm run pack:check  # inspect the exact published file set
```

`test/plugin.test.mjs` mounts the plugin in the installed DSH's own Cordis
next to the real `LocalAttachmentStore`. It saves real PNGs and checks the
dimensions that come back for capped, uncapped, and live-changed rules.

## License

MIT
