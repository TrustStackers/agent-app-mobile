#!/usr/bin/env node
/**
 * setup — prepare everything the Android build needs.
 *
 *   1. (optional) build + pack `@p2p-trust-stack/{core,app-api}` into `vendor/`
 *   2. install the embedded Node app's dependencies (`www/nodejs`)
 *   3. replace the native `@node-rs/argon2` with the pure-JS shim
 *   4. patch the Capacitor Node.js plugin's CMakeLists for C++20
 *   5. smoke-test the assembled tree on the host
 *
 * Every step is idempotent, so it is safe to re-run.
 *
 * Usage:
 *   node scripts/setup.mjs                      # uses the tarballs already in vendor/
 *   node scripts/setup.mjs --rebuild-packages   # rebuild + repack from the checkout first
 *
 * Env:
 *   P2PTS_PACKAGES_DIR   path to the p2p-trust-stack checkout (default below)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_APP = path.join(ROOT, 'www', 'nodejs');
const VENDOR = path.join(ROOT, 'vendor');
const SHIM = path.join(ROOT, 'patches', 'argon2-shim');

const PACKAGES_DIR = process.env.P2PTS_PACKAGES_DIR ?? '/Users/shannon/p2pts';
const rebuildPackages = process.argv.includes('--rebuild-packages');

const CORE_TARBALL = 'p2p-trust-stack-core-0.1.0.tgz';
const APP_API_TARBALL = 'p2p-trust-stack-app-api-0.1.0.tgz';

function step(n, total, message) {
  console.log(`\n[${n}/${total}] ${message}`);
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1. Vendor the trust-stack packages
// ---------------------------------------------------------------------------

function vendorPackages() {
  const present = [CORE_TARBALL, APP_API_TARBALL].every((f) => fs.existsSync(path.join(VENDOR, f)));
  if (present && !rebuildPackages) {
    console.log(`  using the tarballs already in vendor/`);
    return;
  }

  if (!fs.existsSync(PACKAGES_DIR)) {
    throw new Error(
      `The p2p-trust-stack checkout was not found at ${PACKAGES_DIR}.\n` +
        `Set P2PTS_PACKAGES_DIR to point at it, or drop pre-built tarballs into vendor/.\n` +
        `(Once @p2p-trust-stack/* is published, replace the file: specs in ` +
        `www/nodejs/package.json with version ranges and this step disappears.)`,
    );
  }

  console.log(`  building the packages in ${PACKAGES_DIR}`);
  run('npm', ['install', '--no-audit', '--no-fund'], PACKAGES_DIR);
  run('npm', ['run', 'build'], PACKAGES_DIR);

  fs.mkdirSync(VENDOR, { recursive: true });
  for (const pkg of ['core', 'app-api']) {
    const dir = path.join(PACKAGES_DIR, 'packages', pkg);
    console.log(`  packing ${pkg}`);
    // `npm pack` runs prepublishOnly -> build, and writes into VENDOR.
    run('npm', ['pack', '--pack-destination', VENDOR], dir);
  }
}

// ---------------------------------------------------------------------------
// 2 + 3. Install the embedded app's dependencies, then swap in the argon2 shim
// ---------------------------------------------------------------------------

function installNodeApp() {
  console.log(`  npm install in www/nodejs`);
  run('npm', ['install', '--no-audit', '--no-fund'], NODE_APP);

  const modules = path.join(NODE_APP, 'node_modules');
  const argon2 = path.join(modules, '@node-rs', 'argon2');

  // Drop the native package and any platform binaries npm pulled in.
  for (const entry of fs.readdirSync(path.join(modules, '@node-rs'))) {
    if (entry === 'argon2' || entry.startsWith('argon2-')) {
      rmrf(path.join(modules, '@node-rs', entry));
    }
  }

  // Install the pure-JS shim in its place.
  fs.cpSync(SHIM, argon2, { recursive: true });
  console.log(`  replaced @node-rs/argon2 with the pure-JS shim`);
}

// ---------------------------------------------------------------------------
// 4. Point the Android build at the Node 24 runtime
// ---------------------------------------------------------------------------

/**
 * The plugin embeds nodejs-mobile 18.20.4 by default, which has no
 * `node:sqlite` — and the whole trust stack needs it. `@capawesome/capacitor-nodejs`
 * downloads its runtime at Gradle build time and honours these two project
 * variables, so we override them to the revived Node 24 build.
 *
 * Skipped until `npx cap add android` has created `android/variables.gradle`.
 */
