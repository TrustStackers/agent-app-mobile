# agent-app-mobile

A **minimal, working example** of a mobile app built on the **P2P Trust Stack**:
it takes a username and a passphrase, creates a self-certifying VTA
(`did:scid:vh`), and registers it with a utility server over the trust stack.

It is a deliberate subset of the reference `agent-app` — same API, same flow,
no HTTP server and no TUI. The whole app is ~250 lines of Node and ~150 lines of
web UI.

```
┌──────────────────────────────────────────────┐
│ WebView UI (www/)                             │
│  username · passphrase · progress · result    │
└───────────────┬──────────────────────────────┘
                │ @capawesome/capacitor-nodejs (event bridge)
┌───────────────▼──────────────────────────────┐
│ Embedded Node app (www/nodejs/)               │
│  composition root — mirrors agent-app         │
│  createNodeHost → createAgentStack → start    │
│  discovery → connectUtility → pushIdentity    │
│  ┌──────────────────────────────────────────┐ │
│  │ @p2p-trust-stack/app-api   (npm)          │ │
│  │ @p2p-trust-stack/core      (npm)          │ │
│  └──────────────────────────────────────────┘ │
└───────────────────────────────────────────────┘
```

The UI never touches crypto, SQLite or the network: it sends one request and
renders the events the Node app posts back.

## Quick start

```bash
npm install                 # Capacitor 8 + the Node.js plugin
npm run android:init        # one-time: npx cap add android
npm run setup               # vendor the stack, shim argon2, patch the plugin
npm run android:build       # cap sync + gradle assembleDebug
npm run android:run         # install, launch, stream logs
```

