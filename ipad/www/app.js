// GhostPad iPad — connect to a friend's PC with its code, watch the stream,
// and send controller input (touch, keyboard, or a real Bluetooth controller).
'use strict';

const PREFIX = 'ghostpad-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEAD_AFTER_MS = 8000;
const BTN = GhostControls.BTN;

const $ = (id) => document.getElementById(id);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const now = () => performance.now();
const nativeBridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ghost;
const isNativeApp = !!(window.__ghostNative && window.__ghostNative.platform === 'ios-app');

// ---------- storage (localStorage, mirrored to the native app when inside the .ipa) ----------
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
const store = (() => {
  let s = null;
  if (window.__ghostNative && window.__ghostNative.store) s = window.__ghostNative.store;
  if (!s) { try { s = JSON.parse(localStorage.getItem('ghostpad') || 'null'); } catch { s = null; } }
  return { deviceId: uuid(), name: 'iPad', pcs: [], opacity: 70, size: 100, hideWithPad: true, server: '', relay: { urls: '', username: '', credential: '' }, ...(s || {}) };
})();
const pcsByCode = new Map(); // code -> saved PC {code, name, token, last}
for (const p of store.pcs) pcsByCode.set(p.code, p);

function saveStore() {
  store.pcs = [...pcsByCode.values()];
  const json = JSON.stringify(store);
  try { localStorage.setItem('ghostpad', json); } catch { /* private mode */ }
  if (nativeBridge) nativeBridge.postMessage({ type: 'store', json });
}
saveStore(); // persist the generated deviceId right away

// ---------- signalling ----------
function serverOptions(raw) {
  const s = (raw || '').trim();
  if (!s) return {};
  let secure = true;
  let rest = s;
  if (/^http:\/\//i.test(s)) { secure = false; rest = s.slice(7); } else if (/^https:\/\//i.test(s)) rest = s.slice(8);
  const slash = rest.indexOf('/');
  const hostport = slash >= 0 ? rest.slice(0, slash) : rest;
  const [host, port] = hostport.split(':');
  return { host, port: port ? Number(port) : (secure ? 443 : 80), path: slash >= 0 ? rest.slice(slash) : '/', secure };
}

let peer = null;
let link = null;           // the current connection to a PC
let reconnectTries = 0;

function ensurePeer() {
  if (peer && !peer.destroyed && peer.open) return Promise.resolve(peer);
  if (peer && !peer.destroyed && peer.disconnected) {
    try { peer.reconnect(); } catch { peer.destroy(); }
  }
  if (!peer || peer.destroyed) {
    peer = new Peer({ debug: 1, ...serverOptions(store.server), config: { iceServers: GhostNet.iceServers(store.relay) } });
    peer.on('call', onCall);
    peer.on('error', onPeerError);
    peer.on('disconnected', () => {
      const p = peer;
      setTimeout(() => { if (p === peer && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch { /* ignore */ } } }, 2000);
    });
  }
  const p = peer;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 12000);
    p.once('open', () => { clearTimeout(t); resolve(p); });
    p.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function onPeerError(err) {
  if (!link || link.accepted) return;
  if (err.type === 'peer-unavailable') fail(`No PC with code ${link.code} is online. Check the code and that GhostPad is open on the PC.`);
  else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) fail("Can't reach the GhostPad server — check your internet.");
}

const normCode = (s) => String(s || '').toUpperCase().split('').filter((c) => ALPHABET.includes(c)).join('').slice(0, 6);

