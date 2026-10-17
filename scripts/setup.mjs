#!/usr/bin/env node
/**
 * setup — prepare the native builds.
 *
 *   1. install the embedded Node app's dependencies (`www/nodejs`)
 *   2. replace the native `@node-rs/argon2` with the pure-JS shim
 *   3. point the Android build at the Node 24 runtime
 *   4. point the iOS build at the Node 24 runtime, and at C++20
 *   5. smoke-test the assembled tree on the host
 *
 * Every step is idempotent, so it is safe to re-run.
 *
 * Usage:
 *   node scripts/setup.mjs         # everything (the iOS steps run once ios/ exists)
 *   node scripts/setup.mjs --ios   # force the iOS steps before `ios/` exists
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_APP = path.join(ROOT, 'www', 'nodejs');
const SHIM = path.join(ROOT, 'patches', 'argon2-shim');

/** Force the iOS steps even before `ios/` exists (used by `npm run ios:init`). */
const forceIos = process.argv.includes('--ios');

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
// ---------------------------------------------------------------------------
// 1 + 2. Install the embedded app's dependencies, then swap in the argon2 shim
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
  major: 24,
};

/**
 * The plugin's Gradle build caches its runtime under a **fixed** directory name
 * and only re-extracts when `<dir>/include` is missing — so a cache left over
 * from the plugin's default (nodejs-mobile 18.20.4) is silently reused even
 * after the URL is changed. The build then succeeds and ships a runtime without
 * `node:sqlite`, and the failure only shows up on the device. Verify the cached
 * version and evict it when it is not the one we pin.
 */
function evictStaleAndroidRuntimeCache() {
  const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), '.gradle');
  const cacheRoot = path.join(gradleHome, 'caches', 'capawesome-capacitor-nodejs');
  if (!fs.existsSync(cacheRoot)) return;

  for (const entry of fs.readdirSync(cacheRoot)) {
    if (!entry.endsWith('-android')) continue;
    const header = path.join(cacheRoot, entry, 'include', 'node', 'node_version.h');
    const major = installedNodeMajor(header);
    if (major !== null && major !== NODE24_RUNTIME.major) {
      console.log(
        `  evicting the Gradle runtime cache (found Node ${major}, need ${NODE24_RUNTIME.major})`,
      );
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      return;
    }
  }
}

