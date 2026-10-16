#!/usr/bin/env node
/**
 * run-android — install the debug APK on a connected device/emulator, launch it,
 * and stream the embedded runtime's output.
 *
 * Usage:
 *   node scripts/run-android.mjs              # install + launch + tail logs
 *   node scripts/run-android.mjs --logs-only  # just tail logs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const APP_ID = 'com.truststackers.agentappmobile';
const ACTIVITY = `${APP_ID}/.MainActivity`;
const logsOnly = process.argv.includes('--logs-only');

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), 'Library', 'Android', 'sdk');
const adb = path.join(sdk, 'platform-tools', 'adb');

function sh(args, opts = {}) {
  return execFileSync(adb, args, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe' });
}

if (!fs.existsSync(adb)) {
  console.error(`adb not found at ${adb}. Set ANDROID_HOME.`);
  process.exit(1);
}

const devices = sh(['devices']).split('\n').filter((l) => /\tdevice$/.test(l));
if (devices.length === 0) {
  console.error('No device or emulator connected. Start one first.');
  process.exit(1);
}
console.log(`device: ${devices[0].split('\t')[0]}`);

if (!logsOnly) {
  if (!fs.existsSync(APK)) {
    console.error(`APK not found at ${APK}. Run \`npm run android:build\` first.`);
    process.exit(1);
  }
  console.log(`installing ${path.basename(APK)} (${(fs.statSync(APK).size / 1e6).toFixed(0)} MB)…`);
  sh(['install', '-r', APK], { inherit: true });

  sh(['shell', 'am', 'force-stop', APP_ID]);
  sh(['logcat', '-c']);
  sh(['shell', 'am', 'start', '-n', ACTIVITY]);
  console.log('launched. streaming logs (Ctrl-C to stop)…\n');
}

execFileSync(adb, ['logcat', '-s', 'NodejsPlugin'], { stdio: 'inherit' });
