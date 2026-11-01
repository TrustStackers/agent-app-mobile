// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * agent-app-mobile — the embedded Node app (composition root).
 *
 * This is the *only* place the trust stack is composed. It mirrors
 * `agent-app/web/server.ts`, minus HTTP: the WebView is the UI, and the
 * Capacitor `bridge` module replaces the Fastify routes.
 *
 * Operations, all driven by the UI over the bridge:
 *   createVta   create a VTA and register it with a utility server
 *   login       unlock an existing VTA and activate it
 *   logout      stop the active VTA (the runtime itself is single-instance)
 *   listVtns    the networks (VTNs) the bootstrap peer directory advertises
 *   connectVtn  join one of them, dialing the utility server that serves it
 *   setName     register a human-readable name (vta:<namespace>:<name>)
 *   lookupName  resolve a name to its DID / peer / addresses
 *   getInfo     the active VTA's details and connectivity
 *
 * The app programs against `@p2p-trust-stack/app-api` ONLY. `runtime/*` is
 * deliberately never imported (the app-api's own `surface.test.ts` enforces that
 * boundary); `@p2p-trust-stack/core` is used only for the OOBI helper, exactly
 * as the reference app does.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { format } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

// The bridge module is CommonJS and provided by the Capacitor plugin (it is
// resolved through NODE_PATH, not from node_modules).
const require = createRequire(import.meta.url);
const bridge = require('bridge');
const { channel, app } = bridge;

// ---------------------------------------------------------------------------
// NOTE — the trust stack is imported DYNAMICALLY, further down, on purpose.
//
// Importing `@p2p-trust-stack/app-api` has a **module-level side effect**: it
// constructs `defaultRegistry = new AgentRegistry()`, and that constructor calls
// `resolveP2ptsHome()` + `ensureP2ptsHome()` (a `mkdirSync`). With no home
// passed, `resolveP2ptsHome()` falls back to the platform default — on Android
// that is `/data/.p2pts`, which an app cannot create:
//
//   Error: EACCES: permission denied, mkdir '/data/.p2pts'
//     at ensureP2ptsHome (core/dist/platform/p2pts-home.js:216:5)
//     at new AgentRegistry (app-api/dist/runtime/agent-registry.js:215:18)
//     at app-api/dist/runtime/agent-registry.js:239:32   <- module scope
//
// So a *static* import crashes the runtime before any of our code runs. Setting
// `process.env.P2PTS_HOME` to a writable path BEFORE the import is what makes it
// safe — `resolveP2ptsHome()` checks that variable first.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The relay this agent registers with comes from a committed config file,
// `www/nodejs/bootstrap.env`, read just below (after the path constants). See
// that file and `scripts/init-bootstrap.mjs`.

/** Namespace that names are registered under. Matches the agent's `net`. */
const DEFAULT_NAMESPACE = 'p2pts';

/** How long to keep looking for a utility server before giving up. */
const UTILITY_SERVER_WAIT_MS = 30_000;
/** Gap between discovery attempts. */
const UTILITY_SERVER_RETRY_MS = 5_000;

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = app.datadir();
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
/**
 * Every `log()` line is mirrored here. See the note on `log` below for why iOS
 * needs this file at all.
 */
const LOG_PATH = path.join(RUNTIME_DIR, 'agent.log');
/**
 * The `.env` the core reads: `<cwd>/.env`, written from the bundled `bootstrap.env`
 * at boot. It carries the bootstrap block AND the logging block.
 */
const RUNTIME_ENV_PATH = path.join(RUNTIME_DIR, '.env');
const P2PTS_HOME = path.join(DATA_DIR, 'p2pts');

// ---------------------------------------------------------------------------
// Bootstrap / relay configuration
// ---------------------------------------------------------------------------
//
// Read from `bootstrap.env` — a committed file, bundled into the app.
//
//   * The core reads bootstrap config from `<cwd>/.env`
//     (`loadBootstrapClientEnv()`), and `base-agent.start()` gives it no other way
//     in. On a phone `cwd` is app-private storage created at first launch, so the
//     values must be BUNDLED with the app and copied into place at boot — there is
//     no build-time directory that becomes the runtime cwd.
//   * Capacitor's Android `ignoreAssetsPattern` includes `.*`, so a file named
//     `.env` in the web assets is STRIPPED from the APK. `bootstrap.env` is not.
//
// Regenerate with `npm run init:bootstrap` (see scripts/init-bootstrap.mjs).
const BOOTSTRAP_ENV_PATH = path.join(PROJECT_DIR, 'bootstrap.env');