async function connect(code) {
  code = normCode(code);
  if (code.length !== 6) return;
  if (link) closeLink(link, true);
  const L = link = {
    code, accepted: false, opened: false, leaving: false, ctrl: null, input: null, call: null,
    pcName: (pcsByCode.get(code) || {}).name || 'PC', rtt: null, seq: 0, lastHeard: now(), timers: [],
  };
  setStatus('connecting');
  setMsg('connecting…', 'ok');
  renderPcs();
  let p;
  try { p = await ensurePeer(); } catch {
    if (link === L) fail("Can't reach the GhostPad server — check your internet.");
    return;
  }
  if (link !== L) return;
  const saved = pcsByCode.get(code);
  const ctrl = p.connect(PREFIX + code, {
    label: 'ctrl', reliable: true, serialization: 'json',
    metadata: { app: 'ghostpad', v: 1, video: 'ctrl', deviceId: store.deviceId, name: store.name, token: saved ? saved.token : undefined },
  });
  L.ctrl = ctrl;
  L.timers.push(setTimeout(() => {
    if (link === L && !L.opened) fail("Couldn't reach that PC — check the code and that GhostPad is open on it.");
  }, 15000));
  ctrl.on('open', () => {
    L.opened = true;
    L.lastHeard = now();
    setMsg(saved ? 'reconnecting…' : 'pair request sent — waiting for the PC to accept…', 'ok');
  });
  ctrl.on('data', (m) => onCtrl(L, m));
  ctrl.on('close', () => onClosed(L));
  ctrl.on('error', () => onClosed(L));
}

function onCtrl(L, m) {
  if (link !== L || !m || typeof m !== 'object') return;
  L.lastHeard = now();
  switch (m.t) {
    case 'pending':
      L.pcName = String(m.pcName || 'PC').slice(0, 40);
      setMsg(`waiting for ${L.pcName} to accept…`, 'ok');
      setStatus('waiting');
      break;
    case 'accept': onAccepted(L, m); break;
    case 'decline':
      L.leaving = true;
      fail(m.reason === 'timeout' ? 'The request timed out — try again.' : `${L.pcName} declined your request.`);
      break;
    case 'removed':
      pcsByCode.delete(L.code); saveStore(); renderPcs();
      break;
    case 'ping': send(L.ctrl, { t: 'pong', ts: m.ts }); break;
    case 'pong':
      if (typeof m.ts === 'number') { L.rtt = Math.max(0, Math.round(now() - m.ts)); renderPing(); }
      break;
    case 'pcname':
      L.pcName = String(m.name || 'PC').slice(0, 40);
      { const pc = pcsByCode.get(L.code); if (pc) { pc.name = L.pcName; saveStore(); } }
      renderHud();
      break;
    case 'asset': onAssetChunk(m); break;
    case 'gstate': // live values from a game mod (super meter, scene, weapons...)
      if (m.s && typeof m.s === 'object') GhostControls.setGameState(m.s);
      break;
    case 'layout': {
      // The PC picks the touch controls for the game being played.
      const changed = !GhostControls.layout || GhostControls.layout.id !== (m.layout && m.layout.id);
      const prefs = layoutPrefs(m.layout && m.layout.id);
      const l = GhostControls.load(m.layout, { resolve: resolveAsset, mode: prefs.mode || '', variant: prefs.variant || '' });
      L.game = String(m.game || '').slice(0, 60);
      if (changed && L.accepted) toast(`Controls: ${l.name}`);
      renderModeBar();
      requestAnimationFrame(() => GhostControls.measure());
      break;
    }
    case 'stream':
      if (m.on) {
        videoMsg(m.retry ? `video dropped — reconnecting (${m.retry})…` : 'starting video…');
        watchVideo(L);
      } else {
        clearTimeout(L.videoWatch);
        videoMsg(m.error ? `no video: ${m.error}` : 'controls-only mode — the PC is not streaming video');
      }
      break;
    case 'sdp': onSdp(L, m.d); break;
    case 'bye': onClosed(L); break;
    default: break;
  }
}