function configureAndroidRuntime() {
  const gradle = path.join(ROOT, 'android', 'variables.gradle');

  if (!fs.existsSync(gradle)) {
    console.log('  android/variables.gradle not found — run `npx cap add android`, then re-run setup');
    return;
  }

  // Checked on every run, not just the first: the cache is independent of
  // variables.gradle, and can go stale later (e.g. a build run before setup).
  evictStaleAndroidRuntimeCache();

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
// 4b. Point the iOS build at the Node 24 runtime
// ---------------------------------------------------------------------------

/**
 * The iOS runtime is a prebuilt `NodeMobile.xcframework` plus Node headers,
 * fetched into the plugin's `ios/libnode/`. It is the *same* Node 24 build the
 * Android side uses — see `configureAndroidRuntime` for why the version matters
 * (`node:sqlite`, added in Node 22.5, is absent from the plugin's 18.20.4).
 *
 * The plugin's own `postinstall` would fetch nodejs-mobile 18.20.4, and it does
 * honour `CAPACITOR_NODEJS_IOS_URL`/`_SHA256` — but those are read at
 * `npm install` time, which makes the override fragile and easy to lose.
 * Downloading here instead keeps the pinned URL + checksum in the repo, right
 * next to the Android equivalent.
 */
const NODE24_IOS = {
  url: 'https://github.com/gmaclennan/nodejs-mobile/releases/download/v24.18.0-0/nodejs-mobile-ios-24.18.0-0.zip',
  sha256: '849526f5861a235e97d4ecc7a3272f1d6bb63d324716dbe1cc2bb5019992257a',
  major: 24,
};

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The Node major version of an extracted runtime, from its headers.
 *
 * Existence is the wrong test: the plugin's own `postinstall` fetches
 * nodejs-mobile **18.20.4** and then *skips* whenever a framework is already
 * present. So on a fresh clone — where `npm install` runs before `setup` — a
 * "does it exist?" check would happily keep Node 18, and the app would only fail
 * much later, at runtime, with a confusing missing-`node:sqlite` error.
 */
function installedNodeMajor(versionHeader) {
  try {
    const match = /^#define NODE_MAJOR_VERSION (\d+)/m.exec(fs.readFileSync(versionHeader, 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function configureIosRuntime() {
  const libnode = path.join(ROOT, 'node_modules', '@capawesome', 'capacitor-nodejs', 'ios', 'libnode');
  const versionHeader = path.join(libnode, 'include', 'node', 'node_version.h');

  if (installedNodeMajor(versionHeader) === NODE24_IOS.major) {
    console.log(`  iOS runtime already installed (Node ${NODE24_IOS.major})`);
  } else {
    const found = installedNodeMajor(versionHeader);
    if (fs.existsSync(libnode)) {
      console.log(`  replacing the iOS runtime${found ? ` (found Node ${found})` : ''}`);
      fs.rmSync(libnode, { recursive: true, force: true });
    }

    const cacheDir = path.join(os.homedir(), '.cache', 'agent-app-mobile');
    const zipFile = path.join(cacheDir, 'nodejs-mobile-ios-24.18.0-0.zip');
    fs.mkdirSync(cacheDir, { recursive: true });

    if (!fs.existsSync(zipFile) || sha256(zipFile) !== NODE24_IOS.sha256) {
      console.log('  downloading the Node 24 iOS runtime (~37 MB)…');
      const response = await fetch(NODE24_IOS.url);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      fs.writeFileSync(zipFile, Buffer.from(await response.arrayBuffer()));

      const actual = sha256(zipFile);
      if (actual !== NODE24_IOS.sha256) {
        fs.rmSync(zipFile, { force: true });
        throw new Error(`checksum mismatch:\n  expected ${NODE24_IOS.sha256}\n  got      ${actual}`);
      }
    }

    fs.mkdirSync(libnode, { recursive: true });
    run('unzip', ['-q', '-o', zipFile, '-d', libnode], ROOT);
    console.log('  installed NodeMobile.xcframework + Node headers');
  }

  patchIosCxxStandard();
}

/**
 * Node ≥ 22 ships V8 headers that hard-require C++20 (`v8config.h`:
 * `#error "C++20 or later required."`), and the plugin's `Package.swift`
 * declares `.gnucxx17` — the iOS twin of the Android CMake fix.
 */
function patchIosCxxStandard() {
  const manifest = path.join(
    ROOT,
    'node_modules',
    '@capawesome',
    'capacitor-nodejs',
    'Package.swift',
  );
  const source = fs.readFileSync(manifest, 'utf8');

  if (source.includes('.gnucxx20')) {
    console.log('  Package.swift already patched');
    return;
  }
  if (!source.includes('cxxLanguageStandard: .gnucxx17')) {
    throw new Error('Unexpected Package.swift — cannot find "cxxLanguageStandard: .gnucxx17".');
  }

  fs.writeFileSync(
    manifest,
    source.replace('cxxLanguageStandard: .gnucxx17', 'cxxLanguageStandard: .gnucxx20'),
    'utf8',
  );
  console.log('  patched Package.swift for C++20');
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

async function main() {
  // The iOS runtime is only fetched when iOS is actually in play: either the
  // platform has been added, or `--ios` was passed (which `npm run ios:init`
  // does before `cap add ios`, so the framework exists for SPM to resolve).
  const iosRequested = forceIos || fs.existsSync(path.join(ROOT, 'ios'));

  const steps = [
    ['Installing the embedded Node app dependencies', installNodeApp],
    ['Configuring the Android runtime (Node 24)', configureAndroidRuntime],
    ...(iosRequested ? [['Configuring the iOS runtime (Node 24)', configureIosRuntime]] : []),
    ['Patching the Capacitor Node.js plugin (C++20)', patchPlugin],
    ['Verifying the assembled tree', verify],
    [
      'Checking the WebView ↔ Node bridge protocol and the UI script',
      () => run('npm', ['run', 'check'], ROOT),
    ],
  ];

  console.log('Preparing agent-app-mobile');
  for (let i = 0; i < steps.length; i += 1) {
    const [label, action] = steps[i];
    step(i + 1, steps.length, label);
    await action();
  }

  console.log('\nNext: npm run android:build   (or npm run ios:build)');
}

main().catch((err) => {
  console.error(`\nsetup failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

