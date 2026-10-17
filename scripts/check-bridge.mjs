#!/usr/bin/env node

// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * check-bridge — verify the WebView and the embedded Node app agree on the
 * bridge protocol.
 *
 * Both sides name events as plain strings, so a typo on either side is a silent
 * no-op at runtime (the message is delivered and dropped). This compares the two
 * sides statically and fails the build instead.
 *
 * Run via `npm run check` (also part of `npm run setup`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const nodeSrc = read('www/nodejs/index.js');
const uiSrc = read('www/main.js');

const matchAll = (source, re) => [...source.matchAll(re)].map((m) => m[1]);

/** Events the Node app listens for (`channel.on('x', …)`). */
const nodeHandlers = matchAll(nodeSrc, /channel\.on\('([^']+)'/g);
/** Events the Node app emits (`send('x', …)`), plus the two built-in channels. */
const nodeEmits = [...new Set([...matchAll(nodeSrc, /\bsend\('([^']+)'/g), 'status'])];

/** Events the UI sends: the screen→event table plus any direct `send('x')`. */
const eventTable = Object.fromEntries(
  [...uiSrc.matchAll(/^\s{2}(\w+): '([^']+)',/gm)].map((m) => [m[1], m[2]]),
);
const directSends = matchAll(uiSrc, /\bsend\('([^']+)'/g);
const uiEventsSent = [...new Set([...Object.values(eventTable), ...directSends])];

/** Events the UI handles (`case 'x':`). */
const uiCases = matchAll(uiSrc, /case '([^']+)'/g);

const problems = [];

// 1. Every event the UI sends must have a Node handler.
for (const event of uiEventsSent) {
  if (!nodeHandlers.includes(event)) {
    problems.push(`UI sends "${event}" but the Node app has no channel.on('${event}') handler`);
  }
}

// 2. Every event the Node app emits should be handled by the UI (warn, not fail:
//    a UI may legitimately ignore events it does not render).
const ignored = nodeEmits.filter((event) => !uiCases.includes(event));

// 3. Every screen that has a submit button must be mapped to an event.
const screens = matchAll(read('www/index.html'), /id="screen-(\w+)"/g);
for (const screen of screens) {
  if (screen === 'info') continue; // refreshed by a button, not a form submit
  if (!eventTable[screen]) problems.push(`screen "${screen}" has no entry in EVENT_FOR_SCREEN`);
}

console.log(`node handlers : ${nodeHandlers.join(', ')}`);
console.log(`node emits    : ${nodeEmits.join(', ')}`);
console.log(`ui sends      : ${uiEventsSent.join(', ')}`);
console.log(`ui handles    : ${uiCases.join(', ')}`);
if (ignored.length) console.log(`ui ignores    : ${ignored.join(', ')} (ok)`);

if (problems.length) {
  console.error('\nBridge protocol mismatch:');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('\n✓ bridge protocol consistent');