function onAccepted(L, m) {
  L.accepted = true;
  reconnectTries = 0;
  GhostControls.setGameState(null); // fresh values come from this PC's game mod
  L.pcName = String(m.pcName || 'PC').slice(0, 40);
  pcsByCode.set(L.code, { code: L.code, name: L.pcName, token: String(m.token || ''), last: Date.now() });
  saveStore();
  // A second, unordered channel just for controller input (no head-of-line stalls).
  L.input = peer.connect(PREFIX + L.code, {
    label: 'input', reliable: false, serialization: 'json', metadata: { app: 'ghostpad', deviceId: store.deviceId },
  });
  L.timers.push(setInterval(() => tick(L), 1000));
  setStatus('connected');
  setMsg('');
  showPlay(true);
  videoMsg(m.stream ? 'starting video…' : 'controls-only mode — the PC is not streaming video');
  if (m.stream) watchVideo(L);
  diag(L, `${isNativeApp ? 'app' : navigator.standalone ? 'web (home screen)' : 'web (Safari tab)'} · ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 160)}`);
  renderHud();
  renderPcs();
  pump(true);
}

// A line for the PC's connection log (Settings -> OPEN LOG on the PC).
function diag(L, m) { send(L.ctrl, { t: 'diag', m: String(m).slice(0, 400) }); }

// No picture 12 s after the video should have started: ask the PC to call again.
function watchVideo(L, tries = 0) {
  clearTimeout(L.videoWatch);
  L.videoWatch = setTimeout(() => {
    if (link !== L || !L.accepted || (L.gotVideo && video.readyState >= 2)) return; // picture is showing
    diag(L, `still no picture — asking for the video again (${tries + 1})`);
    send(L.ctrl, { t: 'wantStream', why: L.call ? 'call open but no picture' : 'no call' });
    if (tries < 5) watchVideo(L, tries + 1);
  }, 12000);
}

function tick(L) {
  if (link !== L) return;
  if (now() - L.lastHeard > DEAD_AFTER_MS) { onClosed(L); return; }
  send(L.ctrl, { t: 'ping', ts: now() });
}

function onCall(call) {
  const L = link;
  if (!L || !L.accepted || !L.ctrl || call.peer !== L.ctrl.peer || !call.metadata || call.metadata.app !== 'ghostpad') {
    try { call.close(); } catch { /* ignore */ }
    return;
  }
  const old = L.call;
  L.call = call; // set first, so closing the old call below isn't mistaken for a drop
  L.gotVideo = false;
  if (old) { try { old.close(); } catch { /* ignore */ } }
  call.answer();
  let why = 'closed';
  call.on('stream', (ms) => { if (link === L && L.call === call) attachStream(L, call.peerConnection, ms); });
  call.on('error', (e) => { why = 'error ' + ((e && (e.type || e.message)) || ''); });
  call.on('close', () => {
    if (link !== L || L.call !== call) return;
    L.call = null;
    L.gotVideo = false;
    diag(L, `video dropped (${why})`);
    videoMsg('video dropped — reconnecting…');
    watchVideo(L);
  });
  watchCall(L, call);
}

// The PC adds its screen + sound to the controls connection, which is already connected,
// so the video needs no second route through the internet.
async function onSdp(L, d) {
  const pc = L.ctrl && L.ctrl.peerConnection;
  if (!pc || !d || d.type !== 'offer' || typeof d.sdp !== 'string') return;
  if (!L.trackWired) {
    L.trackWired = true;
    pc.addEventListener('track', (e) => {
      if (link !== L) return;
      attachStream(L, pc, e.streams[0] || new MediaStream([e.track]));
    });
    watchPc(L, pc, () => link === L);
  }
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    send(L.ctrl, { t: 'sdp', d: { type: 'answer', sdp: pc.localDescription.sdp } });
  } catch (e) {
    diag(L, 'video setup failed: ' + (e && e.message));
  }
}

// Report the video's network state and quality to the PC log.
async function watchCall(L, call) {
  for (let i = 0; i < 50 && !call.peerConnection; i++) await new Promise((r) => setTimeout(r, 100));
  const pc = call.peerConnection;
  if (!pc || L.call !== call) return;
  pc.addEventListener('iceconnectionstatechange', () => { if (L.call === call) diag(L, `video network ${pc.iceConnectionState}`); });
  watchPc(L, pc, () => link === L && L.call === call);
}