const NODE24_RUNTIME = {
  url: 'https://github.com/gmaclennan/nodejs-mobile/releases/download/v24.18.0-0/nodejs-mobile-android-24.18.0-0.zip',
  sha256: 'ceb86b0b8130006195a60cd37393ebe0fd665b644ce8d5674dfba1da65d3be28',
};

function configureAndroidRuntime() {
  const gradle = path.join(ROOT, 'android', 'variables.gradle');

  if (!fs.existsSync(gradle)) {
    console.log('  android/variables.gradle not found — run `npx cap add android`, then re-run setup');
    return;
  }

  const source = fs.readFileSync(gradle, 'utf8');
  if (source.includes('nodejsMobileAndroidUrl')) {
    console.log('  runtime already configured');
    return;
  }

  const close = source.lastIndexOf('}');
  if (close === -1) throw new Error('Unexpected variables.gradle layout.');

  const block = [
    '',
    '    // Node 24 runtime (see README). The plugin defaults to nodejs-mobile 18.20.4,',
    '    // which has no `node:sqlite` — required by @p2p-trust-stack/core.',
    `    nodejsMobileAndroidUrl = '${NODE24_RUNTIME.url}'`,
    `    nodejsMobileAndroidSha256 = '${NODE24_RUNTIME.sha256}'`,
    '',
  ].join('\n');

  fs.writeFileSync(gradle, source.slice(0, close) + block + source.slice(close), 'utf8');
  console.log('  configured android/variables.gradle for the Node 24 runtime');
}

// ---------------------------------------------------------------------------
// 5. Patch the Capacitor Node.js plugin for C++20
// ---------------------------------------------------------------------------

/**
 * Node ≥ 22 ships V8 headers that hard-require C++20 (`v8config.h`:
 * `"C++20 or later required."`), but the plugin's CMakeLists sets no standard,
 * so the NDK clang default (C++17) fails with ~20 errors. Insert the standard
 * after `project(...)`. Idempotent; reported upstream as a bug.
 */
function patchPlugin() {
  const cmake = path.join(
    ROOT,
    'node_modules',
    '@capawesome',
    'capacitor-nodejs',
    'android',
    'CMakeLists.txt',
  );

  if (!fs.existsSync(cmake)) {
    throw new Error(
      `Plugin CMakeLists not found at ${cmake}. Run \`npm install\` at the repo root first.`,
    );
  }

  const source = fs.readFileSync(cmake, 'utf8');
  if (source.includes('CMAKE_CXX_STANDARD')) {
    console.log('  already patched');
    return;
  }

  const marker = 'project(capacitor-nodejs)';
  if (!source.includes(marker)) {
    throw new Error(`Unexpected CMakeLists layout — cannot find "${marker}".`);
  }

  const block = [
    '',
    '# Required for Node >= 22: its V8 headers need C++20. Upstream sets no',
    '# standard, so the NDK clang default (C++17) fails to compile them.',
    'set(CMAKE_CXX_STANDARD 20)',
    'set(CMAKE_CXX_STANDARD_REQUIRED ON)',
    'set(CMAKE_CXX_EXTENSIONS OFF)',
    '',
  ].join('\n');

  fs.writeFileSync(cmake, source.replace(marker, marker + '\n' + block), 'utf8');
  console.log('  patched android/CMakeLists.txt for C++20');
}

// ---------------------------------------------------------------------------
// 5. Smoke-test the assembled tree on the host
// ---------------------------------------------------------------------------

