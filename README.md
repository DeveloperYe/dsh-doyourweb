# DSH Browser Tabs

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

A DeepSeek Harness plugin for referencing and controlling existing Chrome and
Edge tabs, without opening a separate browser or exporting login cookies.

## Current Status

Prototype targeting the plugin APIs shipped with DSH `0.2.0-rc.2`.

- Host and client modules build successfully.
- Unit tests and an isolated, headless Chromium extension integration test pass.
- The Remote contribution is mounted and invoked against the real DSH client
  Gateway and Typert registry bundles, so `@` and `/` reach the host service.
- Version `0.1.3` pairs by code instead of by generated files: the shipped
  `extension` folder is loaded as-is (it pins its own id), the extension shows a
  4-digit code on its toolbar badge, and the DSH setup page approves the request
  carrying the same code. The token then lives in the extension's browser storage.
- Version `0.1.2` fixed four defects. Three made both menus report
  `服务不可用: Cannot read properties of undefined (reading 'list')`:
  - the Remote descriptors declared `src-json` codecs, which the client Gateway
    refuses, so `remote.browserTabs` was never mounted;
  - the client read the namespace as `ctx.remote.browserTabs` while injecting only
    `remote`; Cordis rejects that nested access without the nested key injected;
  - the generated extension folder briefly held the unpaired `config.js` template
    on every start, so a service worker that restarted during that window imported
    an empty token and reported `OFF` while DSH was running.
  The fourth silently disabled browser control after the first step of a turn:
  `agent/pre-step` claims one input batch per step, and the batch carries tool
  results rather than the user message on every later step, so rebuilding the
  authorized tab set from each batch revoked the citation. Grants now accumulate
  per conversation and are remembered in `authorized.json`, so a DSH restart
  keeps previously cited tabs controllable.
- Connection to a real, logged-in browser profile has **not yet been re-verified
  end to end** in a running DSH session after these fixes; no computer-control
  debugging is used. Installing the DSH package alone does not install the browser
  extension.

## Features

- Existing HTTP/HTTPS tabs appear in both `@` and `/` menus, alongside built-in sources.
- Website icons come from the browser's local favicon cache, with a globe fallback.
- A `/browser` command for the companion extension's connection settings.
- One-click code pairing: load the shipped extension once, compare a 4-digit code, done.
- An offline connection entry instead of silently hiding the browser candidates.
- Automatic background connection and reconnection, without opening the popup.
- Compact accessibility snapshots with element references and explicit pagination.
- Batched browser actions through Playwright, with a maximum of 12 steps per call.
- Local PNG screenshots on demand.
- Conversation-scoped tab selection; stale snapshots are rejected before acting.

## Requirements

| Component | Requirement |
| --- | --- |
| DSH | `0.2.0-rc.2` plugin APIs. DSH and its packages are published on npm under `@deepseek-ai/dsh*` (MIT / BSD-3-Clause). |
| Node.js | `22` or newer, plus npm. |
| Browser | Chromium-based Chrome or Edge `125` or newer, with Developer Mode enabled. |
| Platform | Verified on Windows. macOS and Linux are expected to work (paths come from `os.homedir()` / `DSH_HOME`) but have not been tested. |

## Build And Install

```sh
npm ci
npm run build
```

In DSH, open **Plugins > Add Plugin** and point it at this built project directory,
wherever you cloned it (for example `~/code/dsh-browser-tabs`).

The package declares `dsh.bundle` and includes `cordis.patch.yml`, which contributes
the `browser-tabs` plugin configuration. Do not install an unbuilt source checkout:
the runtime entry points are `lib/host.js` and `lib/client.js`.

To create a distributable package containing the compiled modules:

```sh
npm pack
```

`prepack` runs the build automatically. The resulting `dsh-browser-tabs-0.1.3.tgz`
contains the runtime modules, extension templates, bundle configuration, and docs.
It can be installed with DSH's CLI:

```sh
dsh plugin --profile desktop add ./dsh-browser-tabs-0.1.3.tgz
```

For directory-based UI installation from a distribution, extract the archive and
select its `package` directory. Cloning the source from Git requires the build step
above; there is no build-free source install.

## Connect The Browser

![Setup page: copy buttons for the extension folder and manager URL, a pending pairing request with its code, and the port hint](docs/setup-page.png)