function watchPc(L, pc, isCurrent) {
  const started = now();
  let last = null;
  const t = setInterval(async () => {
    if (!isCurrent()) { clearInterval(t); return; }
    try {
      const st = await pc.getStats();
      let inb = null;
      let pair = null;
      for (const r of st.values()) {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      }
      if (!inb) { diag(L, `video: no video data yet (network ${pc.iceConnectionState})`); return; }
      const d = last ? (k) => (inb[k] || 0) - (last[k] || 0) : () => 0;
      const secs = last ? (inb.timestamp - last.timestamp) / 1000 : 0;
      const mbps = secs ? (d('bytesReceived') * 8) / secs / 1e6 : ((inb.bytesReceived || 0) * 8) / (now() - started) / 1000;
      const l = pair && st.get(pair.localCandidateId);
      const rm = pair && st.get(pair.remoteCandidateId);
      diag(L, `video in: ${mbps.toFixed(1)} Mbps · ${Math.round(inb.framesPerSecond || 0)} fps · ${inb.frameWidth || '?'}x${inb.frameHeight || '?'}`
        + ` · lost ${d('packetsLost')} pkts · dropped ${d('framesDropped')} frames · jitter ${Math.round((inb.jitter || 0) * 1000)} ms`
        + (pair ? ` · via ${l ? l.candidateType : '?'}/${rm ? rm.candidateType : '?'} ${l && l.protocol ? l.protocol : ''}` : ''));
      last = inb;
    } catch { /* ignore */ }
  }, 15000);
  L.timers.push(t);
}

const video = $('video');
function attachStream(L, pc, ms) {
  if (video.srcObject !== ms) video.srcObject = ms;
  L.gotVideo = true;
  videoMsg('');
  if (pc) {
    for (const r of pc.getReceivers()) {
      try { r.jitterBufferTarget = 0; } catch { /* unsupported */ }
      try { r.playoutDelayHint = 0; } catch { /* unsupported */ }
    }
  }
  tryUnmute();
}

// Sound is on by default. Safari only allows sound after a tap on this element, so the CONNECT /
// friend tap "unlocks" it (unlockSound); if Safari still says no, the first touch on the controls does.
let soundOff = false; // the friend muted it with the 🔊 button
async function tryUnmute() {
  if (soundOff) { video.muted = true; try { await video.play(); } catch { /* ignore */ } renderHud(); return; }
  video.muted = false;
  try { await video.play(); } catch {
    video.muted = true; // not allowed yet: play silently, retried on the next touch
    try { await video.play(); } catch { /* ignore */ }
  }
  renderHud();
}
function unlockSound() {
  if (soundOff || !video.paused) return;
  video.muted = false;
  try { const p = video.play(); if (p) p.catch(() => {}); } catch { /* ignore */ }
}

function send(ch, msg) {
  if (ch && ch.open) { try { ch.send(msg); } catch { /* channel closing */ } }
}

function closeLink(L, leaving) {
  L.leaving = L.leaving || leaving;
  for (const t of L.timers) { clearTimeout(t); clearInterval(t); }
  if (leaving) send(L.ctrl, { t: 'bye' });
  for (const c of [L.call, L.input, L.ctrl]) { try { c && c.close(); } catch { /* ignore */ } }
  if (link === L) link = null;
}

