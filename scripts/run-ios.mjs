#!/usr/bin/env node
/**
 * run-ios — build for a connected iPad/iPhone, install, launch, and stream the
 * embedded runtime's output.
 *
 * Usage:
 *   node scripts/run-ios.mjs              # build + install + launch + log
 *   node scripts/run-ios.mjs --build      # build only
 *   node scripts/run-ios.mjs --install    # install + launch, skip the build
 *   node scripts/run-ios.mjs --logs-only  # just pull the runtime log
 *
 * Environment:
 *   AGENT_APP_IOS_TEAM        signing team; inferred from the keychain if unset
 *   AGENT_APP_IOS_BUNDLE_ID   override the bundle identifier for this build
 *   AGENT_APP_IOS_LOG_WAIT    seconds to wait for boot before pulling the log
 *
 * Signing: Xcode must be signed in to the team's Apple ID;
 * `-allowProvisioningUpdates` then creates the provisioning profile on demand.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.join(ROOT, 'ios', 'App', 'App.xcodeproj');
const DERIVED = path.join(ROOT, 'ios', 'build');
const APP_BUNDLE = path.join(DERIVED, 'Build', 'Products', 'Debug-iphoneos', 'App.app');
const BUNDLE_ID = process.env.AGENT_APP_IOS_BUNDLE_ID ?? 'com.truststackers.agentappmobile';

const buildOnly = process.argv.includes('--build');
const skipBuild = process.argv.includes('--install');
const logsOnly = process.argv.includes('--logs-only');

function xcrun(args, opts = {}) {
  return execFileSync('xcrun', args, {
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
  });
}

/**
 * The connected device, from `devicectl`'s JSON output. Only a device with a
 * live tunnel can be installed to, which also filters out the simulators that
 * `list devices` reports alongside it.
 */
function findDevice() {
  const jsonPath = path.join(os.tmpdir(), 'agent-app-ios-devices.json');
  xcrun(['devicectl', 'list', 'devices', '--json-output', jsonPath]);

  const { result } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const device = result.devices.find((d) => d.connectionProperties.tunnelState === 'connected');
  if (!device) {
    console.error('No iPad/iPhone connected. Plug one in, unlock it, and trust this computer.');
    process.exit(1);
  }

  return {
    name: device.deviceProperties.name,
    udid: device.hardwareProperties.udid,
    developerMode: device.deviceProperties.developerModeStatus,
  };
}

/** Every "Apple Development" cert carries its team ID in the subject's OU. */
function appleDevelopmentTeams() {
  let pems;
  try {
    pems = execFileSync('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p'], {
      encoding: 'utf8',
    });
  } catch {
    return [];
  }

  const teams = new Set();
  for (const chunk of pems.split('-----END CERTIFICATE-----')) {
    if (!chunk.includes('BEGIN CERTIFICATE')) continue;
    try {
      const subject = execFileSync('openssl', ['x509', '-noout', '-subject'], {
        input: `${chunk}-----END CERTIFICATE-----\n`,
        encoding: 'utf8',
      });
      const match = /OU=([A-Z0-9]+)/.exec(subject);
      if (match) teams.add(match[1]);
    } catch {
      // Unparsable cert — skip it rather than failing the whole build.
    }
  }
  return [...teams];
}

/**
 * The paid team IDs Xcode knows about.
 *
 * Free teams issue 7-day provisioning profiles, so a paid team is the better
 * default when a machine is signed in to both. The value is a plist dump in
 * which each team is a `{ ... }` block holding `teamID` and
 * `isFreeProvisioningTeam` — both unquoted, so this matches on the raw text.
 */
function paidTeams() {
  const paid = new Set();
  try {
    const raw = execFileSync(
      'defaults',
      ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeamByIdentifier'],
      { encoding: 'utf8' },
    );
    for (const block of raw.split('}')) {
      const id = /teamID = ([A-Z0-9]+)/.exec(block);
      if (id && /isFreeProvisioningTeam = 0/.test(block)) paid.add(id[1]);
    }
  } catch {
    // Xcode has no stored teams — the caller falls back to asking.
  }
  return paid;
}