/** Read `bootstrap.env` and check the keys the core requires are present. */
function readBootstrapEnv() {
  let text;
  try {
    text = fs.readFileSync(BOOTSTRAP_ENV_PATH, 'utf8');
  } catch {
    return { text: null, error: `bootstrap.env not found at ${BOOTSTRAP_ENV_PATH}` };
  }
  // A CLIENT needs the ADDRESS and the PEER ID to expect — never a seed. Only the
  // relay derives its identity from a word sequence, and the core's client loader
  // (`loadBootstrapClientEnv`) rejects a client config that carries a seed, so the
  // seed is not required here and must not be demanded.
  for (const key of ['BOOTSTRAP_PEER_ID', 'BOOTSTRAP_HOST']) {
    if (!new RegExp(`^${key}=\\S`, 'm').test(text)) {
      return { text: null, error: `bootstrap.env has no value for ${key}` };
    }
  }
  return { text, error: null };
}

const bootstrapConfig = readBootstrapEnv();

/** The relay's host, for messages. `'?'` when the config is unusable. */
const BOOTSTRAP_HOST =
  (bootstrapConfig.text && /^BOOTSTRAP_HOST=(.+)$/m.exec(bootstrapConfig.text)?.[1].trim()) || '?';

/**
 * Refuse to start an agent on a broken config.
 *
 * Without this the core would catch the same problem internally and quietly
 * continue in LAN-only mode — the VTA would be created but never registered,
 * which looks like a network fault rather than a configuration one.
 */
function requireBootstrapConfig() {
  if (bootstrapConfig.error) {
    throw new Error(
      `${bootstrapConfig.error}. Run \`npm run init:bootstrap -- --host <dns> --peer-id <id>\`, ` +
        'then rebuild the app.',
    );
  }
}


// ---------------------------------------------------------------------------
// Environment — MUST run before the trust stack is imported (see the note above)
// ---------------------------------------------------------------------------

// 1. Pin P2PTS_HOME to a writable app-private directory, so the module-level
//    `defaultRegistry` inside app-api lands here rather than on `/data/.p2pts`.
process.env.P2PTS_HOME = P2PTS_HOME;
fs.mkdirSync(P2PTS_HOME, { recursive: true });

// 2. Write the bootstrap `.env` and make it the working directory, so the core's
//    bootstrap loader finds it.
await prepareRuntimeDir();

// 3. Apply the LOGGING block from that same file, before anything logs. This app
//    has no npm script at all — the Capacitor plugin launches this runtime — so a
//    config file is the only portable place for verbosity.
await applyLoggingConfig();

// 4. NOW the stack can be imported safely. `await` at module scope (top-level
//    await) is fine — the plugin runs this file as an ES module.
const { createNodeHost, createAgentStack } = await import('@p2p-trust-stack/app-api');
const { encodeOobi } = await import('@p2p-trust-stack/core/relationship/oobi.js');

// 5. Route the STACK's own log lines through `log()`. Without this they go to
//    `console.log` alone, which reaches logcat on Android but is discarded on iOS
//    (see the note on `log` below) — so a `P2PTS_LOG_LEVEL=info` run would look
//    like it had produced nothing on an iPhone or iPad.
await installLogSink();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Append one line to the on-device log file.
 *
 * Logging must never be the thing that breaks the app, so every failure here is
 * swallowed — the worst case is a missing diagnostic, not a dead runtime.
 */
function logToFile(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // Ignored on purpose.
  }
}

/**
 * The one logging entry point.
 *
 * On Android the plugin redirects stdout/stderr to logcat, so `console.log`
 * alone is enough to see what the runtime is doing. iOS has no equivalent: a
 * Home-screen launch discards stdout, and `devicectl device process launch
 * --console` — the only supported way to attach — fails with CoreDeviceError
 * 10002 on this Xcode. So the same line is also written to a file inside the
 * app's Documents directory, which can be pulled straight off the device:
 *
 *   xcrun devicectl device copy from --device <udid> \
 *     --domain-type appDataContainer --domain-identifier <bundle-id> \
 *     --source Documents/runtime/agent.log --destination ./agent.log
 */
function log(...args) {
  // Format once, then send the same string to both sinks. `console.log` alone
  // would not do: the plugin's logcat bridge serialises the *arguments* rather
  // than console.log's formatted output, so a printf-style call reaches logcat
  // with its `%s` placeholders intact.
  const line = format(...args);
  console.log('[agent]', line);
  logToFile(`[agent] ${line}`);
}

/**
 * Apply the logging block from the runtime `.env`.
 *
 * This app has no npm script at all — the Capacitor plugin launches this runtime —
 * so a config file is the only portable place to set verbosity. (`P2PTS_LOG_LEVEL=info
 * node …` in a `package.json` script is POSIX-only syntax, and there is no script
 * here to put it in anyway.)
 *
 * The two keys are translated into `process.env` BEFORE the stack is imported, which
 * works on every core version: both the logger and the ceremony trace read those
 * variables per call. `config/logging-env.ts` — the module the four Node components
 * use — reaches the same result through a config slot a core this old does not have.
 */