function onClosed(L) {
  if (link !== L) return;
  const wasPlaying = L.accepted;
  const leaving = L.leaving;
  closeLink(L, false);
  video.srcObject = null;
  GhostControls.reset();
  showPlay(false);
  setStatus('disconnected');
  renderPing();
  renderPcs();
  if (wasPlaying && !leaving && reconnectTries < 3 && pcsByCode.has(L.code)) {
    reconnectTries++;
    setMsg(`connection lost — reconnecting (${reconnectTries}/3)…`, 'err');
    setTimeout(() => { if (!link) connect(L.code); }, 1500);
  } else if (wasPlaying && !leaving) {
    setMsg('disconnected from the PC', 'err');
  } else if (!wasPlaying && !leaving && L.opened) {
    setMsg('the PC closed the connection', 'err');
  }
}

function fail(msg) {
  if (link) closeLink(link, false);
  setStatus('disconnected');
  setMsg(msg, 'err');
  renderPcs();
}

function leave() {
  if (link) { const L = link; L.leaving = true; closeLink(L, true); }
  reconnectTries = 0;
  video.srcObject = null;
  GhostControls.reset();
  showPlay(false);
  setStatus('disconnected');
  setMsg('');
  renderPing();
  renderPcs();
}

// ---------- input ----------
let nativePad = null; // set by the iOS app shell for Bluetooth controllers
window.__gpNativePad = (b, lx, ly, rx, ry, lt, rt) => { nativePad = { b, lx, ly, rx, ry, lt, rt }; pump(); };
window.__gpNativePadGone = () => { nativePad = null; pump(); };

function deadzone(x, y) {
  const n = Math.hypot(x, y);
  if (n < 0.12) return [0, 0];
  const k = Math.min(1, (n - 0.12) / 0.88) / n;
  return [x * k, y * k];
}

const GP_BUTTONS = [BTN.A, BTN.B, BTN.X, BTN.Y, BTN.LB, BTN.RB, 0, 0, BTN.BACK, BTN.START, BTN.L3, BTN.R3, BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT, BTN.GUIDE];
const phys = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
let hasPhysical = false;

function readPhysical() {
  if (nativePad) return nativePad;
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const g of list) {
    if (!g || !g.connected) continue;
    let b = 0;
    const B = g.buttons;
    for (let i = 0; i < GP_BUTTONS.length && i < B.length; i++) if (GP_BUTTONS[i] && B[i].pressed) b |= GP_BUTTONS[i];
    const ax = g.axes;
    const [lx, ly] = deadzone(ax[0] || 0, -(ax[1] || 0));
    const [rx, ry] = deadzone(ax[2] || 0, -(ax[3] || 0));
    phys.b = b;
    phys.lx = Math.round(lx * 32767); phys.ly = Math.round(ly * 32767);
    phys.rx = Math.round(rx * 32767); phys.ry = Math.round(ry * 32767);
    phys.lt = Math.round(((B[6] && B[6].value) || 0) * 255);
    phys.rt = Math.round(((B[7] && B[7].value) || 0) * 255);
    return phys;
  }
  return null;
}

const pick = (a, b) => (Math.abs(a) >= Math.abs(b) ? a : b);
const out = [0, 0, 0, 0, 0, 0];
let lastKey = '';
let lastSentAt = 0;

// Sends the merged controller state when it changes (plus a keep-alive every 100 ms).
function pump(force) {
  const L = link;
  if (!L || !L.accepted) return;
  const t = GhostControls.state;
  const p = readPhysical();
  const nowHas = !!p;
  if (nowHas !== hasPhysical) { hasPhysical = nowHas; applyPadVisibility(); }
  let b = t.b;
  out[0] = t.lx; out[1] = t.ly; out[2] = t.rx; out[3] = t.ry; out[4] = t.lt; out[5] = t.rt;
  if (p) {
    b |= p.b;
    out[0] = pick(out[0], p.lx); out[1] = pick(out[1], p.ly); out[2] = pick(out[2], p.rx); out[3] = pick(out[3], p.ry);
    out[4] = Math.max(out[4], p.lt); out[5] = Math.max(out[5], p.rt);
  }
  const key = b + ',' + out.join(',');
  const ts = now();
  if (!force && key === lastKey && ts - lastSentAt < 100) return;
  lastKey = key;
  lastSentAt = ts;
  const ch = L.input && L.input.open ? L.input : L.ctrl;
  send(ch, { t: 'i', s: ++L.seq, b, a: out.slice() });
}