function verify() {
  const modules = path.join(NODE_APP, 'node_modules');
  const checks = [
    ['app-api barrel', path.join(modules, '@p2p-trust-stack', 'app-api', 'dist', 'index.js')],
    ['core dist', path.join(modules, '@p2p-trust-stack', 'core', 'dist', 'db', 'connection.js')],
    ['core migrations', path.join(modules, '@p2p-trust-stack', 'core', 'migrations')],
    ['core SCHEMA_VERSION', path.join(modules, '@p2p-trust-stack', 'core', 'SCHEMA_VERSION')],
    ['argon2 shim', path.join(modules, '@node-rs', 'argon2', 'index.js')],
  ];
  for (const [label, target] of checks) {
    if (!fs.existsSync(target)) throw new Error(`Missing ${label}: ${target}`);
    console.log(`  ✓ ${label}`);
  }

  // The relay config is bundled into the app. Without it the agent boots but
  // silently never registers, so fail here rather than at runtime.
  const bootstrapEnv = path.join(NODE_APP, 'bootstrap.env');
  if (!fs.existsSync(bootstrapEnv)) {
    throw new Error(
      `Missing ${bootstrapEnv}. Generate it with:\n` +
        '  npm run init:bootstrap -- --host <dns-or-ip> --peer-id <12D3Koo...>',
    );
  }
  const relayEnv = fs.readFileSync(bootstrapEnv, 'utf8');
  for (const key of ['BOOTSTRAP_SEED_HEX', 'BOOTSTRAP_PEER_ID', 'BOOTSTRAP_HOST']) {
    if (!new RegExp(`^${key}=\\S`, 'm').test(relayEnv)) {
      throw new Error(`${bootstrapEnv} has no value for ${key}`);
    }
  }
  const relayHost = /^BOOTSTRAP_HOST=(.+)$/m.exec(relayEnv)[1].trim();
  console.log(`  ✓ bootstrap.env → relay ${relayHost}`);

  // The shim must be the pure-JS one, not the native package.
  const shimPkg = JSON.parse(
    fs.readFileSync(path.join(modules, '@node-rs', 'argon2', 'package.json'), 'utf8'),
  );
  if (shimPkg.version !== '0.0.0-shim') {
    throw new Error(`@node-rs/argon2 is not the shim (version ${shimPkg.version}).`);
  }
  console.log('  ✓ @node-rs/argon2 is the shim');

  // Load the stack the way the embedded app will, and exercise the KDF.
  const smoke = `
    const { createAgentStack, createNodeHost, API_VERSION } = await import('@p2p-trust-stack/app-api');
    const { encodeOobi } = await import('@p2p-trust-stack/core/relationship/oobi.js');
    const { hashRaw, Algorithm } = await import('@node-rs/argon2');
    const t0 = Date.now();
    const out = await hashRaw('correct horse battery staple', {
      salt: new Uint8Array(16).fill(7), outputLen: 32,
      algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
    });
    if (!(out instanceof Uint8Array) || out.length !== 32) throw new Error('shim returned ' + out);
    console.log('  ✓ app-api ' + API_VERSION + ', encodeOobi ' + typeof encodeOobi
      + ', argon2 shim -> ' + out.length + ' bytes in ' + (Date.now() - t0) + 'ms');
  `;
  run(process.execPath, ['--input-type=module', '-e', smoke], NODE_APP);
}

// ---------------------------------------------------------------------------

function main() {
  console.log('Preparing agent-app-mobile');
  step(1, 6, 'Vendoring @p2p-trust-stack/{core,app-api}');
  vendorPackages();
  step(2, 6, 'Installing the embedded Node app dependencies');
  installNodeApp();
  step(3, 6, 'Configuring the Android runtime (Node 24)');
  configureAndroidRuntime();
  step(4, 6, 'Patching the Capacitor Node.js plugin (C++20)');
  patchPlugin();
  step(5, 6, 'Verifying the assembled tree');
  verify();
  step(6, 6, 'Checking the WebView ↔ Node bridge protocol and the UI script');
  run('npm', ['run', 'check'], ROOT);
  console.log('\nNext: npm run android:build   (then npm run android:run)');
}

main();

