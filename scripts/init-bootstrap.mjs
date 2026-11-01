#!/usr/bin/env node

// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * init-bootstrap — write `www/nodejs/bootstrap.env`, the relay this app registers with.
 *
 *   npm run init:bootstrap -- --host relay.truststackers.com --peer-id 12D3KooW…
 *   npm run init:bootstrap -- --host relay.example.com --seed-hex <64 hex chars>
 *   npm run init:bootstrap -- --host 203.0.113.5 --words-file ./phrase.txt
 *
 * ## Why a bundled file at all
 *
 * `@p2p-trust-stack/core`'s `loadBootstrapClientEnv()` reads a `.env` at
 * `process.cwd()`. On a phone that directory is app-private storage created on
 * first launch, so there is **no build-time directory that becomes the runtime
 * cwd** — the values have to be bundled with the app. This script produces the
 * bundled artifact; `www/nodejs/index.js` copies it into place at boot.
 *
 * ## A client carries no seed — ever
 *
 * `--peer-id` is the normal case, and the peer ID is public information: a client
 * dials it and never needs the key behind it. `--seed-hex`/`--words-file` exist only
 * to DERIVE that peer ID (from a seed, or from a 24-word BIP-39 phrase) so it does
 * not have to be copied by hand; the seed is held in memory for that one derivation
 * and is NEVER written. No input makes this script emit `BOOTSTRAP_SEED_HEX`, and
 * the core's `loadBootstrapClientEnv()` REFUSES a client file that carries one —
 * a seed in a client config is a leaked private key.
 *
 * It depends only on `@p2p-trust-stack/core`, which the embedded app already
 * installs — never on a sibling checkout of another repo.
 *
 * Run `npm run setup` first (it installs the packages this script imports).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_APP = path.join(ROOT, 'www', 'nodejs');
const DEFAULT_OUT = path.join(NODE_APP, 'bootstrap.env');

const USAGE = `
init-bootstrap — write www/nodejs/bootstrap.env

Usage:
  npm run init:bootstrap -- --host <dns-or-ip> --peer-id <12D3Koo...>
  npm run init:bootstrap -- --host <dns-or-ip> --seed-hex <64 hex chars>
  npm run init:bootstrap -- --host <dns-or-ip> --words-file <path>

Options:
  --host <dns-or-ip>   How the relay is reachable. REQUIRED.
  --peer-id <id>       The relay's libp2p peer ID (public information).
  --seed-hex <hex>     The relay's 32-byte Ed25519 seed; used ONLY to derive the
                       peer ID — never written to the file.
  --words-file <path>  A file holding the relay's 24-word BIP-39 phrase; likewise
                       used only to derive the peer ID.
  --tcp-port <n>       Default 4001.
  --ws-port <n>        Default 4002.
  --no-relay           Set BOOTSTRAP_ENABLE_RELAY=false.
  --out <path>         Default www/nodejs/bootstrap.env.
  --dry-run            Print what would be written; change nothing.
  --help               This text.

Notes:
  * Supplying --peer-id is the normal case: it is public, and needs no secret.
  * --seed-hex/--words-file are a convenience only: the peer ID is DERIVED from
    them and checked, so a mismatch fails here rather than at dial time. The seed
    is NEVER written — this is a client, and the core's client loader refuses a
    config that carries one.
  * Generating a NEW relay identity is not this script's job — use the
    p2p-trust-stack repo's \`npm run init:bootstrap -- --generate\`.
`;

function fail(message) {
  console.error(`\ninit-bootstrap: ${message}\n`);
  console.error(USAGE.trim());
  process.exit(1);
}