function frame() {
  if (link && link.accepted) pump();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => pump(), 50);

// ---------- UI ----------
let padHidden = false;
function applyPadVisibility() {
  const hide = padHidden || (store.hideWithPad && hasPhysical);
  $('pad').classList.toggle('hidden-pad', hide);
  $('hudPad').classList.toggle('off', hide);
}

function applyPadLook() {
  document.documentElement.style.setProperty('--pad-opacity', String(store.opacity / 100));
  document.documentElement.style.setProperty('--pad-scale', String(store.size / 100));
  requestAnimationFrame(() => GhostControls.measure());
}

let wakeLock = null;
async function keepAwake(on) {
  if (nativeBridge) { nativeBridge.postMessage({ type: 'awake', on }); return; }
  try {
    if (on && navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && link && link.accepted) keepAwake(true); });

function showPlay(on) {
  $('home').hidden = on;
  $('play').hidden = !on;
  keepAwake(on);
  if (on) { applyPadVisibility(); requestAnimationFrame(() => GhostControls.measure()); }
}

function videoMsg(text) {
  $('videoMsg').textContent = text;
  $('videoMsg').hidden = !text;
}

function setStatus(kind) {
  const el = $('statusVal');
  el.textContent = kind === 'connected' ? 'connected' : kind === 'waiting' ? 'waiting…' : kind === 'connecting' ? 'connecting…' : 'disconnected';
  el.className = 'status-val' + (kind === 'connected' ? ' on' : kind === 'disconnected' ? '' : ' wait');
}

function setMsg(text, kind = '') {
  const el = $('codeMsg');
  el.textContent = text || "tap here and type the code shown on your friend's PC";
  el.className = 'code-msg' + (text && kind ? ' ' + kind : '');
}

function renderPing() {
  const el = $('pingVal');
  const rtt = link && link.accepted ? link.rtt : null;
  el.className = 'ping-val' + (rtt === null ? '' : rtt < 70 ? '' : rtt < 140 ? ' ok' : ' bad');
  el.textContent = rtt === null ? 'N/A' : rtt + 'ms';
  $('hudPing').textContent = rtt === null ? '--' : rtt + 'ms';
  $('hudDot').classList.toggle('bad', rtt !== null && rtt >= 140);
}

// ---------- button pictures sent by the PC (in small chunks over the reliable channel) ----------
const assets = new Map();        // asset id -> data: URL
const assetParts = new Map();    // asset id -> {n, parts[]}
function onAssetChunk(m) {
  if (typeof m.id !== 'string' || !/^[a-f0-9]{8,40}$/.test(m.id) || typeof m.d !== 'string') return;
  const n = Math.min(Number(m.n) || 0, 400);
  const i = Number(m.i);
  if (!(n > 0) || !(i >= 0 && i < n) || assets.has(m.id)) return;
  let p = assetParts.get(m.id);
  if (!p || p.n !== n) { p = { n, got: 0, parts: new Array(n) }; assetParts.set(m.id, p); }
  if (p.parts[i] === undefined) { p.parts[i] = m.d; p.got++; }
  if (p.got === n) { assets.set(m.id, p.parts.join('')); assetParts.delete(m.id); }
}
const resolveAsset = (ref) => (typeof ref === 'string' && ref.startsWith('asset:') ? assets.get(ref.slice(6)) || '' : '');

// ---------- layout modes (e.g. Isle / Battle / Plane) and character choice, remembered per layout ----------
function layoutPrefs(id) {
  store.layoutPrefs = store.layoutPrefs || {};
  const key = String(id || 'default');
  return store.layoutPrefs[key] || (store.layoutPrefs[key] = {});
}

