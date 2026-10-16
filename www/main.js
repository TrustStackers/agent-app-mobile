/**
 * WebView side of the example.
 *
 * The UI talks to the trust stack exclusively through the Capacitor Node.js
 * bridge: it sends one event per action and renders the events the embedded Node
 * app posts back (`status`, then a terminal event). It never touches crypto,
 * SQLite or the network itself.
 *
 *   createVta  → created
 *   login      → loggedIn
 *   logout     → loggedOut
 *   setName    → nameSet
 *   lookupName → nameLookup
 *   getInfo    → info
 *   (any)      → error
 */
'use strict';

const $ = (id) => document.getElementById(id);

const runtimeEl = $('runtime');
const menuEl = $('menu');
const logEl = $('log');
const sessionEl = $('session');
const sessionNameEl = $('session-name');

const Nodejs = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Nodejs;

/** Whether the embedded Node runtime has completed the handshake. */
let nodeReady = false;
/** The active VTA, or null. Drives the session bar and which screens make sense. */
let activeVta = null;
/** Known VTAs on this device, for the login picker. */
let agents = [];
/** Whether an operation is running (the runtime is single-instance). */
let busy = false;
/** The most recent `info` payload — the delete confirmation reads the account list from it. */
let lastInfo = null;
/** Log line count — the first line clears the placeholder. */
let logged = 0;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function setRuntime(text, cls) {
  runtimeEl.textContent = text;
  runtimeEl.className = 'runtime' + (cls ? ' ' + cls : '');
}

function addLog(step, message, level) {
  if (logged === 0) logEl.innerHTML = '';
  logged += 1;

  const row = document.createElement('p');
  if (level && level !== 'info') row.className = level;

  const s = document.createElement('span');
  s.className = 'step';
  s.textContent = step || '';

  const m = document.createElement('span');
  m.className = 'msg';
  m.textContent = message || '';

  row.append(s, m);
  logEl.append(row);
}

function clearLog() {
  logged = 0;
  logEl.innerHTML = '';
}

const show = (value) =>
  Array.isArray(value) ? value.join('\n') : value === null || value === undefined ? '' : String(value);

/** Render a key/value list into a container. Skips empty values. */
function renderDl(container, rows, emptyText = 'No data.') {
  const present = rows.filter(([, value]) => show(value) !== '');
  if (present.length === 0) {
    container.innerHTML = `<p class="muted">${emptyText}</p>`;
    return;
  }

  const dl = document.createElement('dl');
  for (const [label, value] of present) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = show(value);
    dl.append(dt, dd);
  }
  container.innerHTML = '';
  container.append(dl);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function showScreen(name) {
  for (const button of menuEl.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.screen === name);
  }
  for (const screen of document.querySelectorAll('.screen')) {
    screen.hidden = screen.id !== `screen-${name}`;
  }
  if (name === 'login') {
    renderAgentPicker();
    // Ask for a fresh list: a VTA created earlier in this session may not be in
    // the cached `agents` yet.
    void send('listAgents');
  }
  if (name === 'info') void send('getInfo');
}

menuEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-screen]');
  if (button) showScreen(button.dataset.screen);
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function send(eventName, payload) {
  if (!nodeReady) return Promise.resolve();
  return Nodejs.send({ eventName, args: [payload ?? {}] }).catch((err) => {
    setBusy(false);
    addLog('bridge', `Could not reach the Node runtime: ${err && err.message}`, 'bad');
  });
}

/** Send without waiting for the handshake — used by the handshake itself. */
function sendRaw(eventName, payload) {
  return Nodejs.send({ eventName, args: [payload ?? {}] }).catch(() => {});
}

/**
 * Ask the Node app for its current state.
 *
 * The Node app announces itself at boot, but that message travels Capacitor's
 * event channel and is **dropped if the WebView has not attached its listener
 * yet** (Capacitor logs "No listeners found"). So the WebView also asks, once the
 * plugin reports the runtime is ready. Whichever happens first wins; both are
 * idempotent.
 */
async function handshake() {
  try {
    const { ready } = await Nodejs.isReady();
    if (ready) void sendRaw('hello');
  } catch {
    /* runtime not up yet — the plugin's `ready` event will call us again */
  }
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('button.primary')) {
    button.disabled = value || !nodeReady;
  }
  $('logout').disabled = value || !nodeReady || !activeVta;
}