function detectTeam() {
  if (process.env.AGENT_APP_IOS_TEAM) return process.env.AGENT_APP_IOS_TEAM;

  const teams = appleDevelopmentTeams();
  if (teams.length === 1) return teams[0];

  if (teams.length > 1) {
    const paid = paidTeams();
    const preferred = teams.filter((id) => paid.has(id));
    if (preferred.length === 1) return preferred[0];

    console.error(`Multiple signing teams available: ${teams.join(', ')}`);
    console.error('Choose one, e.g.  AGENT_APP_IOS_TEAM=ABCDE12345 npm run ios:run');
    process.exit(1);
  }

  console.error('No "Apple Development" certificate found in the keychain.');
  console.error('Open Xcode → Settings → Accounts and add your Apple ID, then retry.');
  process.exit(1);
}

const device = findDevice();
console.log(`device : ${device.name} (${device.udid})`);

if (device.developerMode !== 'enabled') {
  console.error('\nDeveloper Mode is off on the device.');
  console.error('Enable it in Settings → Privacy & Security → Developer Mode, then restart the device.');
  process.exit(1);
}

const team = detectTeam();
console.log(`team   : ${team}`);

if (!skipBuild) {
  console.log('\nbuilding (this takes a few minutes the first time)…\n');
  execFileSync(
    'xcodebuild',
    [
      '-project', PROJECT,
      '-scheme', 'App',
      '-configuration', 'Debug',
      '-destination', `id=${device.udid}`,
      '-derivedDataPath', DERIVED,
      '-allowProvisioningUpdates',
      'build',
      `DEVELOPMENT_TEAM=${team}`,
      // A bundle identifier is unique across *all* teams, so the default in
      // capacitor.config.json is often already claimed (by a personal team, say).
      // Overriding it here keeps that a per-build choice rather than a repo edit.
      ...(process.env.AGENT_APP_IOS_BUNDLE_ID
        ? [`PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_ID}`]
        : []),
    ],
    { stdio: 'inherit' },
  );
}

if (buildOnly) {
  console.log(`\nbuilt: ${APP_BUNDLE}`);
  process.exit(0);
}

if (!fs.existsSync(APP_BUNDLE)) {
  console.error(`\nApp bundle not found at ${APP_BUNDLE}. Run \`npm run ios:build\` first.`);
  process.exit(1);
}

console.log('\ninstalling…');
xcrun(['devicectl', 'device', 'install', 'app', '--device', device.udid, APP_BUNDLE], {
  inherit: true,
});

/**
 * Pull the runtime's log file off the device.
 *
 * `devicectl device process launch --console` is the documented way to stream an
 * app's stdout, but it fails with CoreDeviceError 10002 here, so the runtime
 * mirrors every line to `Documents/runtime/agent.log` instead (see `log()` in
 * www/nodejs/index.js) and this reads it back.
 */
function pullLog() {
  const destination = path.join(DERIVED, 'agent.log');
  try {
    xcrun([
      'devicectl', 'device', 'copy', 'from',
      '--device', device.udid,
      '--domain-type', 'appDataContainer',
      '--domain-identifier', BUNDLE_ID,
      '--source', 'Documents/runtime/agent.log',
      '--destination', destination,
    ]);
    console.log(`\n──── agent.log ────\n${fs.readFileSync(destination, 'utf8')}───────────────────`);
  } catch (err) {
    console.error(`\nCould not pull agent.log (${String(err.message).split('\n')[0]}).`);
    console.error('The app may not have booted yet — retry with a larger AGENT_APP_IOS_LOG_WAIT.');
  }
}

if (logsOnly) {
  pullLog();
  process.exit(0);
}

console.log('\nlaunching…');
xcrun(['devicectl', 'device', 'process', 'launch', '--device', device.udid, BUNDLE_ID], {
  inherit: true,
});

const logWait = Number(process.env.AGENT_APP_IOS_LOG_WAIT ?? 15);
console.log(`\nwaiting ${logWait}s for the runtime to boot…`);
await new Promise((resolve) => setTimeout(resolve, logWait * 1000));
pullLog();