function renderModeBar() {
  const l = GhostControls.layout;
  const modes = l && l.modes.length > 1 ? l.modes : [];
  $('hudModes').innerHTML = modes.map((m) =>
    `<button class="hud-mode${m === GhostControls.mode ? ' on' : ''}" data-mode="${esc(m)}">${esc(m)}</button>`).join('');
  $('hudModes').hidden = !modes.length;
  const v = l && l.variants;
  $('hudVariant').hidden = !v || v.options.length < 2;
  if (v) $('hudVariant').textContent = `${GhostControls.variant} ⇄`;
}

$('hudModes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  GhostControls.setMode(b.dataset.mode);
  layoutPrefs(GhostControls.layout.id).mode = b.dataset.mode;
  saveStore();
  renderModeBar();
});
$('hudVariant').addEventListener('click', () => {
  const v = GhostControls.layout.variants;
  if (!v) return;
  const next = v.options[(v.options.indexOf(GhostControls.variant) + 1) % v.options.length];
  GhostControls.setVariant(next);
  layoutPrefs(GhostControls.layout.id).variant = next;
  saveStore();
  renderModeBar();
  toast(`${v.label}: ${next}`);
});

function renderHud() {
  if (!link) return;
  $('hudText').textContent = link.pcName;
  $('hudSound').textContent = video.muted ? '🔇' : '🔊';
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - (ts || 0)) / 60000);
  if (!ts) return '';
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

function renderPcs() {
  const list = [...pcsByCode.values()].sort((a, b) => (b.last || 0) - (a.last || 0));
  if (!list.length) {
    $('pcs').innerHTML = '<li class="empty">PCs you connect to show up here — tap one to reconnect</li>';
    return;
  }
  $('pcs').innerHTML = list.map((p) => `
    <li class="pc${link && link.code === p.code ? ' busy' : ''}" data-code="${esc(p.code)}">
      <div class="pc-name">${esc(p.name)}</div>
      <div class="pc-meta">${esc(p.code)}${p.last ? ' · ' + esc(timeAgo(p.last)) : ''}</div>
      <button class="pc-x" data-act="forget" aria-label="Forget">✕</button>
    </li>`).join('');
}

// code entry
const codeInput = $('codeInput');
function renderSlots() {
  const v = codeInput.value;
  let html = '';
  for (let i = 0; i < 6; i++) {
    const cur = document.activeElement === codeInput && i === Math.min(v.length, 5);
    html += `<div class="code-slot${cur ? ' cur' : ''}">${esc(v[i] || '')}</div>`;
  }
  $('codeSlots').innerHTML = html;
  $('connectBtn').disabled = v.length !== 6;
}
codeInput.addEventListener('input', () => {
  const v = normCode(codeInput.value);
  if (v !== codeInput.value) codeInput.value = v;
  renderSlots();
  if (v.length === 6) { codeInput.blur(); startFromUi(v); }
});
codeInput.addEventListener('focus', () => { $('codeBox').classList.add('focus'); renderSlots(); });
codeInput.addEventListener('blur', () => { $('codeBox').classList.remove('focus'); renderSlots(); });
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startFromUi(codeInput.value); } });
$('connectBtn').addEventListener('click', (e) => { e.stopPropagation(); startFromUi(codeInput.value); });

function startFromUi(code) {
  unlockSound(); // this tap is what lets Safari play the game's sound later
  // Safari (not the app / home-screen app): go fullscreen while we still have the tap.
  const standalone = isNativeApp || navigator.standalone || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  if (!standalone) {
    const de = document.documentElement;
    try { (de.requestFullscreen || de.webkitRequestFullscreen || (() => {})).call(de); } catch { /* ignore */ }
  }
  connect(code);
}