function setSession(vta) {
  activeVta = vta;
  sessionEl.hidden = !vta;
  sessionNameEl.textContent = vta ? vta.name : '';
  setBusy(busy);
}

/** The login picker: one tap fills the username field. */
function renderAgentPicker() {
  const list = $('login-list');
  if (!nodeReady) {
    list.innerHTML = '<p class="muted">Waiting for the Node runtime…</p>';
    return;
  }
  if (agents.length === 0) {
    list.innerHTML = '<p class="muted">No VTAs on this device yet — create one first.</p>';
    return;
  }

  list.innerHTML = '';
  for (const agent of agents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick';
    button.textContent = agent.name;
    button.addEventListener('click', () => {
      $('login-name').value = agent.name;
      $('login-pass').focus();
    });
    list.append(button);
  }
}

// ---------------------------------------------------------------------------
// Result renderers
// ---------------------------------------------------------------------------

function identityRows(p) {
  return [
    ['Name', p.name],
    ['VID', p.vid],
    ['DID', p.did],
    ['Peer ID', p.peerId],
    ['Multiaddrs', p.multiaddrs],
    ['Utility server', p.utilityServer && p.utilityServer.peerId],
    ['Registered', p.pushed === undefined ? undefined : p.pushed ? 'yes' : 'queued'],
  ];
}

function renderNames(p) {
  const rows = [['Just registered', p.nameUri]];
  const all = (p.names || []).map((n) => n.nameUri);
  if (all.length > 0) rows.push(['All names', all]);
  renderDl($('name-list'), rows, 'No names registered yet.');
}

function renderLookup(p) {
  if (!p.resolved) {
    $('lookup-result').innerHTML = `<p class="muted">${p.nameUri} is not registered.</p>`;
    return;
  }
  renderDl($('lookup-result'), [
    ['Name', p.nameUri],
    ['DID', p.resolved.did],
    ['Peer ID', p.resolved.peerId],
    ['Multiaddrs', p.resolved.multiaddrs],
  ]);
}

function renderInfo(p) {
  lastInfo = p;
  const container = $('info-result');
  if (!p.active) {
    container.innerHTML = '<p class="muted">No VTA is active. Create one or log in.</p>';
    return;
  }

  const id = p.identity || {};
  const c = p.connectivity || {};
  renderDl(container, [
    ['Name', id.name],
    ['VID', id.vid],
    ['DID', id.did],
    ['Peer ID', id.peerId],
    ['Method', id.method],
    ['Multiaddrs', id.multiaddrs],
    ['Bootstrap', c.bootstrapConnected ? 'connected' : 'not connected'],
    ['Utility server', c.utilityServer ? c.utilityServer.peerId : 'not discovered'],
    ['Utility link', c.utilityServerConnected ? 'connected' : 'not connected'],
    ['Relay', c.relayAddr],
    ['Peers on mediator', c.peerCount],
    ['Names', (p.names || []).map((n) => n.nameUri)],
    ['Accounts on this device', (p.agents || []).map((a) => a.name)],
  ]);
}

// ---------------------------------------------------------------------------
// Confirmation modal (destructive actions ask twice)
// ---------------------------------------------------------------------------

let pendingConfirm = null;

function confirmAction({ title, body, confirmLabel, onConfirm }) {
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = confirmLabel;
  pendingConfirm = onConfirm;
  $('confirm').hidden = false;
}

function closeConfirm() {
  $('confirm').hidden = true;
  pendingConfirm = null;
}

$('confirm-cancel').addEventListener('click', closeConfirm);

$('confirm-ok').addEventListener('click', () => {
  const action = pendingConfirm;
  closeConfirm();
  if (action) action();
});

$('clear-accounts').addEventListener('click', () => {
  const names = ((lastInfo && lastInfo.agents) || agents).map((a) => a.name);

  if (names.length === 0) {
    addLog('clear', 'There are no VTAs on this device.', 'warn');
    return;
  }

  confirmAction({
    title: 'Delete all accounts?',
    body:
      `This permanently deletes ${names.length} VTA${names.length === 1 ? '' : 's'} ` +
      `(${names.join(', ')}) — their identities, private keys and databases. ` +
      'It cannot be undone and there is no recovery.',
    confirmLabel: `Delete ${names.length}`,
    onConfirm: () => {
      clearLog();
      setBusy(true);
      void send('clearAccounts');
    },
  });
});