The companion extension is loaded straight from this package's `extension` folder
(editions installed through DSH's plugin manager ship it inside the package); it
pins its own manifest key, so its id is the same everywhere and nothing has to be
generated, copied, or edited before loading it. That `key` is a **public** key, not
a secret: it only fixes the extension id, which the bridge then requires as the
WebSocket origin. Do not rotate it, or every already-loaded copy becomes a
different extension.

1. Select `/browser` in DSH to open the local connection settings page. It hands
   out the folder path as a copy button and lists any pending pairing request.
2. Open `edge://extensions` or `chrome://extensions`, enable Developer Mode, and
   choose **Load unpacked**, pasting the copied path into the folder picker
   (macOS: press ⇧⌘G). Browsers forbid a web page from opening the extension
   manager, so this one paste is unavoidable; the page offers `edge://extensions`
   and `chrome://extensions` as copy buttons for the address bar.
3. The extension now asks DSH to pair: its toolbar badge shows a 4-digit code.
4. On the DSH setup page, click **允许** for the request showing the same code.
   That comparison is what authorises this browser profile; nothing is typed or
   copied, and the token never leaves the two processes.
5. Return to DSH, type `@`, select a tab, and describe the task.

The token is then stored in the extension's own browser storage and reused on every
start, so pairing happens once per browser profile. The popup shows the state,
offers **解除配对** (unpair) and a port field: DSH's default port is `43187`, and
only if the plugin's `port` setting was changed does that field need the same value
(the setup page shows the port in use).

This is a normal Manifest V3 browser extension: load it once per browser profile.
Afterward, keep the extension enabled and both DSH and the browser running. No
popup or setup page needs to stay open. If DSH starts later or restarts, the
extension reconnects automatically. A pause selected in the popup is saved and
remains paused across browser restarts.

After updating the package, click **Reload** on the installed extension in the
browser's extension manager. Do not remove it or clear its storage: that preserves
the pairing and profile identity. An `OFF` toolbar badge means it is waiting for
DSH. Browser-internal and incognito pages are not listed, and each menu query
returns up to 50 matching tabs.

The extension is currently distributed as an unpacked extension, not a Chrome Web
Store or Edge Add-ons listing. Store publication would require a developer account
and review; it is separate from installation through DSH's plugin manager.

The default setup page is `http://127.0.0.1:43187/setup` while the plugin is running.

### Updating From 0.1.2 Or Earlier

Versions before `0.1.3` generated a per-install copy of the extension with the
token baked into `config.js`, and that copy was the folder you loaded. The bridge
still accepts such a copy with the old token, so an existing install keeps working;
to move to code pairing, load this package's `extension` folder instead, approve
the request it raises, and remove the generated copy from the browser's extension
manager. Delete the leftover `browser-tabs/extension` directory afterwards — the
bridge no longer reads or writes it.

Restart DSH (or disable and re-enable the plugin) after updating so the rebuilt
host and client modules are loaded, then refresh the DSH page in the browser.

### Port Already In Use

Version `0.1.0` had an unload cleanup bug: disabling or removing the plugin could
leave its bridge listening on port `43187`. Version `0.1.1` uses Cordis-owned
resource cleanup, including failed activation, so subsequent unloads release it.
Activation now fails with an explicit message naming the port instead of a bare
`EADDRINUSE`, and the extension popup lets you point a browser at another port.

For the first update from `0.1.0`, save any ongoing work and fully quit DSH,
including its background/tray process, then start it again. Closing the window or
reinstalling the plugin alone cannot release a listener leaked by the old code.
Install or enable the updated plugin from the same project directory. Browser
tabs, login state, and extension pairing do not need to be reset.

If another application or a second DSH instance owns the configured port, stop
that instance or change the plugin's `port` setting and set the same value in the
extension popup. The plugin does not kill other processes or silently change the
browser's connection port.

## Configuration

Defaults are contributed by `cordis.patch.yml`; the host also accepts an optional
`home` setting.

| Setting | Default | Meaning |
| --- | --- | --- |
| `port` | `43187` | Local bridge port, bound to `127.0.0.1` only. |
| `snapshotChars` | `2400` | Default character budget for a snapshot response. |
| `home` | `DSH_HOME` or `~/.dsh` | Base directory; plugin data is stored under `browser-tabs/`. |

Plugin data under `browser-tabs/` is `pairing.json` (the connection token — never
commit or share it), `authorized.json` (the tab references each conversation cited
with `@`; identifiers only, no page content), and `captures/` (requested
screenshots). Deleting `pairing.json` rotates the token, which means the extension
must be unpaired and paired again; deleting `authorized.json` only means previously
cited tabs must be selected with `@` again. Version `0.1.3` keeps nothing else:
there is no generated extension folder any more.

If the plugin's `port` setting is changed, set the same port in the extension popup
(the setup page shows it) and avoid running two plugin instances on one port.

## Model Tools

| Tool | Purpose |
| --- | --- |
| `browser_read` | Read a compact snapshot; narrow with `selector` or `query`, or continue with `cursor`. |
| `browser_act` | Use the latest snapshot ID to click, fill, press, select, check, hover, scroll, or navigate. |
| `browser_capture` | Save a screenshot and return its local path; no base64 is placed in text output. |

Actions can use snapshot element references such as `e1` or Playwright selectors.
A batch stops at the first failure or navigation and reports completed steps.
Read the current state before continuing; do not replay completed actions.

## Efficiency And Privacy

Tab discovery returns metadata to the UI rather than sending every open page to
the model. Cached favicon images also stay in the UI, not the model context. When
a direct user message references a tab, the plugin prepares a
bounded initial snapshot and caches that context for the message. Full snapshot
text remains local; omitted content can be retrieved with a cursor. Read limits
are 400 to 8000 characters, with accessibility depth 8 by default.

The bridge binds `127.0.0.1` only, accepts the WebSocket origin of the pinned
extension id, and requires a per-install token. Because any local process can forge
an origin, the first connection is instead confirmed by the person at the keyboard:
the extension displays a 4-digit code on its badge and the DSH setup page approves
the request carrying the same code, so a local impostor cannot collect the token.
The bridge attaches the debugger to referenced tabs on demand and releases it when
the connection stops. Incognito tabs and browser-internal pages are excluded.
Opening DevTools or another debugger may interrupt control.

Page data returned by these tools enters the configured DSH model's context.
Only reference pages whose content you intend to share with that model. Browser
content is untrusted data, not instructions or authorization. Destructive actions,
purchases, and sensitive submissions still require explicit user authorization;
the tool descriptions are not a transaction-level approval mechanism.

Do not commit or distribute `pairing.json`: it contains the local connection token.
The packaged `extension/config.js` carries only the default port, so it is safe to
publish and to load as-is.

## Development And Tests

```sh
npm test
npm run build
```

CI runs this suite on Linux and Windows plus the browser integration test on Linux; see `.github/workflows/ci.yml`.

For the browser integration test, install Playwright's matching test browser once:

```sh
npx playwright-core install chromium
npm run test:browser
```

The integration test uses a disposable profile, a local fixture page, and bridge
port `43188`. It checks extension inventory, authenticated CDP transport, compact
references, batched filling and clicking, iframe access, stale navigation,
screenshots, and release without closing the controlled tab. It also checks local
favicon images, background connection when DSH starts later, and reconnection
after DSH/browser restarts without opening the popup. It does not interact with
the user's normal browser profile or prove the native DSH menu UI works.

Unit tests pin the DSH contracts and the pairing rules: the Remote descriptors must
carry strict codecs (the client Gateway refuses `src-json`), the client must resolve
the namespace without declaring the nested key it mounts itself, the bridge must
never write into the folder the user loads, a pairing token is handed only to the
request whose code the user approved (and never to a forged or expired one), and a
tab cited by the user must stay authorized across later steps and activation. The
lifecycle and grant checks run in the same disposable child process as the
`agent/pre-step` waterfall, and the extension background is executed in a stub
`chrome` context that asserts the badge code, the stored token, and the port field.

The plugin depends on three DSH interfaces that its own documentation does not
freeze: generated `strict` Remote codecs, the Typert registry, and the client API
Gateway. To re-check them after a DSH upgrade, point the verification script at the
installed archive (DSH ships as an ASAR bundle inside its application resources):

```sh
npm run verify:dsh -- --asar "<path to app.asar>"
```

It extracts the relevant bundles into `.local/dsh-extract` (Git-ignored), then
asserts that the real registry accepts this package's host contribution, that the
real Gateway mounts and invokes its client contribution, and that the built
`lib/client.js` lists host tabs through its `@` source. The script needs `npm ci`
first so the extracted bundles can resolve Cordis.

Host lifecycle tests use the same Cordis `4.0.4` version as DSH `0.2.0-rc.2`, in
disposable child processes. They verify repeated enable/disable and cleanup after
failed activation, without touching a running DSH instance.

Toolbar PNG icons are included in the source package. To regenerate them from the
included Lucide artwork with the matching test browser, run `npm run icons`. The README screenshot is generated from the real setup page by `npm run screenshot`.

## Project Layout

```text
src/                  DSH host/client, bridge, grants, and browser engine
src/vendor/           Adapted Playwright CDP tab model
extension/            Companion extension (loadable as-is; pins its own id)
scripts/              Build, integration test, DSH contract verification
test/                 Node.js unit tests
cordis.patch.yml      DSH bundle configuration
lib/                  Generated runtime entry points (Git-ignored)
```

## License

Project code is MIT-licensed. The adapted Playwright tab model is Apache-2.0;
see `NOTICE` and `extension/APACHE-2.0.txt` for attribution and license terms.
The toolbar globe artwork is from Lucide under ISC; see `extension/icons/LICENSE`.