$('pcs').addEventListener('click', (e) => {
  const li = e.target.closest('[data-code]');
  if (!li) return;
  if (e.target.closest('[data-act="forget"]')) {
    const p = pcsByCode.get(li.dataset.code);
    if (p && confirm(`Forget ${p.name}?`)) { pcsByCode.delete(p.code); saveStore(); renderPcs(); }
    return;
  }
  codeInput.value = li.dataset.code;
  renderSlots();
  startFromUi(li.dataset.code);
});

// iPad name
const nameEl = $('padName');
nameEl.textContent = store.name;
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
nameEl.addEventListener('blur', () => {
  const n = nameEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) || 'iPad';
  nameEl.textContent = n;
  if (n === store.name) return;
  store.name = n;
  saveStore();
  if (link && link.accepted) send(link.ctrl, { t: 'name', name: n });
  toast('Name saved');
});

// play HUD
$('hudLeave').addEventListener('click', leave);
$('hudPad').addEventListener('click', () => { padHidden = !padHidden; applyPadVisibility(); });
$('hudSound').addEventListener('click', () => {
  soundOff = !video.muted;
  if (soundOff) { video.muted = true; renderHud(); } else tryUnmute();
});
// The first touch anywhere while playing counts as permission to play sound.
document.addEventListener('touchend', () => { if (link && link.accepted && video.muted && !soundOff && video.srcObject) tryUnmute(); }, { passive: true });

// settings
const setDlg = $('setDlg');
$('openSettings').addEventListener('click', () => {
  $('sOpacity').value = store.opacity; $('opVal').textContent = store.opacity;
  $('sSize').value = store.size; $('szVal').textContent = store.size;
  $('sHideWithPad').checked = store.hideWithPad;
  $('sServer').value = store.server;
  const relay = store.relay || {};
  $('sRelayUrls').value = relay.urls || '';
  $('sRelayUser').value = relay.username || '';
  $('sRelayPass').value = relay.credential || '';
  $('sNetResult').textContent = '';
  setDlg.showModal();
});
$('sOpacity').addEventListener('input', () => { $('opVal').textContent = $('sOpacity').value; });
$('sSize').addEventListener('input', () => { $('szVal').textContent = $('sSize').value; });
$('sCancel').addEventListener('click', () => setDlg.close());
$('sNetTest').addEventListener('click', async () => {
  $('sNetResult').textContent = 'testing…';
  const relay = { urls: $('sRelayUrls').value.trim(), username: $('sRelayUser').value.trim(), credential: $('sRelayPass').value };
  try { $('sNetResult').textContent = (await GhostNet.testRoutes(relay)).text; } catch (e) { $('sNetResult').textContent = 'test failed: ' + e.message; }
});
$('setForm').addEventListener('submit', (e) => {
  e.preventDefault();
  store.opacity = Number($('sOpacity').value);
  store.size = Number($('sSize').value);
  store.hideWithPad = $('sHideWithPad').checked;
  const server = $('sServer').value.trim();
  const relay = { urls: $('sRelayUrls').value.trim(), username: $('sRelayUser').value.trim(), credential: $('sRelayPass').value };
  if (server !== store.server || JSON.stringify(relay) !== JSON.stringify(store.relay || {})) {
    store.server = server;
    store.relay = relay;
    if (peer) { peer.destroy(); peer = null; } // reconnect with the new routes
  }
  saveStore();
  applyPadLook();
  setDlg.close();
  toast('Settings saved');
});

let toastTimer = 0;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- start ----------
GhostControls.mount($('pad'), () => pump());
// The game switched scene or character by itself: update the top bar and remember it.
GhostControls.onAuto = (kind, value) => {
  const prefs = layoutPrefs(GhostControls.layout.id);
  prefs[kind] = value;
  saveStore();
  renderModeBar();
  requestAnimationFrame(() => GhostControls.measure());
};
applyPadLook();
renderSlots();
renderPcs();
setStatus('disconnected');
renderPing();
ensurePeer().catch(() => {}); // warm up the server connection

// For automated tests.
window.__gpi = { get link() { return link; }, store, connect, leave };