// ---------------------------------------------------------------------------
// Bridge events
// ---------------------------------------------------------------------------

/** Show the info screen for a VTA we just activated. */
function showIdentity(p) {
  setSession(p);
  renderDl($('info-result'), identityRows(p), 'No data.');
  showScreen('info');
  void send('getInfo'); // fills in the connectivity rows
}

function handleMessage(event) {
  const p = (event.args && event.args[0]) || {};

  switch (event.eventName) {
    case 'ready':
    case 'hello':
      nodeReady = true;
      agents = p.agents || [];
      setRuntime(`Embedded Node runtime ready · ${p.node}`, 'ok');
      setBusy(false);
      break;

    case 'status':
      addLog(p.step, p.message, p.level);
      break;

    case 'agents':
      agents = p.agents || [];
      renderAgentPicker();
      break;

    case 'created':
      $('create-pass').value = '';
      agents = p.agents || agents;
      addLog('done', `${p.name} created and registered`, 'ok');
      showIdentity(p);
      break;

    case 'loggedIn':
      $('login-pass').value = '';
      addLog('done', `logged in as ${p.name}`, 'ok');
      showIdentity(p);
      break;

    case 'loggedOut':
      setSession(null);
      agents = p.agents || [];
      addLog('done', 'logged out', 'ok');
      setBusy(false);
      showScreen('login');
      break;

    case 'accountsCleared':
      setSession(null);
      agents = p.agents || [];
      lastInfo = null;
      addLog('clear', `deleted ${(p.deleted || []).length} VTA(s)`, 'ok');
      setBusy(false);
      showScreen('create');
      break;

    case 'nameSet':
      setBusy(false);
      renderNames(p);
      addLog('done', `${p.nameUri} registered`, 'ok');
      break;

    case 'nameLookup':
      setBusy(false);
      renderLookup(p);
      break;

    case 'info':
      setBusy(false);
      renderInfo(p);
      break;

    case 'error':
      setBusy(false);
      addLog(p.step || 'error', p.message, 'bad');
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Form wiring
// ---------------------------------------------------------------------------

/** Which bridge event each screen submits. Keep in sync with the Node handlers. */
const EVENT_FOR_SCREEN = {
  create: 'createVta',
  login: 'login',
  name: 'setName',
  lookup: 'lookupName',
};

function submit(screen, fields, build) {
  const eventName = EVENT_FOR_SCREEN[screen];
  if (!eventName) throw new Error(`No bridge event mapped for screen "${screen}"`);

  $(`${screen}-submit`).addEventListener('click', () => {
    const values = {};
    for (const field of fields) values[field] = $(`${screen}-${field}`).value;

    const payload = build(values);
    if (typeof payload === 'string') {
      addLog('input', payload, 'warn');
      return;
    }

    clearLog();
    setBusy(true);
    void send(eventName, payload);
  });
}

submit('create', ['name', 'pass'], ({ name, pass }) => {
  const trimmed = name.trim();
  if (!trimmed || !pass) return 'Enter a username and a passphrase.';
  return { name: trimmed, passphrase: pass };
});

submit('login', ['name', 'pass'], ({ name, pass }) => {
  const trimmed = name.trim();
  if (!trimmed || !pass) return 'Enter a username and a passphrase.';
  return { name: trimmed, passphrase: pass };
});

submit('name', ['value', 'namespace'], ({ value, namespace }) => {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a name.';
  return { name: trimmed, namespace: namespace.trim() || 'p2pts' };
});

submit('lookup', ['uri'], ({ uri }) => {
  const trimmed = uri.trim();
  if (!trimmed) return 'Enter a name, for example vta:p2pts:alice.';
  return { nameUri: trimmed };
});

$('logout').addEventListener('click', () => {
  clearLog();
  setBusy(true);
  void send('logout');
});

$('info-refresh').addEventListener('click', () => {
  setBusy(true);
  void send('getInfo');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!Nodejs) {
  setRuntime('The Capacitor Node.js plugin is not available — run this inside the app.', 'bad');
  for (const button of document.querySelectorAll('button')) button.disabled = true;
} else {
  Nodejs.addListener('message', handleMessage);
  Nodejs.addListener('ready', handshake);
  setBusy(true);
  renderAgentPicker();
  showScreen('create');
  void handshake();
}