async function applyLoggingConfig() {
  let text;
  try {
    text = fs.readFileSync(RUNTIME_ENV_PATH, 'utf8');
  } catch {
    return; // no runtime .env (a broken bootstrap config) — logging keeps its default
  }

  // Parsed with the core's own parser, which every version exports, so the app does
  // not carry a second interpretation of the `.env` format.
  const { parseEnvText } = await import('@p2p-trust-stack/core/config/bootstrap-env.js');
  const raw = parseEnvText(text);

  if (raw.P2PTS_LOG_LEVEL) process.env.P2PTS_LOG_LEVEL = raw.P2PTS_LOG_LEVEL;
  if (raw.CEREMONY_TRACE) process.env.CEREMONY_TRACE = raw.CEREMONY_TRACE;

  log(
    'logging · level %s · ceremony trace %s',
    process.env.P2PTS_LOG_LEVEL ?? '(default: warn)',
    process.env.CEREMONY_TRACE ?? 'off',
  );
}

/**
 * Send the STACK's own log lines through `log()`.
 *
 * `setLogSink` replaces the logger's console output, so this is what makes an
 * info-level run visible on iOS at all: the plugin forwards stdout to logcat on
 * Android, but a Home-screen launch discards it on iOS — which is exactly why
 * `log()` mirrors every line into `agent.log`. Without this sink the stack's lines
 * reach neither destination there.
 *
 * The args are formatted here rather than passed through, so a `%s` inside a stack
 * message cannot swallow the next argument on its way through `log()`.
 */
async function installLogSink() {
  try {
    const { setLogSink } = await import('@p2p-trust-stack/core/util/logger.js');
    setLogSink((level, args) => log(`[stack:${level}] ${format(...args)}`));
  } catch (err) {
    log('could not install the stack log sink — %s', describe(err));
  }
}