function parseArgs(argv) {
  const args = { tcpPort: 4001, wsPort: 4002, enableRelay: true, out: DEFAULT_OUT };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${a} needs a value`);
      i += 1;
      return value;
    };

    if (a === '--host') args.host = next();
    else if (a === '--peer-id') args.peerId = next();
    else if (a === '--seed-hex') args.seedHex = next();
    else if (a === '--words-file') args.wordsFile = next();
    else if (a === '--tcp-port') args.tcpPort = Number(next());
    else if (a === '--ws-port') args.wsPort = Number(next());
    else if (a === '--out') args.out = path.resolve(next());
    else if (a === '--no-relay') args.enableRelay = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else fail(`unknown argument "${a}"`);
  }
  return args;
}

/** The core package lives in the embedded app's node_modules, not this script's. */
async function loadCore() {
  const entry = path.join(
    NODE_APP,
    'node_modules/@p2p-trust-stack/core/dist/config/bootstrap-env.js',
  );
  if (!fs.existsSync(entry)) {
    fail(
      '@p2p-trust-stack/core is not installed yet.\n' +
        'Run `npm install` then `npm run setup`, and try again.',
    );
  }
  return import(pathToFileURL(entry).href);
}

async function mnemonicToSeed(phrase) {
  const entry = path.join(
    NODE_APP,
    'node_modules/@p2p-trust-stack/core/dist/crypto/seed-phrase.js',
  );
  const mod = await import(pathToFileURL(entry).href);
  return mod.mnemonicToSeed(phrase);
}

/**
 * Work out the peer ID to write.
 *
 * `--peer-id` is the normal case and needs no secret: a client dials a peer ID,
 * it does not need the key behind it. `--seed-hex`/`--words-file` are accepted
 * only so the peer ID can be DERIVED (and checked against a supplied one); the
 * seed itself is never returned, so it can never reach the file.
 */
async function resolveIdentity(args) {
  const core = await loadCore();

  if (args.peerId) {
    if (!/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(args.peerId)) {
      fail(`"${args.peerId}" does not look like an Ed25519 libp2p peer ID (12D3KooW…, 52 chars)`);
    }
    // No seed: a client dials a peer ID and never needs the key behind it. Writing
    // one — even a placeholder — makes the file unloadable for the core's CLIENT
    // loader, which refuses a seed on sight.
    return { peerId: args.peerId, derived: false };
  }

  let seedHex = args.seedHex;
  if (!seedHex && args.wordsFile) {
    const file = path.resolve(args.wordsFile);
    const phrase = fs.readFileSync(file, 'utf8').trim();
    if (!phrase) fail(`${file} is empty`);
    try {
      seedHex = Buffer.from(await mnemonicToSeed(phrase)).toString('hex');
    } catch (err) {
      fail(`could not read the phrase in ${file}: ${err.message}`);
    }
  }

  if (!seedHex) fail('one of --peer-id, --seed-hex or --words-file is required');
  if (!core.isHex64(seedHex)) fail('--seed-hex must be 64 hex characters (32 bytes)');

  // Only ever used to derive + check the peer ID; nothing here is written out.
  const env = {
    version: 1,
    seedHex: seedHex.toLowerCase(),
    peerId: '',
    host: args.host,
    tcpPort: args.tcpPort,
    wsPort: args.wsPort,
    enableRelay: args.enableRelay,
  };

  // Derives the peer ID; throws if a peer ID were set and disagreed.
  const peerId = await core.verifyBootstrapEnv(env);
  return { peerId, derived: true };
}

function render({ host, peerId, tcpPort, wsPort, enableRelay }) {
  return `# ── Bootstrap / relay server this agent registers with ────────────────────────
#
# Generated by \`npm run init:bootstrap\`. This file is BUNDLED INTO THE APP: the
# Node entry reads it at boot and writes it to <app data>/runtime/.env, which is
# the \`<cwd>/.env\` that \`@p2p-trust-stack/core\`'s \`loadBootstrapClientEnv()\` reads.
#
# NOTE the name: \`bootstrap.env\`, not \`.env\`, on purpose. Capacitor's Android
# \`ignoreAssetsPattern\` includes \`.*\`, so a dotfile in the web assets is stripped
# from the APK and would never reach the device.

# There is NO BOOTSTRAP_SEED_HEX here, and there must never be one: this is a
# CLIENT, so it holds no key material. It dials a peer ID and does not need the key
# behind it, and the core's \`loadBootstrapClientEnv()\` REFUSES to load a client
# config that carries a seed — a seed in a client file is a leaked private key.

# The relay's libp2p peer ID. Public information — this is what a client dials,
# and libp2p verifies it against the key the server presents on connect.
BOOTSTRAP_PEER_ID=${peerId}

# How the relay is reachable.
BOOTSTRAP_HOST=${host}
BOOTSTRAP_TCP_PORT=${tcpPort}
BOOTSTRAP_WS_PORT=${wsPort}
BOOTSTRAP_ENABLE_RELAY=${enableRelay}

# ── Logging (optional) ──
# Read at boot by \`config/logging-env.ts\`, so verbosity lives HERE rather than in a
# package.json script — \`P2PTS_LOG_LEVEL=info node …\` is POSIX-only syntax that
# PowerShell and cmd cannot parse, and this app has no npm start script at all (the
# Capacitor plugin launches the Node runtime). This is the only place to set it.
#
# silent | error | warn | info | debug      (default: warn)
P2PTS_LOG_LEVEL=info
# 1 turns on the [CEREMONY] OOBI→RFI→RFA trace lines (independent of the level).
CEREMONY_TRACE=1
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return;
  }
  if (!args.host) fail('--host is required');

  const identity = await resolveIdentity(args);
  const contents = render({ ...args, ...identity });

  if (args.dryRun) {
    console.log(`--- would write ${path.relative(ROOT, args.out)} ---\n`);
    console.log(contents);
    return;
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, contents, 'utf8');

  // Show the URLs the core will build, so a wrong host or peer ID is obvious.
  // No `seedHex` — a client has none, and `buildBootstrapUrls()` never reads it:
  // the dial address is host + peer ID + ports.
  const core = await loadCore();
  const urls = core.buildBootstrapUrls({
    version: 1,
    peerId: identity.peerId,
    host: args.host,
    tcpPort: args.tcpPort,
    wsPort: args.wsPort,
    enableRelay: args.enableRelay,
  });

  console.log(`wrote ${path.relative(ROOT, args.out)}`);
  console.log(`  peer id : ${identity.peerId}${identity.derived ? ' (derived)' : ''}`);
  console.log(`  tcp     : ${urls.tcpUrl}`);
  console.log(`  ws      : ${urls.wsUrl}`);
  console.log(`  relay   : ${urls.relayAddr}`);
  console.log('\nRebuild the app for this to take effect: npm run android:build');
}

await main();

