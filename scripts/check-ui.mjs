#!/usr/bin/env node
/**
 * check-ui — load the WebView script in a minimal DOM stub and fail on any
 * error thrown at load time.
 *
 * `node --check` only validates syntax; it cannot see an undeclared identifier
 * that is only read inside a function. This actually *runs* `www/main.js` against
 * a stubbed DOM and a stubbed Capacitor plugin, which executes the boot path
 * (`setBusy`, `renderAgentPicker`, `showScreen`, `handshake`) and therefore
 * catches exactly that class of bug.
 *
 * Run via `npm run check` (also part of `npm run setup`).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional path override, so the checker itself can be exercised against a
// deliberately broken copy.
const target = process.argv[2] ?? path.join(ROOT, 'www', 'main.js');
const source = fs.readFileSync(target, 'utf8');

/** A DOM element good enough for anything main.js does. */
function element(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    dataset: {},
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    prepend(node) { el.children.unshift(node); },
    focus() {},
    scrollIntoView() {},
    closest() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

const byId = new Map();
const document = {
  getElementById(id) {
    if (!byId.has(id)) {
      const el = element();
      el.id = id;
      byId.set(id, el);
    }
    return byId.get(id);
  },
  querySelectorAll() { return []; },
  createElement(tag) { return element(tag); },
};

const listeners = [];
const Nodejs = {
  addListener(event, handler) { listeners.push({ event, handler }); return Promise.resolve(); },
  isReady: async () => ({ ready: false }),
  send: async () => {},
};

const sandbox = {
  document,
  window: { Capacitor: { Plugins: { Nodejs } } },
  console,
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'www/main.js' });
} catch (err) {
  console.error(`✗ www/main.js threw at load: ${err.message}`);
  process.exit(1);
}

// The script must have wired the bridge and the menu.
const events = listeners.map((l) => l.event);
if (!events.includes('message')) {
  console.error('✗ www/main.js did not subscribe to the "message" bridge event');
  process.exit(1);
}

console.log(`✓ www/main.js loads cleanly (listeners: ${events.join(', ')})`);