// A throw inside the stack would otherwise leave the UI waiting forever with no
// trace of why — on iOS there is nowhere for it to surface on its own.
process.on('uncaughtException', (err) => {
  log('UNCAUGHT', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION', reason && reason.stack ? reason.stack : String(reason));
});

/**
 * The runtime's status strings are written for the Blessed TUI and carry colour
 * tags (`[green]…[reset]`). Strip them so the WebView shows plain text.
 */
const MARKUP =
  /\[(?:green|red|yellow|blue|cyan|magenta|white|black|gray|grey|bold|underline|reset)\]/gi;

function stripMarkup(message) {
  return String(message).replace(MARKUP, '').trim();
}

/** Report a step to the WebView. A reporting failure must never abort the flow. */
function status(step, message, level = 'info') {
  const text = stripMarkup(message);
  log(`${step}: ${text}`);
  try {
    channel.post('status', { step, message: text, level });
  } catch (err) {
    console.error('[agent] status post failed', err && err.message);
  }
}

function send(eventName, payload) {
  try {
    channel.post(eventName, payload);
  } catch (err) {
    console.error('[agent] post failed', eventName, err && err.message);
  }
}

function describe(err) {
  return err && err.message ? String(err.message) : String(err);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A non-reversible fingerprint of a passphrase, for diagnosing "wrong
 * passphrase" reports without ever logging the passphrase itself.
 *
 * The length alone catches the common failure — a trailing space or newline
 * introduced by a keyboard or by `adb shell input text`. The digest catches a
 * same-length difference.
 */
function fingerprint(passphrase) {
  const digest = createHash('sha256').update(passphrase, 'utf8').digest('hex').slice(0, 12);
  return `${passphrase.length} chars, sha256:${digest}`;
}

/**
 * A leading or trailing space is invisible in a password field and is the single
 * most common cause of "wrong passphrase" — the keystore does not trim, on
 * purpose: the passphrase is exactly what was entered.
 */
function warnIfPadded(passphrase) {
  if (passphrase !== passphrase.trim()) {
    status(
      'passphrase',
      'this passphrase has leading or trailing whitespace — it will have to match exactly at log in',
      'warn',
    );
  }
}

/**
 * Write `.env` and make it the working directory, so the core's bootstrap loader
 * finds it. Without this the agent silently degrades to LAN-only mode.
 */
async function prepareRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  // Each launch starts a fresh log: the file describes *this* run, and it is
  // pulled off the device by hand, so carrying history forward only buries the
  // part that matters.
  fs.rmSync(LOG_PATH, { force: true });

  if (bootstrapConfig.error) {
    // Boot must not die on a bad config: the app stays usable, and the problem
    // is reported when an operation actually needs the relay.
    log(`bootstrap config unusable — ${bootstrapConfig.error}`);
  } else {
    // Copied VERBATIM. The bundled file is already the CLIENT shape — the address
    // and the peer ID to expect, and no key material — which is exactly what the
    // core's `loadBootstrapClientEnv()` requires, so nothing is added here.
    fs.writeFileSync(RUNTIME_ENV_PATH, bootstrapConfig.text, 'utf8');
  }

  try {
    process.chdir(RUNTIME_DIR);
  } catch (err) {
    // chdir is normally available; if the platform refuses it, redirect the one
    // call the core makes — `resolve(process.cwd(), '.env')`.
    process.cwd = () => RUNTIME_DIR;
    log('chdir refused (%s) — overrode process.cwd() instead', describe(err));
  }
  log('runtime dir ready at', RUNTIME_DIR);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
//
// One host, one stack, at most one *active* agent. Switching VTAs is
// `stack.adopt(newHandle)` after stopping the previous agent — the same
// mechanism `agent-app` uses for its "activate a different VTA" route.
//
// The embedded runtime itself is single-instance and never restarts, so
// "logout" means stopping the agent, not the process.

/** The host owns P2PTS_HOME and the per-agent layout. */
const host = createNodeHost({ home: P2PTS_HOME });

/** The composed stack, created on the first activation. */
let stack = null;
/** The agent handle the stack is currently answering for, or null. */
let activeHandle = null;

/** The active stack, or a clear error. */
function requireStack() {
  if (!stack || !activeHandle) {
    throw new Error('No VTA is active — create one or log in first.');
  }
  return stack;
}

/**
 * Make `handle` the active agent and start it.
 *
 * `createAgentStack`/`adopt` deliberately do NOT start the agent (so a caller can
 * subscribe before activation); `start()` is ours to call.
 */
async function activate(handle) {
  if (activeHandle) {
    status('agent', 'stopping the current VTA…');
    try {
      await activeHandle.stop();
    } catch (err) {
      log('stopping the previous agent failed', describe(err));
    }
  }

  if (!stack) {
    stack = await createAgentStack({ host, adopt: handle });
  } else {
    await stack.adopt(handle);
  }
  activeHandle = handle;

  status('activate', 'activating — booting the agent and registering with bootstrap');
  await stack.start((message) => status('agent', message));
}

/**
 * The dial addresses for a discovered server.
 *
 * Its advertised `multiaddrs` are not enough on their own. A server on another
 * network advertises LAN/NAT addresses nothing can reach, and its
 * `/p2p-circuit` address is filtered out of what it advertises (the server's own
 * `buildDialableMultiaddrs()` drops it). The bootstrap builds that relay address
 * per peer and hands it to us separately, so it is appended here — last, so the
 * direct addresses are tried first. Leaving it out is what makes a first
 * cross-network join fail with nothing to dial.
 */
function dialAddrsFor(peer) {
  const addrs = [...(peer.multiaddrs ?? [])];
  if (peer.relayAddr && !addrs.includes(peer.relayAddr)) addrs.push(peer.relayAddr);
  return addrs;
}

/**
 * The strict 4-item OOBI for a discovered utility server.
 *
 * `vid` is the permanent CESR Slot-A key (it survives a `did:scid:vh` log roll);
 * `peerId` is only a fallback for a server that registered without a VID.
 */
function utilityServerOobi(peer) {
  return encodeOobi({
    cesrVid: peer.vid || peer.peerId,
    peerId: peer.peerId,
    multiaddrs: dialAddrsFor(peer),
    did: peer.did,
  });
}

/**
 * Find what the bootstrap advertises: the networks (VTNs) on offer, and the
 * utility servers behind them.
 *
 * `refresh()` re-queries the bootstrap server, so this is a live view rather than
 * the snapshot taken when we connected. A utility server may come online a moment
 * after we do, so this is a bounded retry rather than a single query — the same
 * wait the auto-connect has always used.
 */
async function discoverNetwork() {
  const current = requireStack();
  const deadline = Date.now() + UTILITY_SERVER_WAIT_MS;
  let peers = [];
  let options = [];

  for (let attempt = 1; ; attempt += 1) {
    ({ peers } = await current.connectivity.refresh());
    options = deriveVtnOptions(peers);
    const servers = peers.filter((p) => p.peerType === 'utility_server' && p.did);

    status(
      'discovery',
      `attempt ${attempt}: ${peers.length} peer(s) on the mediator — ` +
        (options.length
          ? `${options.length} network(s) advertised: ${options.map((o) => o.vtnKey).join(', ')}`
          : servers.length
            ? `${servers.length} utility server(s), none bound to a network yet`
            : 'no utility server yet'),
    );
    for (const p of peers) {
      log(
        `  peer ${p.peerId.slice(0, 16)}… type=${p.peerType ?? 'unknown'} ` +
          `net=${p.net ?? '-'} did=${p.did ? 'yes' : 'no'}`,
      );
    }

    if (options.length > 0 || servers.length > 0 || Date.now() >= deadline) break;
    await sleep(UTILITY_SERVER_RETRY_MS);
  }

  return { peers, options };
}

/**
 * Point the agent at the first utility server among `peers`.
 *
 * The fallback for when the bootstrap advertises no network key to choose from:
 * there is nothing to pick, so the original behaviour stands.
 */
async function connectUtility(peers) {
  const current = requireStack();
  const utility = peers.find((p) => p.peerType === 'utility_server' && p.did) ?? null;

  if (!utility) {
    throw new Error(
      `No utility server is registered on ${BOOTSTRAP_HOST} right now. The VTA is running ` +
        '(and reachable via the relay), but there was nothing to register it with.',
    );
  }

  status('utility', `found utility server ${utility.peerId.slice(0, 16)}…`);
  await current.connectivity.connectUtility(utilityServerOobi(utility));
  status('utility', 'connected to the utility server', 'ok');
  return utility;
}

// ---------------------------------------------------------------------------
// VTNs — the networks the bootstrap advertises
// ---------------------------------------------------------------------------
//
// A VTN is the network a utility server serves. Several utility servers can
// share one bootstrap server, each bound to its own VTN key, so joining a
// network means picking the key and dialing the server that serves it.
//
// The DEFINITIVE way to read that list is `connectivity.vtns()`, and to join,
// `connectivity.connectVtn(key)`. Both were added to `app-api` after the 0.1.0
// release this app vendors, so each is used when present and the same list is
// otherwise derived from the bootstrap peer directory — the bootstrap returns
// every peer's VTN key as `net`, which is the only piece that matters. The
// derived path needs no library change; the definitive one takes over by itself
// once the pinned packages are refreshed.

/** How good a candidate a discovered server is for a VTN, when several serve it. */
function vtnOptionRank(option) {
  // A relay reservation outranks `reachable`: it is a fact the bootstrap
  // verified against its own relay, whereas `reachable` can be true on the
  // strength of a NAT-mapped address nothing listens on.
  return (option.connected ? 4 : 0) + (option.reachableViaRelay ? 2 : 0) + (option.reachable ? 1 : 0);
}

/**
 * Collapse discovered `utility_server` peers into one option per VTN key.
 *
 * ONE ENTRY PER KEY, not per peer: the user is choosing a NETWORK, and when
 * several servers serve a key the most reachable one wins. A server with no key
 * yet (it registered before its namespace was bound) or no DID (the strict
 * 4-item OOBI cannot be built without one) is skipped rather than offered as a
 * failure the user cannot act on.
 */
function deriveVtnOptions(peers) {
  const byKey = new Map();

  for (const peer of peers) {
    if (peer.peerType !== 'utility_server') continue;

    // `net` is the VTN key in the packages this app vendors; `vtnKey` is its
    // name in the definitive API, so either is accepted.
    const vtnKey = text(peer.vtnKey) || text(peer.net);
    if (!vtnKey || !peer.did) continue;
    if (!peer.vid && !peer.peerId) continue;

    const option = {
      vtnKey,
      vtnName: text(peer.vtnName) || undefined,
      peerId: peer.peerId,
      did: peer.did,
      vid: peer.vid || peer.peerId,
      multiaddrs: peer.multiaddrs ?? [],
      relayAddr: peer.relayAddr,
      reachableViaRelay: Boolean(peer.reachableViaRelay),
      reachable: Boolean(peer.reachable),
      connected: Boolean(peer.connected),
    };

    const existing = byKey.get(vtnKey);
    if (!existing || vtnOptionRank(option) > vtnOptionRank(existing)) byKey.set(vtnKey, option);
  }

  return [...byKey.values()];
}

/** The networks on offer right now. Safe to call again while the picker is open. */
async function listVtns() {
  const current = requireStack();
  const { peers } = await current.connectivity.refresh();

  if (typeof current.connectivity.vtns === 'function') {
    return (await current.connectivity.vtns()).map((v) => ({
      ...v,
      vtnKey: text(v.vtnKey) || text(v.net),
    }));
  }
  return deriveVtnOptions(peers);
}

/** The advertised networks as display labels, for the info screen. */
function vtnLabels(peers) {
  return deriveVtnOptions(peers).map((o) => (o.vtnName ? `${o.vtnKey} — ${o.vtnName}` : o.vtnKey));
}

/** Report the network list to the UI (also the picker's "Look again"). */
async function sendVtns() {
  const vtns = await listVtns();
  status(
    'vtns',
    vtns.length ? `${vtns.length} network(s) advertised` : 'no networks advertised yet',
    vtns.length ? 'info' : 'warn',
  );
  send('vtns', { vtns });
}

/**
 * Join a VTN: adopt its key and dial the utility server that serves it.
 *
 * Prefers the definitive `connectivity.connectVtn()`. On the packages this app
 * currently vendors, where it does not exist yet, the same join is performed
 * with the chosen option's own OOBI.
 *
 * One difference remains on the vendored packages: they have no `setNet()`, so
 * the agent's own `net` is not re-adopted mid-session and the bootstrap
 * directory shows it under its default until the next launch. The refreshed
 * packages close that gap with no change needed here.
 */
async function connectVtn({ vtnKey }) {
  const current = requireStack();
  const key = text(vtnKey);
  if (!key) throw new Error('A network (VTN) key is required.');

  status('vtn', `joining the network "${key}" …`);

  let utility = null;

  if (typeof current.connectivity.connectVtn === 'function') {
    const result = await current.connectivity.connectVtn(key);
    status('vtn', `joined "${text(result?.vtnKey) || key}"`, 'ok');
  } else {
    const { peers } = await current.connectivity.refresh();
    const option = deriveVtnOptions(peers).find((o) => o.vtnKey === key);
    if (!option) {
      throw new Error(
        `No utility server is serving the network "${key}" right now — try again in a moment.`,
      );
    }

    status('vtn', `dialing the utility server that serves "${key}" (${option.peerId.slice(0, 16)}…)`);
    await current.connectivity.connectUtility(utilityServerOobi(option));
    status('vtn', `joined "${key}" — connected to the utility server`, 'ok');
    utility = { peerId: option.peerId, did: option.did };
  }

  // Finish whichever operation was waiting on this choice, with the same
  // terminal event it would have sent had there been nothing to pick — so the
  // UI has one completion path per operation, not two.
  const finish = awaitingVtnFor;
  awaitingVtnFor = null;

  if (finish === 'create') {
    await reportCreated(utility);
    return;
  }

  send('loggedIn', {
    ...(await identityPayload()),
    utilityServer: utility ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Guards against a second tap: the embedded runtime is single-instance. */
let inFlight = false;

/**
 * Which operation is waiting on the user to pick a network (VTN).
 *
 * The choice can only be offered *after* the identity is active, because the
 * bootstrap peer directory does not exist until this agent has registered — so
 * the flow is resumed rather than restarted. `connectVtn` reads this to know
 * what to finish: a `create` still has to push the new identity, a `login` is
 * already done.
 */
let awaitingVtnFor = null;

function validateCredentials(name, passphrase) {
  if (!name) throw new Error('A username is required.');
  if (!passphrase) throw new Error('A passphrase is required.');
  if (passphrase.length < 8) throw new Error('The passphrase must be at least 8 characters.');
}

/** Run one operation, reporting a failure to the UI rather than throwing. */
async function run(step, operation) {
  if (inFlight) {
    status('busy', 'an operation is already running', 'warn');
    return;
  }
  inFlight = true;
  try {
    await operation();
  } catch (err) {
    log('FAILED', err && err.stack);
    send('error', { step, message: describe(err) });
  } finally {
    inFlight = false;
  }
}

/** Every VTA on this device, for the login picker. */
function listAgents() {
  return host.listAgents().map((a) => ({ name: a.name, vid: a.vid, did: a.did }));
}

/** The active identity, projected to what the UI shows. */
async function identityPayload() {
  const me = await stack.identity.current();
  return {
    name: me.name,
    vid: me.vid,
    did: me.did,
    peerId: me.peerId,
    multiaddrs: me.multiaddrs ?? [],
  };
}

/** `names.list()` throws when no utility server is connected; treat that as empty. */
async function safeNames(current) {
  try {
    return await current.names.list();
  } catch (err) {
    log('listing names failed', describe(err));
    return [];
  }
}

/** Create a VTA, activate it, and register it with a utility server. */
async function createVta({ name, passphrase }) {
  validateCredentials(name, passphrase);
  requireBootstrapConfig();
  if (host.agentExists(name)) {
    throw new Error(`A VTA named "${name}" already exists on this device — use Log in.`);
  }

  status('create', `creating the VTA "${name}" (did:scid:vh, Ed25519/X25519)`);
  warnIfPadded(passphrase);
  status('passphrase', `stored key material is bound to ${fingerprint(passphrase)}`);
  const handle = await host.createAgent({ name, passphrase });
  status('vta', `VTA ready · VID ${handle.getVid()}`, 'ok');

  await activate(handle);

  // Register with a NETWORK. The bootstrap advertises which VTNs are on offer,
  // so the choice belongs to the user — hand the list to the UI and let
  // `connectVtn` finish the job. With nothing advertised there is nothing to
  // choose, so the original behaviour stands: join the first discoverable
  // utility server.
  const { peers, options } = await discoverNetwork();

  if (options.length > 0) {
    awaitingVtnFor = 'create';
    status('vtn', `${options.length} network(s) to choose from — pick one to finish`);
    send('created', {
      ...(await identityPayload()),
      awaitingVtn: true,
      vtns: options,
      agents: listAgents(),
    });
    return;
  }

  await reportCreated(await connectUtility(peers));
}

/**
 * Push a newly created identity to the network, and report it to the UI.
 *
 * Split out because the create flow can finish in two places: straight after
 * auto-connecting, or after the user has picked a network in the picker.
 */
async function reportCreated(utility) {
  const pushed = await stack.connectivity.pushIdentity();
  if (pushed.ok) {
    status('register', 'identity pushed to the utility server', 'ok');
  } else {
    status('register', `push not acknowledged yet: ${pushed.error ?? 'pending'}`, 'warn');
  }

  send('created', {
    ...(await identityPayload()),
    utilityServer: utility ? { peerId: utility.peerId, did: utility.did } : undefined,
    pushed: pushed.ok,
    agents: listAgents(),
  });
}

/** Unlock an existing VTA and activate it. Does not re-register it. */
async function login({ name, passphrase }) {
  validateCredentials(name, passphrase);
  requireBootstrapConfig();
  if (!host.agentExists(name)) {
    throw new Error(`No VTA named "${name}" on this device — create it first.`);
  }

  status('unlock', `unlocking the existing VTA "${name}"`);
  warnIfPadded(passphrase);
  status('passphrase', `trying ${fingerprint(passphrase)}`);
  const handle = await host.unlockAgent({ name, passphrase });
  status('vta', `VTA unlocked · VID ${handle.getVid()}`, 'ok');

  await activate(handle);

  // Register with a NETWORK. The bootstrap advertises which VTNs are on offer,
  // so the choice belongs to the user — hand the list to the UI and let
  // `connectVtn` finish the job. When nothing advertises a key there is nothing
  // to choose, so the original behaviour stands: join the first discoverable
  // utility server.
  const { peers, options } = await discoverNetwork();

  if (options.length > 0) {
    awaitingVtnFor = 'login';
    status('vtn', `${options.length} network(s) to choose from — pick one to finish logging in`);
    send('loggedIn', { ...(await identityPayload()), awaitingVtn: true, vtns: options });
    return;
  }

  const utility = await connectUtility(peers);
  send('loggedIn', {
    ...(await identityPayload()),
    utilityServer: { peerId: utility.peerId, did: utility.did },
  });
}

/** Stop the active VTA. The runtime stays alive; another VTA can be activated. */
async function logout() {
  requireStack();
  status('logout', 'stopping the active VTA');
  await stack.identity.deactivate();
  activeHandle = null;
  awaitingVtnFor = null;
  status('logout', 'VTA stopped — you can log in to another one', 'ok');
  send('loggedOut', { agents: listAgents() });
}

/**
 * Delete every VTA on this device.
 *
 * **Irreversible.** Each agent's identity, keys and databases live in one
 * directory (`P2PTS_HOME/vta/<name>/`), and this removes it — there is no undo
 * and no recovery, because the private keys are gone. The UI confirms twice.
 *
 * The active agent is stopped first, and the stack is dropped: its stores point
 * at databases that no longer exist, so the next create/log in must build a
 * fresh one.
 */
async function clearAllAccounts() {
  const names = host.listAgents().map((a) => a.name);

  if (names.length === 0) {
    status('clear', 'there are no VTAs on this device', 'warn');
    send('accountsCleared', { deleted: [], agents: [] });
    return;
  }

  if (stack && activeHandle) {
    status('clear', 'stopping the active VTA first');
    try {
      await stack.identity.deactivate();
    } catch (err) {
      log('deactivate during clear failed', describe(err));
    }
  }

  for (const name of names) {
    status('clear', `deleting "${name}"`);
    host.deleteAgent(name);
  }

  stack = null;
  activeHandle = null;
  awaitingVtnFor = null;

  status('clear', `deleted ${names.length} VTA(s) — the keys are gone for good`, 'ok');
  send('accountsCleared', { deleted: names, agents: [] });
}

/** Register a human-readable name for the active VTA: `vta:<namespace>:<name>`. */
async function setName({ name, namespace }) {
  const current = requireStack();
  const ns = String(namespace ?? '').trim() || DEFAULT_NAMESPACE;
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A name is required.');

  const nameUri = `vta:${ns}:${trimmed}`;
  status('name', `registering ${nameUri} — a two-phase commit with the utility server…`);

  const result = await current.names.register({ name: trimmed, namespace: ns });
  if (!result.success) {
    throw new Error(result.reason || `Name registration failed for ${nameUri}.`);
  }

  status('name', `${nameUri} registered`, 'ok');
  send('nameSet', { name: trimmed, namespace: ns, nameUri, names: await safeNames(current) });
}

/** Resolve a name URI to its DID, peer ID and addresses. */
async function lookupName({ nameUri }) {
  const current = requireStack();
  const uri = String(nameUri ?? '').trim();
  if (!uri) throw new Error(`A name is required (for example vta:${DEFAULT_NAMESPACE}:alice).`);

  status('lookup', `resolving ${uri} …`);
  const resolved = await current.names.resolve(uri);

  if (!resolved) {
    status('lookup', `${uri} is not registered (or not in the local cache)`, 'warn');
    send('nameLookup', { nameUri: uri, resolved: null });
    return;
  }

  status('lookup', `${uri} → ${resolved.did}`, 'ok');
  send('nameLookup', { nameUri: uri, resolved });
}

/** Everything the "Show info" screen displays. */
async function getInfo() {
  if (!stack || !activeHandle) {
    send('info', { active: false, agents: listAgents() });
    return;
  }

  const me = await stack.identity.current();
  const conn = await stack.connectivity.status();
  const utility = conn.discoveredPeers.find((p) => p.peerType === 'utility_server' && p.did) ?? null;

  send('info', {
    active: true,
    identity: {
      name: me.name,
      vid: me.vid,
      did: me.did,
      peerId: me.peerId,
      multiaddrs: me.multiaddrs ?? [],
      method: me.meta?.method,
      subjectKind: me.meta?.subjectKind,
      createdAt: me.meta?.createdAt,
    },
    connectivity: {
      bootstrapConnected: conn.bootstrapConnected,
      utilityServerConnected: conn.utilityServerConnected ?? false,
      relayAddr: conn.relayAddr ?? null,
      peerCount: conn.discoveredPeers.length,
      utilityServer: utility ? { peerId: utility.peerId, did: utility.did } : null,
    },
    // What the bootstrap advertises, so the networks stay visible even when the
    // picker is not on screen.
    vtns: vtnLabels(conn.discoveredPeers),
    names: await safeNames(stack),
    agents: listAgents(),
  });
}

// ---------------------------------------------------------------------------
// Bridge wiring
// ---------------------------------------------------------------------------
//
// The UI sends one event per action; every reply is either `status` (progress) or
// a terminal event (`created` | `loggedIn` | `loggedOut` | `nameSet` |
// `nameLookup` | `info` | `vtns` | `error`).

const text = (value) => String(value ?? '').trim();

channel.on('createVta', (payload) =>
  void run('create', () =>
    createVta({ name: text(payload?.name), passphrase: String(payload?.passphrase ?? '') }),
  ),
);

channel.on('login', (payload) =>
  void run('login', () =>
    login({ name: text(payload?.name), passphrase: String(payload?.passphrase ?? '') }),
  ),
);

channel.on('logout', () => void run('logout', logout));

// Destructive: the UI asks twice before sending this.
channel.on('clearAccounts', () => void run('clear', clearAllAccounts));

channel.on('setName', (payload) =>
  void run('name', () => setName({ name: text(payload?.name), namespace: text(payload?.namespace) })),
);

channel.on('lookupName', (payload) =>
  void run('lookup', () => lookupName({ nameUri: text(payload?.nameUri) })),
);

channel.on('getInfo', () => void run('info', getInfo));

// The login screen's network picker: list the VTNs the bootstrap advertises,
// then join the one the user chose.
channel.on('listVtns', () => void run('vtns', sendVtns));
channel.on('connectVtn', (payload) => void run('vtn', () => connectVtn({ vtnKey: text(payload?.vtnKey) })));

// The login picker can be refreshed without an operation in flight.
channel.on('listAgents', () => send('agents', { agents: listAgents() }));

// Handshake. The `ready` below is best-effort: Capacitor drops a message if the
// WebView has not attached its listener yet, so the WebView also asks for this
// once it is listening. Both paths set the same state.
channel.on('hello', () => send('hello', { node: process.version, agents: listAgents() }));

/**
 * One line describing the capabilities the stack actually depends on.
 *
 * Both facts are platform-dependent and fail *quietly* when wrong, which makes
 * them worth stating outright at every boot:
 *
 *   * `WebAssembly` — iOS forbids JIT, so the embedded runtime runs a jitless V8
 *     that exposes no `WebAssembly` global of its own. nodejs-mobile installs a
 *     pure-JS polyfill (`deps/polywasm`) at launch to restore it. libp2p-noise
 *     hashes through `@chainsafe/as-sha256`, a WebAssembly module, so if this
 *     reads `no` the node will start but never complete a handshake.
 *   * `node:sqlite` — added in Node 22.5; the core's keystore is built on it.
 *     The plugin's bundled runtime is 18.20.4, where it does not exist, so a
 *     wrong runtime shows up as a keystore failure rather than a load error.
 *
 * `validate` is checked with a real (empty) module rather than just the global,
 * so a stub that cannot compile anything reports `partial` instead of `yes`.
 */
async function probeRuntime() {
  const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  let wasm = 'no';
  try {
    if (typeof WebAssembly === 'object' && WebAssembly !== null) {
      wasm = WebAssembly.validate(EMPTY_MODULE) ? 'yes' : 'partial';
    }
  } catch {
    wasm = 'no';
  }

  let sqlite = 'no';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    sqlite = typeof DatabaseSync === 'function' ? 'yes' : 'no';
  } catch {
    sqlite = 'no';
  }

  log(
    'runtime · node %s · %s/%s · WebAssembly %s · node:sqlite %s',
    process.version,
    process.platform,
    process.arch,
    wasm,
    sqlite,
  );
}

await probeRuntime();

send('ready', { node: process.version, agents: listAgents() });
log('ready · node', process.version, '· waiting for the WebView');