The committed `www/nodejs/bootstrap.env` already points at a working relay, so
you can build straight away. To use a different one, run
`npm run init:bootstrap` first — see [Relay configuration](#relay-configuration).

`npm run check` (also run by `setup`) statically verifies that the WebView and the
Node app agree on the bridge protocol, and loads the WebView script against a DOM
stub to catch anything that throws on startup.

> Before installing, keep the screen on — the plugin re-copies the whole Node
> project out of the APK on every install, and a backgrounded app can be frozen
> mid-copy. `adb shell svc power stayon usb` is the easy fix (see the gotchas).

Then enter a username and a passphrase in the app and tap **Create VTA & register**.

> `npm run setup` reads the trust-stack packages from `P2PTS_PACKAGES_DIR`
> (default `/Users/shannon/p2pts`), builds them, and packs them into `vendor/`.
> Once `@p2p-trust-stack/*` is published, replace the `file:` specs in
> `www/nodejs/package.json` with version ranges and that step disappears.

## What it does

The app has a small menu — five screens, each a thin wrapper over one part of the
`TrustStack` API:

| Menu | API calls | What happens |
|---|---|---|
| **Create VTA** | `host.createAgent` → `createAgentStack({ adopt })` → `stack.start()` → `connectUtility()` → `connectivity.pushIdentity()` | Creates the identity and its encrypted keystore, activates it, then registers it with the utility server |
| **Log in** | `host.unlockAgent` → `stack.adopt()` → `stack.start()` → `connectUtility()` | Unlocks an existing VTA with its passphrase and reconnects it (no re-registration) |
| **Set name** | `names.register({ name, namespace })` | Registers `vta:<namespace>:<name>` — a two-phase commit over TSP |
| **Look up name** | `names.resolve(nameUri)` | Resolves a name to its DID, peer ID and addresses |
| **Show info** | `identity.current()`, `connectivity.status()`, `names.list()` | The active VTA's VID/DID/peer, connectivity and registered names |

Plus a **Log out** in the session bar, which stops the agent (`identity.deactivate()`)
so you can activate a different VTA. The embedded runtime itself never restarts —
it is single-instance for the life of the app process.

The **Log in** screen lists the VTAs already on the device (`host.listAgents()`) as
tappable chips, so you do not have to remember the name.

This mirrors `agent-app/web/server.ts` closely; the additions are the
mobile-specific environment setup and the handshake described below.

## The bridge protocol

The WebView sends one event per action and the Node app replies with `status`
progress lines plus one terminal event:

```
createVta  → created        login → loggedIn        logout → loggedOut
setName    → nameSet        lookupName → nameLookup getInfo → info
hello      → hello          (any) → error
```

Both sides name these as plain strings, so a typo on either side is a **silent
no-op** at runtime. `npm run check` compares the two sides statically and fails
the build on a mismatch.


## Project layout

```
agent-app-mobile/
├── capacitor.config.json        webDir: www, nodeDir: nodejs
├── www/                         the served web app (source — no build step)
│   ├── index.html · styles.css
│   ├── main.js                  bridge client: one request, four events
│   └── nodejs/                  the embedded Node app
│       ├── bootstrap.env        ← the relay it registers with (committed)
│       ├── package.json         depends on the vendored stack tarballs
│       └── index.js             the composition root
├── patches/
│   ├── capacitor-nodejs-cxx20.patch      the required upstream fix (documented)
│   └── argon2-shim/             pure-JS @node-rs/argon2 replacement
├── scripts/
│   ├── setup.mjs                vendor + shim + patch + verify
│   ├── init-bootstrap.mjs       write www/nodejs/bootstrap.env
│   ├── check-bridge.mjs         WebView ↔ Node protocol consistency
│   ├── check-ui.mjs             load the WebView script against a DOM stub
│   └── run-android.mjs          install, launch, tail logs
└── vendor/                      packed stack tarballs (generated)
```

`nodeDir` is resolved **relative to `webDir`**, which is why the Node app lives
at `www/nodejs` and not at the repo root.

## Relay configuration

Which bootstrap/relay server the app registers with is set by
**`www/nodejs/bootstrap.env`** — a committed file that is bundled into the app:

```
BOOTSTRAP_SEED_HEX=000…000        # placeholder — see below
BOOTSTRAP_PEER_ID=12D3KooWKF2Tmh21NNSH5gWazfbmFEtTZS9XT1uXk8njFAy5jUda
BOOTSTRAP_HOST=relay.truststackers.com
BOOTSTRAP_TCP_PORT=4001
BOOTSTRAP_WS_PORT=4002
BOOTSTRAP_ENABLE_RELAY=true
```

Change it with:

```bash
# Point at a different relay, given its peer ID (public — no secret needed):
npm run init:bootstrap -- --host relay.example.com --peer-id 12D3KooW...

# Or derive the peer ID from the relay's seed, or its 24-word BIP-39 phrase:
npm run init:bootstrap -- --host 203.0.113.5 --seed-hex <64 hex chars>
npm run init:bootstrap -- --host relay.example.com --words-file ./phrase.txt

npm run android:build        # rebuild for it to take effect
```

`init-bootstrap` prints the multiaddrs it will dial, so a wrong host or peer ID
is visible immediately rather than as a silent LAN-only fallback. It uses only
`@p2p-trust-stack/core` — no other checkout of any repo is involved.

### Why it is a bundled file, and why it is not called `.env`

Two constraints force this shape, and both are worth knowing before you write
your own app:

- **The core reads `<cwd>/.env`.** `base-agent.start()` does not pass a
  `bootstrapEnv`, so there is no way to inject the config through the public API.
  On a phone `process.cwd()` is `/` at boot, and the real config lives in
  app-private storage created at first launch — so there is **no build-time
  directory that becomes the runtime cwd**. The values have to be bundled with
  the app; `index.js` copies them to `<app data>/runtime/.env` and `chdir`s there.
- **Capacitor strips dotfiles from the APK.** Its Android `ignoreAssetsPattern`
  includes `.*`, so a file named `.env` in the web assets is silently dropped.
  `bootstrap.env` is not a dotfile, so it survives; only the runtime copy is
  named `.env`.

### Why the seed is a placeholder

`BOOTSTRAP_SEED_HEX` is required by the core's loader, but a **client never reads
its value**: `buildBootstrapUrls()` builds the dial address from `HOST` +
`PEER_ID` + the ports, and `verifyBootstrapEnv()` — the only function that would
compare seed against peer ID — is never called on the client path. The committed
file therefore carries a placeholder instead of the relay's real (private) seed,
which must never be published. If a future core version starts calling
`verifyBootstrapEnv()`, this fails loudly with a peer-ID mismatch; regenerate with
`--seed-hex` at that point.

## The three things that make it work

Everything else is stock Capacitor. These three are not optional, and each is
handled by `npm run setup`.

### 1. The embedded runtime must be Node ≥ 22.5 — so we swap it

`@p2p-trust-stack/core` uses the built-in **`node:sqlite`** (added in Node 22.5).
The plugin ships nodejs-mobile **18.20.4**, which has no `node:sqlite` at all, so
a stock setup fails. `@capawesome/capacitor-nodejs` downloads its runtime at
Gradle build time and honours two project variables, so `setup` points them at a
revived Node 24 build:

```groovy
// android/variables.gradle
nodejsMobileAndroidUrl    = 'https://github.com/gmaclennan/nodejs-mobile/releases/download/v24.18.0-0/nodejs-mobile-android-24.18.0-0.zip'
nodejsMobileAndroidSha256 = 'ceb86b0b8130006195a60cd37393ebe0fd665b644ce8d5674dfba1da65d3be28'
```

The zip's layout (`bin/<abi>/libnode.so` + `include/node/…`) matches what the
plugin's CMake expects, so it is a drop-in. Use the **full** flavour — `-lite`
drops ICU, inspector and **sqlite**.

> The plugin caches the download under a *fixed* filename and only re-extracts
> when the directory is missing, so after changing the URL you must delete
> `~/.gradle/caches/capawesome-capacitor-nodejs`.

### 2. The plugin needs C++20 to compile against Node ≥ 22

Node 24's V8 headers hard-require C++20; the plugin's `CMakeLists.txt` sets no
standard, so the NDK clang default (C++17) fails with ~20 errors
(`v8config.h: error: "C++20 or later required."`). `setup` inserts:

```cmake
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
```

Recorded in `patches/capacitor-nodejs-cxx20.patch`. This affects *any* Node ≥ 22
runtime, not just ours — worth reporting upstream.

### 3. Native addons don't load, so `@node-rs/argon2` is shimmed

`core` uses the native `@node-rs/argon2` addon to derive the AES key that
encrypts a VTA's private keys. It **cannot load** inside this embedding:

```
dlopen failed: cannot locate symbol "napi_get_undefined"
```

`libnode.so` *does* export the N-API symbols — the problem is link scope: the
plugin loads Node via `System.loadLibrary("node")` (RTLD_LOCAL), so the addon
dlopen'd from inside Node cannot see them. This was verified against **both** the
Node 18.20.4 and Node 24.18.0 runtimes, so it is a property of the embedding, not
the runtime version.

`setup` therefore installs `patches/argon2-shim` over
`node_modules/@node-rs/argon2`. The shim is ~40 lines: the core calls exactly one
function with fixed parameters (Argon2id, 19 MiB, t=2, p=1, 32-byte output) from
an async context, and those parameters are stored in the keystore row — so the
derivation stays byte-compatible. It uses `@noble/hashes`, which core already
depends on, and the async variant so the KDF doesn't block the UI bridge.

This also means the app works on **iOS**, where native addons are not available
at all.

## Mobile-specific gotchas

Six things about running the stack on a phone are not obvious. All are handled in
`www/`, and all are worth knowing before you write your own app.

### `P2PTS_HOME` must be set *before* the stack is imported

Importing `@p2p-trust-stack/app-api` has a **module-level side effect**: it builds
`defaultRegistry = new AgentRegistry()`, whose constructor calls
`resolveP2ptsHome()` and then `mkdirSync()`. With no home passed, that resolves to
the platform default — on Android, `/data/.p2pts`, which an app cannot create:

```
Error: EACCES: permission denied, mkdir '/data/.p2pts'
  at ensureP2ptsHome (core/dist/platform/p2pts-home.js:216:5)
  at new AgentRegistry (app-api/dist/runtime/agent-registry.js:215:18)
  at app-api/dist/runtime/agent-registry.js:239:32      <- module scope
```

So the stack is imported **dynamically**, after `process.env.P2PTS_HOME` is
pointed at a writable directory. A static `import` crashes the runtime before any
of your code runs.

### The relay config has to be bundled, not placed on disk

See [Relay configuration](#relay-configuration). In short: the core reads
`<cwd>/.env`, and on a phone there is no build-time directory that becomes the
runtime cwd — so the values ship inside the app and are copied into place at boot.

### Persistent data goes in `app.datadir()`

The Node project directory is overwritten on app updates. Everything mutable —
`P2PTS_HOME`, the runtime `.env`, the databases — lives under
`app.datadir()` (`/data/user/0/<pkg>/files`).

### The runtime is single-instance and never restarts

Node starts once per app launch; there is no `stop()`. The app therefore treats
each action as a one-shot guarded operation, and "log out" stops the *agent*
(`identity.deactivate()`), not the runtime. `process.exit()` is also disallowed by
the App Store, so the entry point never calls it.

### The WebView can miss the runtime's first message

The Node app announces itself at boot, but that message travels Capacitor's event
channel and is **dropped if the WebView has not attached its `message` listener
yet** — Capacitor logs `No listeners found for event ready`. The WebView therefore
also *asks*, once `isReady()` reports the runtime is up:

```js
Nodejs.addListener('message', handleMessage);
Nodejs.addListener('ready', handshake);   // plugin's ready event
void handshake();                         // …and in case it is already up
```

`handshake()` sends `hello`, which the Node app answers with its version and the
agent list. Both paths are idempotent, so whichever fires first wins.

### Every reinstall re-copies the Node project

The plugin copies the Node project out of the APK into app storage, and it does so
whenever the APK's `lastUpdateTime` changes — i.e. **on every install**, not just
the first. That is ~56 MB / ~6,000 files. If the app is backgrounded mid-copy,
Android's cached-app freezer suspends the process and the copy **stalls
indefinitely** until the app is foregrounded again (it looks like a hang, with no
log output at all). Keep the screen on during an install:

```bash
adb shell svc power stayon usb
```


## Status and limitations

Verified on a **Galaxy S23 Ultra** (Android 16 / API 36, arm64-v8a) and on an
Android emulator, with Capacitor 8.5.3, `@capawesome/capacitor-nodejs` 0.2.0 and
the Node 24.18.0 runtime:

```
host:      P2PTS_HOME = /data/user/0/com.truststackers.agentappmobile/files/p2pts
create:    creating the VTA "bob" (did:scid:vh, Ed25519/X25519)
vta:       VTA ready · VID DP2JZTCZ8curFoGh06JzXdfNOpTD6y9yzgQaA-6YSidM
agent:     Listening on port 24000.
agent:     Registering with LAN addrs: /ip4/192.168.1.222/tcp/24000/p2p/12D3KooW…
agent:     Connected to bootstrap server. Discovered 4 peers. (relay available)
agent:     Circuit-relay reservation active — reachable via relay from other networks.
identity:  bob · did:scid:vh:1:z9R8uva3yuBTQS2x2AaBXJchwxougi856t6ybJJsWrWKe
discovery: attempt 1: 4 peer(s) on the mediator — utility server found
utility:   connected to the utility server
register:  identity pushed to the utility server
```

The screenshot and the raw log from that run are in [`docs/`](./docs) —
`device-success.jpg` and `device-log.txt`.

Log in (unlock + reconnect) and log out (stop the agent, switch VTAs) are both
exercised on device.

Not included, by design:

- **iOS** — the same app should work (the argon2 shim is already
  cross-platform), but the plugin's iOS runtime is a `NodeMobile.xcframework`
  that must be swapped separately.
- **The rest of the stack** — relationships, messaging, credentials, communities,
  profiles, delegations. All are reachable through the same `TrustStack` object
  this app already holds; each is one more domain method and one more screen.

Requires a **utility server registered on the same bootstrap/relay**. If none is
present the app still creates the VTA and connects, then reports clearly that
there was nothing to register with (it retries discovery for 30 s first). Name
registration needs that utility-server connection too — it is a two-phase commit
over TSP.

## Upstream items worth reporting

1. **`@capawesome/capacitor-nodejs`: add C++20 to the CMake config.** Without it,
   no Node ≥ 22 runtime can be used.
2. **`@p2p-trust-stack/app-api`: the `defaultRegistry` module-level singleton
   makes the package un-importable on a platform where the default
   `P2PTS_HOME` is not writable.** Deferring that construction (or reading
   `P2PTS_HOME` lazily) would remove the need for the dynamic-import dance.
3. **`base-agent.start()` cannot be given a `bootstrapEnv`** through the public
   API even though `connectToBootstrap` accepts one, which forces the
   `.env`-plus-`chdir` workaround.
4. **The plugin re-copies the whole Node project on every install** (keyed on the
   APK's `lastUpdateTime`), which is slow and can stall when the app is
   backgrounded. Keying on the project's own content hash would fix it.



