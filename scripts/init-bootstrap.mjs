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
 * `@p2p-trust-stack/core`'s `loadBootstrapEnv()` reads a `.env` at
 * `process.cwd()`. On a phone that directory is app-private storage created on
 * first launch, so there is **no build-time directory that becomes the runtime
 * cwd** — the values have to be bundled with the app. This script produces the
 * bundled artifact; `www/nodejs/index.js` copies it into place at boot.
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

/** The seed a client never uses — see the comment in bootstrap.env. */
const PLACEHOLDER_SEED = '0'.repeat(64);

const USAGE = `
init-bootstrap — write www/nodejs/bootstrap.env

Usage:
  npm run init:bootstrap -- --host <dns-or-ip> --peer-id <12D3Koo...>
  npm run init:bootstrap -- --host <dns-or-ip> --seed-hex <64 hex chars>
  npm run init:bootstrap -- --host <dns-or-ip> --words-file <path>

Options:
  --host <dns-or-ip>   How the relay is reachable. REQUIRED.
  --peer-id <id>       The relay's libp2p peer ID (public information).
  --seed-hex <hex>     The relay's 32-byte Ed25519 seed; the peer ID is derived.
  --words-file <path>  A file holding the relay's 24-word BIP-39 phrase.
  --tcp-port <n>       Default 4001.
  --ws-port <n>        Default 4002.
  --no-relay           Set BOOTSTRAP_ENABLE_RELAY=false.
  --out <path>         Default www/nodejs/bootstrap.env.
  --dry-run            Print what would be written; change nothing.
  --help               This text.

Notes:
  * Supplying --peer-id is the normal case: it is public, and needs no secret.
    The seed is written as a placeholder because a client never reads it.
  * Supplying --seed-hex or --words-file derives the peer ID from it and verifies
    the two agree, so a mismatch fails here rather than at dial time.
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
 * Work out the seed + peer ID pair to write.
 *
 * `--peer-id` is the normal case and needs no secret: a client dials a peer ID,
 * it does not need the key behind it. The seed is only read when you supply one
 * (or a phrase), in which case the peer ID is derived from it and checked.
 */
async function resolveIdentity(args) {
  const core = await loadCore();

  if (args.peerId) {
    if (!/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(args.peerId)) {
      fail(`"${args.peerId}" does not look like an Ed25519 libp2p peer ID (12D3KooW…, 52 chars)`);
    }
    return { seedHex: PLACEHOLDER_SEED, peerId: args.peerId, derived: false };
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
  return { seedHex: env.seedHex, peerId, derived: true };
}

function render({ host, seedHex, peerId, tcpPort, wsPort, enableRelay, derived }) {
  const seedNote = derived
    ? '#\n# This is the REAL seed, because one was supplied with --seed-hex/--words-file.\n# Do not commit it to a public repository.'
    : "#\n# This is a PLACEHOLDER, so the relay's real (private) seed is never committed to\n# this public repo. If a future core version starts calling `verifyBootstrapEnv()`,\n# this will fail loudly with a peer-ID mismatch — regenerate with `--seed-hex`.";

  return `# ── Bootstrap / relay server this agent registers with ────────────────────────
#
# Generated by \`npm run init:bootstrap\`. This file is BUNDLED INTO THE APP: the
# Node entry reads it at boot and writes it to <app data>/runtime/.env, which is
# the \`<cwd>/.env\` that \`@p2p-trust-stack/core\`'s \`loadBootstrapEnv()\` reads.
#
# NOTE the name: \`bootstrap.env\`, not \`.env\`, on purpose. Capacitor's Android
# \`ignoreAssetsPattern\` includes \`.*\`, so a dotfile in the web assets is stripped
# from the APK and would never reach the device.

# The relay's 32-byte Ed25519 seed (64 hex chars). The core's loader REQUIRES this
# key to be present and well-formed, but a CLIENT never uses its value: the
# bootstrap URL is built from BOOTSTRAP_HOST + BOOTSTRAP_PEER_ID + the ports only
# (\`buildBootstrapUrls()\`), and \`verifyBootstrapEnv()\` — the one function that
# would compare seed against peer ID — is never called on the client path.
${seedNote}
BOOTSTRAP_SEED_HEX=${seedHex}

# The relay's libp2p peer ID. Public information — this is what a client dials,
# and libp2p verifies it against the key the server presents on connect.
BOOTSTRAP_PEER_ID=${peerId}

# How the relay is reachable.
BOOTSTRAP_HOST=${host}
BOOTSTRAP_TCP_PORT=${tcpPort}
BOOTSTRAP_WS_PORT=${wsPort}
BOOTSTRAP_ENABLE_RELAY=${enableRelay}
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
  const core = await loadCore();
  const urls = core.buildBootstrapUrls({
    version: 1,
    seedHex: identity.seedHex,
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

