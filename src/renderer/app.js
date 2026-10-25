import { AudioEngine } from './audio.js';
import { ICONS } from './icons.js';

const sk = window.sk;
const DEMO = location.search.includes('demo');
const engine = new AudioEngine();

// =====================================================================
// Helpers
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const pct = (v) => `${Math.round(v * 100)}%`;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        for (const [sk_, sv] of Object.entries(v)) {
          if (sk_.startsWith('--')) el.style.setProperty(sk_, sv); else el.style[sk_] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' && typeof v === 'boolean') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name] || '';
  return t.content.firstElementChild || document.createTextNode('');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fmtDur(s) {
  if (!s && s !== 0) return '';
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

function contrastOn(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.36 ? '#14161b' : '#ffffff';
}

// =====================================================================
// Model
// =====================================================================
const TILE_COLORS = ['#6d83ff', '#9b7bff', '#cf6bdc', '#ec6a8c', '#ef7f5a', '#e8a33d', '#c7b73b', '#68b84a', '#2fb7a4', '#3ba7d9', '#8a94a8', '#a8876c'];
const ACCENTS = [
  ['Indigo', '#6d83ff'], ['Iris', '#9b7bff'], ['Teal', '#2fb7a4'], ['Sky', '#3ba7d9'],
  ['Rose', '#ec6a8c'], ['Amber', '#e8a33d'], ['Leaf', '#68b84a'],
];
const EMOJI = '🔊 📣 🎺 🥁 🎸 🎹 🎻 🎤 🎧 🎵 🎶 🔔 📯 💥 💣 🔥 ⚡ 💀 👻 🤖 👽 🐐 🐸 🦆 🐱 🐶 🐔 🦀 🍕 🍿 🏆 🎉 🎊 🥳 😂 🤣 😭 😱 😡 🤯 🥶 😎 🤡 💩 👏 🙌 👋 🫡 ❤️ ⭐ ✨ 🚨 🚀 💸 ⏰ ❌ ✅ ❓ ‼️ 🎬 🎮 🕹️ 🧨 🪦 🗿'.split(' ');

function defaultConfig() {
  const board = { id: uid(), name: 'Main', emoji: '🔊', sounds: [] };
  return {
    version: 1,
    settings: {
      setupDone: false,
      micId: 'default', micLabel: '',
      cableId: '', cableLabel: '',
      monitorId: 'default', monitorLabel: '',
      micEnabled: true,
      micVolume: 1,
      soundVolume: 0.8,
      monitorSounds: true,
      monitorVolume: 0.6,
      musicVolume: 0.45,
      duckMic: false,
      duckAmount: 0.3,
      micProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      overlap: 'overlap',
      defaultMode: 'restart',
      stopAllHotkey: 'Ctrl+Alt+X',
      micHotkey: '',
      theme: 'system',
      accent: '#6d83ff',
      tileSize: 'm',
      showHotkeys: true,
      showDurations: true,
      closeToTray: true,
      startMinimized: false,
      launchAtStartup: false,
      alwaysOnTop: false,
      share: [], // [{ key, exe, name, enabled }]
    },
    boards: [board],
    activeBoard: board.id,
  };
}

function migrate(cfg) {
  const base = defaultConfig();
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.boards)) return base;
  cfg.settings = { ...base.settings, ...(cfg.settings || {}) };
  cfg.settings.micProcessing = { ...base.settings.micProcessing, ...(cfg.settings.micProcessing || {}) };
  if (!Array.isArray(cfg.settings.share)) cfg.settings.share = [];
  if (!cfg.boards.length) cfg.boards = base.boards;
  for (const b of cfg.boards) {
    b.id ||= uid();
    b.name ||= 'Board';
    b.sounds = Array.isArray(b.sounds) ? b.sounds : [];
    for (const s of b.sounds) { normalizeSound(s); delete s.missing; }
  }
  if (!cfg.boards.find((b) => b.id === cfg.activeBoard)) cfg.activeBoard = cfg.boards[0].id;
  cfg.version = 1;
  return cfg;
}

function normalizeSound(s) {
  s.id ||= uid();
  s.name ||= 'Untitled';
  s.emoji ??= '';
  s.color ||= TILE_COLORS[0];
  s.volume ??= 1;
  s.hotkey ||= '';
  s.start ||= 0;
  s.end ||= 0;
  s.loop = !!s.loop;
  s.mode ||= 'restart';
  return s;
}

let cfg = defaultConfig();
const ui = {
  search: '',
  editing: null,        // sound id in the drawer
  devices: { inputs: [], outputs: [] },
  failedHotkeys: new Set(),
  tileEls: new Map(),   // sound id -> element
  share: new Map(),     // key -> { status, pid, error, retryAt }
  info: { captureSupported: false, platform: 'win32', version: '' },
  loadingSounds: new Set(),
};

const S = () => cfg.settings;
const activeBoard = () => cfg.boards.find((b) => b.id === cfg.activeBoard) || cfg.boards[0];
function findSound(id) {
  for (const b of cfg.boards) {
    const i = b.sounds.findIndex((s) => s.id === id);
    if (i >= 0) return { board: b, sound: b.sounds[i], index: i };
  }
  return null;
}

const persist = debounce(() => { if (!DEMO) sk.saveConfig(cfg); }, 250);
function save({ hotkeys = false, audio = false } = {}) {
  persist();
  if (hotkeys) syncHotkeys();
  if (audio) syncAudio();
}

// =====================================================================
// Theme
// =====================================================================
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const s = S();
  const dark = s.theme === 'dark' || (s.theme === 'system' && darkQuery.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.size = s.tileSize;
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--on-accent', contrastOn(s.accent));
  sk.setTheme({ dark, bg: dark ? '#16181d' : '#eef0f4' });
}
darkQuery.addEventListener('change', applyTheme);

// =====================================================================
// Devices
// =====================================================================
const CABLE_RE = /cable input|vb-audio|voicemeeter (vaio |aux )?input|virtual cable|vac\b|line 1/i;
const CABLE_OUT_RE = /cable output|voicemeeter (out|output)|vb-audio.*output/i;
const isVirtualOut = (label) => CABLE_RE.test(label) && !/output/i.test(label.replace(/\(.*\)/, ''));

async function refreshDevices() {
  try {
    // Device names are only visible once we've had mic permission once.
    if (!ui.devicesPrimed) {
      ui.devicesPrimed = true;
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    ui.devices.inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    ui.devices.outputs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  } catch (e) {
    console.warn('enumerate failed', e);
  }
  reconcileDevices();
}

function findDevice(list, id, label) {
  return list.find((d) => d.deviceId === id) || (label && list.find((d) => d.label === label)) || null;
}

function detectCable() {
  return ui.devices.outputs.find((d) => d.deviceId !== 'default' && /cable input/i.test(d.label))
    || ui.devices.outputs.find((d) => d.deviceId !== 'default' && isVirtualOut(d.label))
    || null;
}

function reconcileDevices() {
  const s = S();
  let changed = false;
  // Mic: keep the saved choice; never use a virtual cable's output as the mic.
  const mic = findDevice(ui.devices.inputs, s.micId, s.micLabel);
  if (mic) {
    if (mic.deviceId !== s.micId) { s.micId = mic.deviceId; changed = true; }
  } else if (ui.devices.inputs.length) {
    const pick = ui.devices.inputs.find((d) => d.deviceId === 'default' && !CABLE_OUT_RE.test(d.label))
      || ui.devices.inputs.find((d) => !CABLE_OUT_RE.test(d.label)) || ui.devices.inputs[0];
    s.micId = pick.deviceId; s.micLabel = pick.label; changed = true;
  }
  // Cable: saved choice, else auto-detect VB-CABLE.
  const cable = s.cableId ? findDevice(ui.devices.outputs, s.cableId, s.cableLabel) : null;
  if (cable) {
    if (cable.deviceId !== s.cableId) { s.cableId = cable.deviceId; changed = true; }
  } else {
    const auto = detectCable();
    const next = auto ? auto.deviceId : '';
    if (next !== s.cableId) { s.cableId = next; s.cableLabel = auto ? auto.label : ''; changed = true; }
  }
  // Monitor: saved choice, else system default.
  const mon = findDevice(ui.devices.outputs, s.monitorId, s.monitorLabel);
  if (!mon && s.monitorId !== 'default') { s.monitorId = 'default'; s.monitorLabel = ''; changed = true; }
  if (changed) persist();
  syncAudio();
  renderRoute();
}

navigator.mediaDevices?.addEventListener?.('devicechange', debounce(refreshDevices, 400));

function cableDevice() { return S().cableId ? findDevice(ui.devices.outputs, S().cableId, S().cableLabel) : null; }
function deviceName(label) { return (label || '').replace(/^Default - /, '').replace(/\s*\((VB-Audio Virtual Cable|.*?)\)\s*$/, (m, g) => (g.length < 28 ? ` (${g})` : '')); }

function syncAudio() {
  if (!engine.ctx) return;
  const s = S();
  engine.apply(s);
  const cable = cableDevice();
  engine.setOutputs(cable ? cable.deviceId : '', s.monitorId);
  engine.setMic(s.micEnabled && !!cable, s.micId, s.micProcessing);
}

// =====================================================================
// Hotkeys
// =====================================================================
const CODE_MAP = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
};
const BARE_OK = /^(num.+|F\d{1,2}|Insert|Home|End|PageUp|PageDown|Delete|PrintScreen|Scrolllock|Media.+)$/;

function accelFromEvent(e) {
  let key = null;
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (CODE_MAP[c]) key = CODE_MAP[c];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length && !BARE_OK.test(key)) return { error: 'Add Ctrl, Alt or Shift — a bare key would stop you typing it anywhere.' };
  return { accel: [...mods, key].join('+') };
}

function hotkeyLabel(accel) {
  if (!accel) return '';
  return accel.split('+').map((p) => {
    if (/^num\d$/.test(p)) return 'Num ' + p.slice(3);
    const n = { numadd: 'Num +', numsub: 'Num −', nummult: 'Num ×', numdiv: 'Num ÷', numdec: 'Num .', Super: 'Win', Scrolllock: 'Scroll Lock', MediaPlayPause: 'Play/Pause', MediaNextTrack: 'Next track', MediaPreviousTrack: 'Prev track', MediaStop: 'Media stop' }[p];
    return n || p;
  }).join(' ');
}

let lastHotkeySig = '';
async function syncHotkeys(force = false) {
  const list = [];
  for (const b of cfg.boards) for (const s of b.sounds) if (s.hotkey) list.push({ accel: s.hotkey, id: 'sound:' + s.id });
  if (S().stopAllHotkey) list.push({ accel: S().stopAllHotkey, id: 'stopAll' });
  if (S().micHotkey) list.push({ accel: S().micHotkey, id: 'toggleMic' });
  const sig = JSON.stringify(list);
  if (!force && sig === lastHotkeySig) return;
  lastHotkeySig = sig;
  const failed = await sk.setHotkeys(list);
  const before = ui.failedHotkeys;
  ui.failedHotkeys = new Set(failed.map((f) => f.id));
  const fresh = failed.filter((f) => !before.has(f.id));
  if (fresh.length) {
    const f = fresh[0];
    toast(`${hotkeyLabel(f.accel)} ${f.reason === 'duplicate' ? 'is used by two things in SoundKami' : 'is already taken by another app'}. Pick a different key.`, { kind: 'warn' });
  }
  if (fresh.length || before.size !== ui.failedHotkeys.size) renderGrid();
}

function onHotkey(id) {
  if (id === 'stopAll') return stopAll();
  if (id === 'toggleMic') return toggleMic();
  if (id.startsWith('sound:')) {
    const f = findSound(id.slice(6));
    if (f) playSound(f.sound);
  }
}

// =====================================================================
// Playback
// =====================================================================
async function playSound(sound, opts) {
  if (sound.missing) { toast(`“${sound.name}” is missing its audio file.`, { kind: 'warn' }); return; }
  const el = ui.tileEls.get(sound.id);
  let slow = null;
  if (!engine.buffers.has(sound.file)) {
    slow = setTimeout(() => el && el.classList.add('loading'), 120);
  }
  try {
    await engine.play(sound, opts);
    ensureMeta(sound);
  } catch (e) {
    console.error(e);
    toast(`Couldn’t play “${sound.name}”. The file may be damaged or in an unsupported format.`, { kind: 'err' });
  } finally {
    clearTimeout(slow);
    el && el.classList.remove('loading');
  }
}

function stopAll() {
  engine.stopAll();
}

function toggleMic() {
  S().micEnabled = !S().micEnabled;
  save({ audio: true });
  renderMixerValues();
  if (!cableDevice() && S().micEnabled) toast('Mic passthrough starts once a virtual cable is selected in Settings.', { kind: 'warn' });
}

// Fill in duration + waveform peaks once a sound is decoded.
async function ensureMeta(sound) {
  if (sound.duration && sound.peaks) return;
  try {
    const buf = await engine.getBuffer(sound.file);
    sound.duration = buf.duration;
    sound.peaks = AudioEngine.peaks(buf, 40);
    persist();
    updateTile(sound);
  } catch {
    sound.missing = true;
    updateTile(sound);
  }
}

async function preloadBoard(board) {
  for (const s of board.sounds) {
    if (s.missing) continue;
    try { await ensureMeta(s); } catch {}
  }
}

// =====================================================================
// Rendering: sidebar
// =====================================================================
function renderBoards() {
  const nav = $('#boards');
  nav.replaceChildren(...cfg.boards.map((b) => {
    const el = h('button', {
      class: 'board-link' + (b.id === cfg.activeBoard && !ui.search ? ' active' : ''),
      onclick: () => selectBoard(b.id),
      oncontextmenu: (e) => { e.preventDefault(); boardMenu(b, e.clientX, e.clientY); },
    },
    h('span', { class: 'e' }, b.emoji || '▫️'),
    h('span', { class: 'n' }, b.name),
    h('span', { class: 'c' }, b.sounds.length || ''));
    // Drop sounds (from the grid or from Explorer) onto a board.
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-sk-sound') || e.dataTransfer.types.includes('Files')) {
        e.preventDefault(); el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('drop-target');
      hideVeil();
      const id = e.dataTransfer.getData('application/x-sk-sound');
      if (id) moveSoundToBoard(id, b.id);
      else if (e.dataTransfer.files.length) await importFiles([...e.dataTransfer.files], b);
    });
    return el;
  }));
}

function selectBoard(id) {
  cfg.activeBoard = id;
  if (ui.search) { ui.search = ''; $('#search').value = ''; }
  closeDrawer();
  save();
  renderAll();
  preloadBoard(activeBoard());
}

function newBoard() {
  const b = { id: uid(), name: `Board ${cfg.boards.length + 1}`, emoji: EMOJI[(cfg.boards.length * 7) % EMOJI.length], sounds: [] };
  cfg.boards.push(b);
  cfg.activeBoard = b.id;
  save();
  renderAll();
  requestAnimationFrame(() => startRenameBoard());
}

function boardMenu(b, x, y) {
  const i = cfg.boards.indexOf(b);
  menu(x, y, [
    { label: 'Rename', run: () => { selectBoard(b.id); startRenameBoard(); } },
    { label: 'Change icon', run: () => emojiPicker(x, y, (em) => { b.emoji = em; save(); renderAll(); }) },
    { sep: true },
    { label: 'Move up', disabled: i === 0, run: () => { cfg.boards.splice(i, 1); cfg.boards.splice(i - 1, 0, b); save(); renderBoards(); } },
    { label: 'Move down', disabled: i === cfg.boards.length - 1, run: () => { cfg.boards.splice(i, 1); cfg.boards.splice(i + 1, 0, b); save(); renderBoards(); } },
    { sep: true },
    { label: 'Export board…', run: () => exportBoard(b) },
    { label: 'Delete board', danger: true, disabled: cfg.boards.length === 1, run: () => deleteBoard(b) },
  ]);
}

function deleteBoard(b) {
  const i = cfg.boards.indexOf(b);
  if (i < 0 || cfg.boards.length === 1) return;
  cfg.boards.splice(i, 1);
  if (cfg.activeBoard === b.id) cfg.activeBoard = cfg.boards[Math.max(0, i - 1)].id;
  for (const s of b.sounds) engine.stop(s.id);
  save({ hotkeys: true });
  renderAll();
  toast(`Deleted “${b.name}” and its ${b.sounds.length} sound${b.sounds.length === 1 ? '' : 's'}.`, {
    action: 'Undo',
    onAction: () => { cfg.boards.splice(i, 0, b); cfg.activeBoard = b.id; save({ hotkeys: true }); renderAll(); },
    onExpire: () => gcFiles(b.sounds.map((s) => s.file)),
    timeout: 8000,
  });
}

async function exportBoard(b) {
  const res = await sk.exportBoard(b);
  if (res && res.ok) toast(`Exported “${b.name}”. Friends can import it from the board menu.`);
}

async function importBoard() {
  try {
    const board = await sk.importBoard();
    if (!board) return;
    board.id = uid();
    board.sounds = (board.sounds || []).map((s) => normalizeSound({ ...s, id: uid() }));
    let name = board.name || 'Imported';
    while (cfg.boards.some((x) => x.name === name)) name += ' (copy)';
    board.name = name;
    cfg.boards.push(board);
    cfg.activeBoard = board.id;
    save();
    renderAll();
    preloadBoard(board);
    toast(`Imported “${board.name}” with ${board.sounds.length} sounds.`);
  } catch (e) {
    toast('That file isn’t a SoundKami board.', { kind: 'err' });
  }
}

// =====================================================================
// Rendering: board header + grid
// =====================================================================
function renderHead() {
  const b = activeBoard();
  const searching = !!ui.search;
  $('#board-emoji').textContent = searching ? '🔎' : (b.emoji || '▫️');
  $('#board-emoji').disabled = searching;
  $('#board-name').textContent = searching ? `Results for “${ui.search}”` : b.name;
  const n = searching ? ui.tileEls.size : b.sounds.length;
  $('#board-count').textContent = `${n} sound${n === 1 ? '' : 's'}`;
  $('#drop-board').textContent = b.name;
}

function waveSvg(peaks) {
  if (!peaks || !peaks.length) return null;
  const n = peaks.length;
  const w = 100 / n;
  const rects = peaks.map((p, i) => {
    const hgt = Math.max(4, p);
    return `<rect x="${(i * w + w * 0.18).toFixed(2)}" y="${(100 - hgt).toFixed(1)}" width="${(w * 0.64).toFixed(2)}" height="${hgt}" rx="0.8"/>`;
  }).join('');
  const wrap = h('span', { class: 'wave', html: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${rects}</svg>` });
  return wrap;
}

function tileEl(sound) {
  const s = S();
  const failed = ui.failedHotkeys.has('sound:' + sound.id);
  const el = h('button', {
    class: 'tile' + (sound.missing ? ' missing' : '') + (engine.isPlaying(sound.id) ? ' playing' : ''),
    style: { '--c': sound.color },
    draggable: ui.search ? 'false' : 'true',
    title: sound.missing ? 'Audio file missing or unreadable — right-click to replace it' : sound.name,
    'data-id': sound.id,
    onclick: () => playSound(sound),
    oncontextmenu: (e) => { e.preventDefault(); soundMenu(sound, e.clientX, e.clientY); },
  },
  waveSvg(sound.peaks),
  h('span', { class: 'top' },
    sound.emoji ? h('span', { class: 'emoji' }, sound.emoji) : null),
  h('span', { class: 'name' }, sound.name),
  h('span', { class: 'meta' },
    s.showHotkeys && sound.hotkey ? h('kbd', { class: failed ? 'bad' : '', title: failed ? 'This key is taken by another app' : '' }, hotkeyLabel(sound.hotkey)) : null,
    h('span', { class: 'flags' },
      sound.loop ? h('span', { title: 'Loops' }, icon('loop')) : null,
      sound.mode === 'stop' ? h('span', { title: 'Press again to stop' }, icon('toggle')) : null,
      sound.mode === 'overlap' ? h('span', { title: 'Layers over itself' }, icon('layers')) : null),
    s.showDurations && sound.duration ? h('span', { class: 'dur', style: { marginLeft: (sound.loop || sound.mode !== 'restart') ? '0' : 'auto' } }, fmtDur(trimmedLength(sound))) : null),
  h('span', {
    class: 'edit', role: 'button', title: 'Edit', 'aria-label': `Edit ${sound.name}`,
    onclick: (e) => { e.stopPropagation(); openEditor(sound.id); },
  }, icon('pencil')));
  if (!sound.emoji) $('.top', el).remove();

  // Reorder by dragging
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-sk-sound', sound.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-sk-sound')) return;
    e.preventDefault();
    el.classList.add('drop-before');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
  el.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('application/x-sk-sound');
    el.classList.remove('drop-before');
    if (!id || id === sound.id) return;
    e.preventDefault(); e.stopPropagation();
    reorder(id, sound.id);
  });
  return el;
}

function trimmedLength(s) {
  const end = s.end && s.end > (s.start || 0) ? Math.min(s.end, s.duration || s.end) : (s.duration || 0);
  return Math.max(0, end - (s.start || 0));
}

function updateTile(sound) {
  const old = ui.tileEls.get(sound.id);
  if (!old) return;
  const fresh = tileEl(sound);
  old.replaceWith(fresh);
  ui.tileEls.set(sound.id, fresh);
}

function renderGrid() {
  const grid = $('#grid');
  ui.tileEls.clear();
  const kids = [];
  if (ui.search) {
    const q = ui.search.toLowerCase();
    for (const b of cfg.boards) {
      const hits = b.sounds.filter((s) => s.name.toLowerCase().includes(q) || (s.emoji && s.emoji === ui.search.trim()));
      if (!hits.length) continue;
      kids.push(h('div', { class: 'result-group' }, `${b.emoji || ''} ${b.name}`));
      for (const s of hits) { const el = tileEl(s); ui.tileEls.set(s.id, el); kids.push(el); }
    }
    if (!kids.length) {
      kids.push(h('div', { class: 'empty' },
        h('h3', null, 'No sounds match'),
        h('p', null, 'Try a shorter search, or clear it with Esc.')));
    }
  } else {
    const b = activeBoard();
    if (!b.sounds.length) {
      kids.push(h('div', { class: 'empty' },
        h('div', { class: 'drop-art' }, icon('drop')),
        h('h3', null, 'Drop audio files here'),
        h('p', null, 'Each file becomes a button you can click or trigger with a hotkey — even while you’re in a game.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => pickSounds('files') }, icon('plus'), 'Add sounds'),
          h('button', { class: 'btn', onclick: () => pickSounds('folder') }, 'Add a folder')),
        h('small', null, 'MP3, WAV, OGG, FLAC, M4A and more')));
    } else {
      for (const s of b.sounds) { const el = tileEl(s); ui.tileEls.set(s.id, el); kids.push(el); }
      kids.push(h('button', { class: 'add-tile', onclick: () => pickSounds('files') }, icon('plus'), 'Add sounds'));
    }
  }
  grid.replaceChildren(...kids);
  renderHead();
}

function renderAll() {
  renderBoards();
  renderGrid();
  renderShare();
  renderRoute();
}

// =====================================================================
// Sound actions
// =====================================================================
function soundMenu(sound, x, y) {
  const others = cfg.boards.filter((b) => !b.sounds.includes(sound));
  menu(x, y, [
    { label: 'Play', k: sound.hotkey ? hotkeyLabel(sound.hotkey) : '', run: () => playSound(sound) },
    { label: 'Preview (only you hear it)', run: () => playSound(sound, { preview: true }) },
    { label: 'Edit…', run: () => openEditor(sound.id) },
    { sep: true },
    { label: 'Duplicate', run: () => duplicateSound(sound.id) },
    { label: 'Replace audio file…', run: () => replaceAudio(sound.id) },
    ...(others.length ? [{ title: 'Move to' }, ...others.map((b) => ({ label: `${b.emoji || ''} ${b.name}`, run: () => moveSoundToBoard(sound.id, b.id) }))] : []),
    { sep: true },
    { label: 'Delete', danger: true, k: 'Del', run: () => deleteSound(sound.id) },
  ]);
}

function duplicateSound(id) {
  const f = findSound(id);
  if (!f) return;
  const copy = { ...structuredClone(f.sound), id: uid(), name: f.sound.name + ' copy', hotkey: '' };
  f.board.sounds.splice(f.index + 1, 0, copy);
  save();
  renderGrid(); renderBoards();
}

async function replaceAudio(id) {
  const f = findSound(id);
  if (!f) return;
  const added = await sk.pickSounds('files');
  if (!added || !added.length) return;
  const old = f.sound.file;
  engine.stop(id);
  Object.assign(f.sound, { file: added[0].file, start: 0, end: 0, duration: 0, peaks: null, missing: false });
  save();
  updateTile(f.sound);
  ensureMeta(f.sound);
  gcFiles([old, ...added.slice(1).map((a) => a.file)]);
}

function moveSoundToBoard(id, boardId) {
  const f = findSound(id);
  const target = cfg.boards.find((b) => b.id === boardId);
  if (!f || !target || f.board === target) return;
  f.board.sounds.splice(f.index, 1);
  target.sounds.push(f.sound);
  save();
  renderGrid(); renderBoards();
  toast(`Moved “${f.sound.name}” to ${target.name}.`);
}

function reorder(dragId, beforeId) {
  const a = findSound(dragId);
  const b = findSound(beforeId);
  if (!a || !b) return;
  a.board.sounds.splice(a.index, 1);
  const idx = b.board.sounds.indexOf(b.sound);
  b.board.sounds.splice(idx, 0, a.sound);
  save();
  renderGrid(); renderBoards();
}

function deleteSound(id) {
  const f = findSound(id);
  if (!f) return;
  engine.stop(id);
  f.board.sounds.splice(f.index, 1);
  if (ui.editing === id) closeDrawer();
  save({ hotkeys: true });
  renderGrid(); renderBoards();
  toast(`Deleted “${f.sound.name}”.`, {
    action: 'Undo',
    onAction: () => { f.board.sounds.splice(f.index, 0, f.sound); save({ hotkeys: true }); renderGrid(); renderBoards(); },
    onExpire: () => gcFiles([f.sound.file]),
    timeout: 7000,
  });
}

function gcFiles(files) {
  const used = new Set();
  for (const b of cfg.boards) for (const s of b.sounds) used.add(s.file);
  const dead = [...new Set(files)].filter((f) => f && !used.has(f));
  if (dead.length) {
    for (const f of dead) engine.forget(f);
    sk.removeSounds(dead);
  }
}

async function pickSounds(mode) {
  const added = await sk.pickSounds(mode);
  addImported(added, activeBoard());
}

async function importFiles(files, board = activeBoard()) {
  const paths = files.map((f) => sk.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const added = await sk.importPaths(paths);
  if (!added.length) { toast('None of those were audio files SoundKami can play.', { kind: 'warn' }); return; }
  addImported(added, board);
}

function addImported(added, board) {
  if (!added || !added.length) return;
  const start = board.sounds.length + cfg.boards.reduce((n, b) => n + b.sounds.length, 0);
  const sounds = added.map((a, i) => normalizeSound({
    id: uid(), name: a.name, file: a.file, emoji: '',
    color: TILE_COLORS[(start + i) % TILE_COLORS.length],
    mode: S().defaultMode,
  }));
  board.sounds.push(...sounds);
  save();
  if (board.id !== cfg.activeBoard && !ui.search) {
    toast(`Added ${sounds.length} sound${sounds.length === 1 ? '' : 's'} to ${board.name}.`);
  }
  renderGrid(); renderBoards();
  for (const s of sounds) ensureMeta(s);
}

// =====================================================================
// Board name editing
// =====================================================================
function startRenameBoard() {
  if (ui.search) return;
  const el = $('#board-name');
  const b = activeBoard();
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  const finish = (commit) => {
    el.contentEditable = 'false';
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    const name = el.textContent.trim().slice(0, 40);
    if (commit && name) { b.name = name; save(); }
    renderHead(); renderBoards();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

// =====================================================================
// Mixer
// =====================================================================
const mixer = {};
function channel({ key, label, sub, btnIcon, onBtn, btnTitle, max = 1.5, meter }) {
  const out = h('span', null, '');
  const fill = meter ? h('i') : null;
  const range = h('input', {
    type: 'range', min: 0, max: Math.round(max * 100), step: 1,
    'aria-label': label + ' volume',
    oninput: (e) => {
      S()[key] = e.target.value / 100;
      out.textContent = pct(S()[key]);
      engine.apply(S());
      persist();
    },
    ondblclick: (e) => { S()[key] = key === 'musicVolume' ? 0.45 : key === 'monitorVolume' ? 0.6 : key === 'soundVolume' ? 0.8 : 1; renderMixerValues(); engine.apply(S()); persist(); e.preventDefault(); },
  });
  if (!meter) range.classList.add('plain');
  const btn = h('button', { class: 'ch-btn', title: btnTitle, onclick: onBtn }, icon(btnIcon));
  const el = h('div', { class: 'ch', title: 'Double-click the slider to reset' },
    btn,
    h('div', { class: 'ch-label' }, h('span', null, label, sub ? h('span', { style: { color: 'var(--muted)', fontWeight: 450 } }, ` ${sub}`) : null), out),
    h('div', { class: 'fader' }, meter ? h('div', { class: 'meter' }, fill) : null, range));
  mixer[key] = { range, out, fill, btn };
  return el;
}

function buildMixer() {
  const root = $('#mixer');
  root.replaceChildren(
    channel({ key: 'micVolume', label: 'Mic', btnIcon: 'mic', btnTitle: 'Turn mic passthrough on or off', onBtn: toggleMic, meter: true }),
    channel({ key: 'soundVolume', label: 'Sounds', btnIcon: 'speaker', btnTitle: 'Stop all sounds', onBtn: stopAll, meter: true }),
    channel({
      key: 'monitorVolume', label: 'You hear', btnIcon: 'headphones', max: 1,
      btnTitle: 'Hear your sounds yourself',
      onBtn: () => { S().monitorSounds = !S().monitorSounds; save({ audio: true }); renderMixerValues(); },
    }),
    channel({ key: 'musicVolume', label: 'Shared audio', btnIcon: 'share', btnTitle: 'Choose apps to share', onBtn: (e) => openSharePicker(e.currentTarget), meter: true }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'route', id: 'route', onclick: () => openSettings('audio') }),
    h('button', { class: 'stop-all', id: 'stop-all', onclick: stopAll, title: 'Stop every sound that’s playing' },
      h('span', { class: 'sq' }), 'Stop all', h('kbd', { id: 'stop-all-key' })),
  );
  renderMixerValues();
}

function renderMixerValues() {
  const s = S();
  for (const key of ['micVolume', 'soundVolume', 'monitorVolume', 'musicVolume']) {
    const m = mixer[key];
    if (!m) continue;
    m.range.value = Math.round(s[key] * 100);
    m.out.textContent = pct(s[key]);
  }
  const micBtn = mixer.micVolume.btn;
  micBtn.replaceChildren(icon(s.micEnabled ? 'mic' : 'micOff'));
  micBtn.className = 'ch-btn ' + (s.micEnabled ? 'on' : 'off');
  micBtn.title = s.micEnabled ? 'Mic passthrough is on — click to mute' : 'Mic passthrough is off — click to turn on';
  const monBtn = mixer.monitorVolume.btn;
  monBtn.replaceChildren(icon(s.monitorSounds ? 'headphones' : 'headphonesOff'));
  monBtn.className = 'ch-btn ' + (s.monitorSounds ? '' : 'off');
  monBtn.title = s.monitorSounds ? 'You hear your sounds — click to stop hearing them' : 'You don’t hear your sounds — click to hear them';
  const k = $('#stop-all-key');
  if (k) { k.textContent = hotkeyLabel(s.stopAllHotkey); k.style.display = s.stopAllHotkey ? '' : 'none'; }
}

function renderRoute() {
  const el = $('#route');
  if (!el) return;
  const cable = cableDevice();
  el.className = 'route' + (cable ? '' : ' warn');
  el.replaceChildren(
    h('span', { class: 'dot' }),
    h('span', { class: 't' },
      h('b', null, cable ? 'Live to Discord' : 'Not connected to Discord'),
      h('span', null, cable ? `via ${deviceName(cable.label)}` : 'Set up a virtual cable')));
  el.title = cable ? `Mic, sounds and shared audio go to ${cable.label}. In Discord, choose “CABLE Output” as your input device.` : 'No virtual audio cable selected — click to fix';
}

// =====================================================================
// Shared app audio
// =====================================================================
const shareKey = (exe) => exe.toLowerCase();

function renderShare() {
  const root = $('#share-list');
  const list = S().share;
  if (!list.length) {
    root.replaceChildren(h('div', { class: 'share-empty' },
      'Play music from Spotify, a browser or any app straight into your voice channel.',
      h('div', null, h('button', { class: 'btn', onclick: (e) => openSharePicker(e.currentTarget) }, 'Choose an app'))));
    return;
  }
  root.replaceChildren(...list.map((a) => {
    const st = ui.share.get(a.key) || {};
    let status = 'Off';
    let cls = '';
    if (a.enabled) {
      if (st.status === 'live') { status = 'Sharing'; cls = 'live'; }
      else if (st.status === 'error') { status = st.error || 'Couldn’t capture'; cls = 'err'; }
      else if (st.status === 'starting') status = 'Connecting…';
      else status = 'Waiting for app to open';
    }
    return h('div', {
      class: 'share-app',
      title: st.error || '',
      oncontextmenu: (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [{ label: `Stop sharing ${a.name} and remove`, danger: true, run: () => removeShare(a.key) }]);
      },
    },
    st.icon ? h('img', { src: st.icon, alt: '' }) : h('span', { class: 'ph' }, a.name.slice(0, 1).toUpperCase()),
    h('div', { class: 'meta' }, h('b', null, a.name), h('span', { class: cls }, status)),
    h('input', {
      type: 'checkbox', class: 'switch', checked: !!a.enabled, 'aria-label': `Share ${a.name}`,
      onchange: (e) => setShareEnabled(a.key, e.target.checked),
    }));
  }));
}

async function openSharePicker(anchor) {
  if (!ui.info.captureSupported && !DEMO) {
    toast('Sharing app audio needs Windows 10 (version 2004) or newer.', { kind: 'warn' });
    return;
  }
  const pop = popover(anchor, h('div', { class: 'apps-pop' },
    h('header', null,
      h('b', null, 'Share an app’s audio'),
      h('span', null, 'Everyone in your voice channel hears it, mixed with your mic. Only apps that have played sound since they opened are listed.')),
    h('div', { class: 'list' }, h('div', { class: 'none' }, 'Looking for apps playing audio…')),
    h('footer', null,
      h('span', null, 'Discord itself is never listed.'),
      h('button', { class: 'btn ghost', onclick: () => fill() }, icon('refresh'), 'Refresh'))), { placement: 'top' });

  async function fill() {
    const listEl = $('.list', pop);
    const res = DEMO ? demoApps() : await sk.listAudioApps();
    const apps = res.apps || [];
    for (const a of apps) {
      const key = shareKey(a.exe);
      const st = ui.share.get(key) || {};
      if (a.icon) st.icon = a.icon;
      ui.share.set(key, st);
    }
    if (!apps.length) {
      listEl.replaceChildren(h('div', { class: 'none' }, 'No apps are playing audio right now. Start your music, then press Refresh.'));
      return;
    }
    listEl.replaceChildren(...apps.map((a) => {
      const key = shareKey(a.exe);
      const entry = S().share.find((x) => x.key === key);
      const on = !!(entry && entry.enabled);
      return h('label', { class: 'app-row' },
        a.icon ? h('img', { src: a.icon, alt: '' }) : h('span', { class: 'ph' }, (a.name || a.exe).slice(0, 1).toUpperCase()),
        h('span', { class: 'm' }, h('b', null, a.name || a.exe), h('span', { class: a.active ? 'on' : '' }, a.active ? 'Playing now' : a.exe)),
        h('input', {
          type: 'checkbox', class: 'switch', checked: on,
          onchange: (e) => {
            if (e.target.checked) addShare(a); else setShareEnabled(key, false);
          },
        }));
    }));
  }
  fill();
}

function addShare(app) {
  const key = shareKey(app.exe);
  let entry = S().share.find((x) => x.key === key);
  if (!entry) {
    entry = { key, exe: app.exe, name: app.name || app.exe.replace(/\.exe$/i, ''), enabled: true };
    S().share.push(entry);
  }
  entry.enabled = true;
  persist();
  startShare(entry, app.rootPid || app.pid);
  renderShare();
}

function setShareEnabled(key, on) {
  const entry = S().share.find((x) => x.key === key);
  if (!entry) return;
  entry.enabled = on;
  persist();
  if (on) startShare(entry); else stopShare(key);
  renderShare();
}

function removeShare(key) {
  stopShare(key);
  S().share = S().share.filter((x) => x.key !== key);
  persist();
  renderShare();
}

async function startShare(entry, pid) {
  const st = ui.share.get(entry.key) || {};
  ui.share.set(entry.key, st);
  if (DEMO) { st.status = 'live'; renderShare(); return; }
  if (st.status === 'starting') return;
  st.status = 'starting';
  if (!pid) {
    const res = await sk.listAudioApps();
    const app = (res.apps || []).find((a) => shareKey(a.exe) === entry.key);
    if (app && app.icon) st.icon = app.icon;
    pid = app ? (app.rootPid || app.pid) : 0;
  }
  if (!pid || !entry.enabled) { st.status = entry.enabled ? 'waiting' : 'off'; st.pid = 0; renderShare(); return; }
  st.pid = pid; st.error = '';
  engine.musicStart(entry.key);
  await sk.startMusic(entry.key, pid);
  renderShare();
}

function stopShare(key) {
  sk.stopMusic(key);
  engine.musicStop(key);
  const st = ui.share.get(key);
  if (st) { st.status = 'off'; st.pid = 0; }
}

function wireShareEvents() {
  sk.onMusicFormat((key, fmt) => {
    engine.musicFormat(key, fmt);
    const st = ui.share.get(key);
    if (st) { st.status = 'live'; st.error = ''; renderShare(); }
  });
  sk.onMusicData((key, chunk) => engine.musicData(key, chunk));
  sk.onMusicError((key, msg) => {
    const st = ui.share.get(key) || {};
    st.status = 'error'; st.error = msg; st.retryAt = Date.now() + 15000;
    ui.share.set(key, st);
    renderShare();
  });
  sk.onMusicEnded((key) => {
    engine.musicStop(key);
    const st = ui.share.get(key);
    if (st && st.status !== 'error') st.status = 'waiting';
    renderShare();
  });
  // Re-attach to apps that were closed and reopened.
  setInterval(() => {
    if (DEMO) return;
    for (const entry of S().share) {
      if (!entry.enabled) continue;
      const st = ui.share.get(entry.key) || {};
      if (st.status === 'live' || st.status === 'starting') continue;
      if (st.status === 'error' && Date.now() < (st.retryAt || 0)) continue;
      startShare(entry);
    }
  }, 5000);
}

function demoApps() {
  return { supported: true, apps: [
    { exe: 'Spotify.exe', name: 'Spotify', pid: 1, rootPid: 1, active: true },
    { exe: 'chrome.exe', name: 'Google Chrome', pid: 2, rootPid: 2, active: false },
    { exe: 'vlc.exe', name: 'VLC media player', pid: 3, rootPid: 3, active: false },
  ] };
}

// =====================================================================
// Sound editor drawer
// =====================================================================
function openEditor(id) {
  const f = findSound(id);
  if (!f) return;
  ui.editing = id;
  const sound = f.sound;
  const drawer = $('#drawer');
  const commit = (opts) => { save(opts); updateTile(sound); };

  const nameInput = h('input', {
    class: 'text', value: sound.name, maxlength: 60, spellcheck: 'false',
    oninput: (e) => { sound.name = e.target.value || 'Untitled'; commit(); },
  });
  const emojiBtn = h('button', {
    class: 'emoji-btn', title: 'Choose an emoji',
    onclick: (e) => emojiPicker(e.currentTarget, null, (em) => { sound.emoji = em; emojiBtn.textContent = em || '＋'; commit(); }, true),
  }, sound.emoji || '＋');

  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => {
    swatches.replaceChildren(...TILE_COLORS.map((c) => h('button', {
      class: 'swatch' + (sound.color === c ? ' on' : ''), style: { '--sw': c }, title: c,
      onclick: () => { sound.color = c; drawer.style.setProperty('--c', c); commit(); drawSwatches(); },
    })), h('label', { class: 'swatch custom' + (TILE_COLORS.includes(sound.color) ? '' : ' on'), title: 'Custom colour', style: { '--sw': sound.color } },
      h('input', { type: 'color', value: sound.color, oninput: (e) => { sound.color = e.target.value; drawer.style.setProperty('--c', sound.color); commit(); } })));
  };
  drawSwatches();
  drawer.style.setProperty('--c', sound.color);

  const volOut = h('output', null, pct(sound.volume));
  const vol = h('input', {
    type: 'range', class: 'plain', min: 0, max: 200, value: Math.round(sound.volume * 100),
    oninput: (e) => { sound.volume = e.target.value / 100; volOut.textContent = pct(sound.volume); commit(); },
  });

  const hk = hotkeyInput(sound.hotkey, (accel) => {
    if (accel && conflictWith(accel, 'sound:' + sound.id)) {
      toast(`${hotkeyLabel(accel)} is already used by ${conflictWith(accel, 'sound:' + sound.id)}.`, { kind: 'warn' });
      return false;
    }
    sound.hotkey = accel; commit({ hotkeys: true });
    return true;
  });

  const modeSeg = seg([['restart', 'Restart'], ['stop', 'Stop'], ['overlap', 'Layer']], sound.mode, (v) => { sound.mode = v; commit(); });
  const loopSw = h('input', { type: 'checkbox', class: 'switch', checked: sound.loop, onchange: (e) => { sound.loop = e.target.checked; commit(); } });

  const boardSel = h('select', {
    class: 'text',
    onchange: (e) => { moveSoundToBoard(sound.id, e.target.value); },
  }, cfg.boards.map((b) => h('option', { value: b.id, selected: b === f.board }, `${b.emoji || ''} ${b.name}`)));

  const trim = trimmer(sound, () => commit());

  drawer.replaceChildren(
    h('div', { class: 'drawer-head' },
      h('h3', null, 'Edit sound'),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeDrawer }, icon('x'))),
    h('div', { class: 'drawer-body' },
      h('div', { class: 'field' }, h('label', null, 'Name'), h('div', { class: 'name-row' }, emojiBtn, nameInput)),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Colour'), swatches),
      trim.el,
      h('div', { class: 'field' }, h('label', null, 'Volume', h('span', null, 'Relative to the Sounds slider')), h('div', { class: 'range-row' }, vol, volOut)),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Hotkey', h('span', null, 'Works while you’re in other apps')), hk),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Pressing it again while it plays'), modeSeg,
        h('div', { class: 'hint' }, { restart: 'Starts the sound over from the beginning.', stop: 'Stops it — handy for long clips and music beds.', overlap: 'Plays another copy on top.' }[sound.mode])),
      h('div', { class: 'check-row' }, h('div', { class: 'txt' }, h('b', null, 'Loop'), h('span', null, 'Repeats the trimmed part until you stop it.')), loopSw),
      h('div', { class: 'field' }, h('label', null, 'Board'), boardSel)),
    h('div', { class: 'drawer-foot' },
      h('button', { class: 'btn ghost danger', onclick: () => deleteSound(sound.id) }, icon('trash'), 'Delete'),
      h('button', { class: 'btn ghost', onclick: () => duplicateSound(sound.id) }, 'Duplicate'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: closeDrawer }, 'Done')),
  );
  // Update the mode hint on change
  modeSeg.addEventListener('click', () => {
    const hint = modeSeg.nextElementSibling;
    if (hint) hint.textContent = { restart: 'Starts the sound over from the beginning.', stop: 'Stops it — handy for long clips and music beds.', overlap: 'Plays another copy on top.' }[sound.mode];
  });
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  trim.load();
}

function closeDrawer() {
  const d = $('#drawer');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  ui.editing = null;
  if (ui.trimRaf) cancelAnimationFrame(ui.trimRaf);
}

function conflictWith(accel, selfId) {
  if (S().stopAllHotkey === accel && selfId !== 'stopAll') return 'Stop all';
  if (S().micHotkey === accel && selfId !== 'toggleMic') return 'the mic toggle';
  for (const b of cfg.boards) for (const s of b.sounds) if (s.hotkey === accel && 'sound:' + s.id !== selfId) return `“${s.name}”`;
  return null;
}

function seg(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const draw = (v) => el.replaceChildren(...options.map(([val, label]) => h('button', {
    class: v === val ? 'on' : '', role: 'radio', 'aria-checked': String(v === val),
    onclick: () => { onChange(val); draw(val); },
  }, label)));
  draw(value);
  return el;
}

function hotkeyInput(value, onSet) {
  let current = value;
  let listening = false;
  const el = h('button', { class: 'hotkey' });
  const draw = (hint) => {
    el.classList.toggle('listening', listening);
    el.classList.toggle('has', !!current && !listening);
    el.replaceChildren(
      listening ? (hint || 'Press a key combination…') : current ? h('kbd', null, hotkeyLabel(current)) : 'Click to set a hotkey',
      !listening && current ? h('span', { class: 'clear', role: 'button', onclick: (e) => { e.stopPropagation(); if (onSet('') !== false) { current = ''; draw(); } } }, 'Clear') : null,
    );
  };
  const stop = () => {
    listening = false;
    window.removeEventListener('keydown', onKey, true);
    el.removeEventListener('blur', stop);
    syncHotkeys(true);
    draw();
  };
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return stop();
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (onSet('') !== false) current = '';
      return stop();
    }
    const r = accelFromEvent(e);
    if (!r) return draw('That key can’t be used — try another');
    if (r.error) return draw(r.error);
    if (onSet(r.accel) !== false) current = r.accel;
    stop();
  };
  el.addEventListener('click', () => {
    if (listening) return;
    listening = true;
    sk.pauseHotkeys(); // so pressing an existing hotkey doesn't fire it
    lastHotkeySig = '';
    window.addEventListener('keydown', onKey, true);
    el.addEventListener('blur', stop);
    draw();
  });
  draw();
  return el;
}

// Waveform with draggable start/end handles.
function trimmer(sound, onChange) {
  const canvas = h('canvas');
  const shadeL = h('div', { class: 'trim-shade', style: { left: '0' } });
  const shadeR = h('div', { class: 'trim-shade', style: { right: '0' } });
  const hs = h('div', { class: 'trim-handle', title: 'Drag to set the start' });
  const he = h('div', { class: 'trim-handle', title: 'Drag to set the end' });
  const head = h('div', { class: 'trim-head' });
  const view = h('div', { class: 'trim-view' }, canvas, shadeL, shadeR, hs, he, head);
  const info = h('div', { class: 'trim-info' });
  const playBtn = h('button', { class: 'btn', title: 'Only you hear the preview', onclick: () => playSound(sound, { preview: true }) }, icon('play'), 'Preview');
  const resetBtn = h('button', { class: 'btn ghost', onclick: () => { sound.start = 0; sound.end = 0; layout(); onChange(); } }, 'Reset trim');
  const el = h('div', { class: 'field trim' },
    h('div', { class: 'lbl' }, 'Trim', h('span', null, 'Drag the handles')),
    view, info,
    h('div', { style: { display: 'flex', gap: '8px' } }, playBtn, resetBtn));

  let dur = sound.duration || 0;
  let peaks = null;

  const startT = () => sound.start || 0;
  const endT = () => (sound.end && sound.end > startT() ? Math.min(sound.end, dur) : dur);

  function layout() {
    if (!dur) { info.textContent = 'Loading waveform…'; return; }
    const a = (startT() / dur) * 100;
    const b = (endT() / dur) * 100;
    hs.style.left = a + '%';
    he.style.left = b + '%';
    shadeL.style.width = a + '%';
    shadeR.style.width = (100 - b) + '%';
    info.replaceChildren(
      h('span', null, 'Start ', h('b', null, startT().toFixed(2) + 's')),
      h('span', null, 'Length ', h('b', null, (endT() - startT()).toFixed(2) + 's')),
      h('span', null, 'End ', h('b', null, endT().toFixed(2) + 's')));
  }

  function draw() {
    const r = view.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!peaks) return;
    g.fillStyle = sound.color;
    const n = peaks.length;
    const bw = canvas.width / n;
    const mid = canvas.height / 2;
    for (let i = 0; i < n; i++) {
      const hh = Math.max(1.5 * dpr, (peaks[i] / 100) * (canvas.height * 0.86) / 2);
      g.fillRect(i * bw + bw * 0.15, mid - hh, Math.max(1, bw * 0.7), hh * 2);
    }
  }

  function drag(handle, which) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = view.getBoundingClientRect();
        const t = clamp((ev.clientX - r.left) / r.width, 0, 1) * dur;
        if (which === 'start') sound.start = clamp(t, 0, endT() - 0.05);
        else { const v = clamp(t, startT() + 0.05, dur); sound.end = v >= dur - 0.005 ? 0 : v; }
        layout();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        onChange();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  drag(hs, 'start');
  drag(he, 'end');

  // Click inside the waveform to preview from that point.
  view.addEventListener('pointerdown', (e) => {
    if (e.target !== view && e.target !== canvas) return;
    const r = view.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * dur;
    if (!dur) return;
    playSound({ ...sound, start: Math.max(startT(), Math.min(t, endT() - 0.05)), end: endT(), loop: false }, { preview: true });
  });

  // Playhead for whichever voice of this sound is playing
  function tick() {
    const p1 = engine.progress(sound.id);
    const p2 = engine.progress('preview:' + sound.id);
    const p = p2 >= 0 ? p2 : p1;
    if (p >= 0 && dur) {
      head.style.display = 'block';
      head.style.left = (((startT() + p * (endT() - startT())) / dur) * 100) + '%';
    } else head.style.display = 'none';
    ui.trimRaf = requestAnimationFrame(tick);
  }

  async function load() {
    layout();
    try {
      const buf = await engine.getBuffer(sound.file);
      dur = buf.duration;
      sound.duration = dur;
      peaks = AudioEngine.peaks(buf, Math.min(260, Math.max(60, Math.round(view.clientWidth / 1.6))));
      layout();
      draw();
    } catch {
      info.textContent = 'This file couldn’t be decoded.';
    }
    if (ui.trimRaf) cancelAnimationFrame(ui.trimRaf);
    tick();
  }
  return { el, load };
}

// =====================================================================
// Settings
// =====================================================================
function openSettings(section = 'audio') {
  closeLayer();
  const nav = [['audio', 'Audio routing'], ['mic', 'Microphone'], ['playback', 'Playback & hotkeys'], ['look', 'Appearance'], ['app', 'App']];
  const body = h('div', { class: 'modal-body' });
  const title = h('h3');
  const navEl = h('nav', { class: 'modal-nav' }, h('h2', null, 'Settings'));
  const buttons = nav.map(([id, label]) => h('button', { onclick: () => show(id) }, label));
  navEl.append(...buttons, h('div', { class: 'grow' }), h('div', { class: 'ver' }, `SoundKami ${ui.info.version || ''}`));

  function show(id) {
    nav.forEach(([nid], i) => buttons[i].classList.toggle('on', nid === id));
    title.textContent = nav.find((n) => n[0] === id)[1];
    body.replaceChildren(...SECTIONS[id]());
    body.scrollTop = 0;
  }

  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
    navEl,
    h('div', { class: 'modal-main' },
      h('div', { class: 'modal-top' }, title, h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closeLayer }, icon('x'))),
      body));
  openLayer(modal);
  show(section);
  ui.rerenderSettings = () => { const on = buttons.findIndex((b) => b.classList.contains('on')); show(nav[on][0]); };
}

function deviceSelect(list, value, onChange, { includeNone = false, noneLabel = 'None' } = {}) {
  return h('select', { class: 'text', onchange: (e) => onChange(e.target.value) },
    includeNone ? h('option', { value: '', selected: !value }, noneLabel) : null,
    list.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === value }, d.label || 'Unnamed device')));
}

function checkRow(title, desc, checked, onChange) {
  return h('div', { class: 'check-row' },
    h('div', { class: 'txt' }, h('b', null, title), desc ? h('span', null, desc) : null),
    h('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => onChange(e.target.checked) }));
}

const SECTIONS = {
  audio() {
    const s = S();
    const cable = cableDevice();
    const outputs = ui.devices.outputs;
    const inputs = ui.devices.inputs;
    return [
      h('div', { class: 'group' },
        h('div', { class: 'flow' }, h('span', null, 'Mic + sounds + shared audio'), h('em', null, '→'), h('span', null, 'Virtual cable'), h('em', null, '→'), h('span', null, 'Discord')),
        h('div', { class: 'field' },
          h('label', null, 'Send to Discord through', h('span', null, 'A virtual audio cable')),
          h('div', { class: 'device-row' },
            deviceSelect(outputs.filter((d) => d.deviceId !== 'default'), s.cableId, (v) => {
              const d = outputs.find((x) => x.deviceId === v);
              s.cableId = v; s.cableLabel = d ? d.label : '';
              save({ audio: true }); renderRoute(); ui.rerenderSettings();
            }, { includeNone: true, noneLabel: 'Not selected' }),
            h('button', { class: 'btn', onclick: () => engine.testTone('cable'), disabled: !cable, title: 'Plays a short beep into Discord' }, 'Test')),
          cable
            ? h('div', { class: 'status-line' }, h('span', { class: 'dot' }), h('span', null, `In Discord → Voice & Video, set Input Device to `, h('b', null, cable.label.replace(/input/i, 'Output')), '.'))
            : h('div', { class: 'status-line warn' }, h('span', { class: 'dot' }), h('span', null, 'No virtual cable found. Install the free VB-CABLE driver, then restart SoundKami.')),
          !cable ? h('div', null, h('button', { class: 'btn primary', onclick: () => sk.openExternal('https://vb-audio.com/Cable/') }, 'Get VB-CABLE (free)')) : null),
        h('div', { class: 'field' },
          h('label', null, 'Your microphone'),
          deviceSelect(inputs, s.micId, (v) => {
            const d = inputs.find((x) => x.deviceId === v);
            s.micId = v; s.micLabel = d ? d.label : '';
            if (d && CABLE_OUT_RE.test(d.label)) toast('That’s the virtual cable itself — pick your real microphone or you’ll create an echo loop.', { kind: 'warn' });
            save({ audio: true });
          })),
        h('div', { class: 'field' },
          h('label', null, 'You hear sounds on', h('span', null, 'Your headphones or speakers')),
          h('div', { class: 'device-row' },
            deviceSelect(outputs, s.monitorId, (v) => {
              const d = outputs.find((x) => x.deviceId === v);
              s.monitorId = v; s.monitorLabel = d ? d.label : '';
              if (d && isVirtualOut(d.label)) toast('That’s the virtual cable — choose your headphones so you can hear yourself.', { kind: 'warn' });
              save({ audio: true });
            }),
            h('button', { class: 'btn', onclick: () => engine.testTone('monitor') }, 'Test')))),
      h('div', { class: 'group' },
        h('h4', null, 'Discord settings that matter'),
        h('div', { class: 'callout' },
          'In ', h('b', null, 'Discord → User Settings → Voice & Video'), ': turn off ', h('b', null, 'Noise Suppression'), ' and ', h('b', null, 'Echo Cancellation'),
          ' (they filter out music and sound effects), and use ', h('b', null, 'Voice Activity'), ' so sounds are sent without holding push-to-talk.'),
        h('div', null, h('button', { class: 'btn', onclick: () => { closeLayer(); openWizard(); } }, 'Run setup again'))),
    ];
  },
  mic() {
    const s = S();
    const p = s.micProcessing;
    const set = (k) => (v) => { p[k] = v; save({ audio: true }); };
    return [
      h('div', { class: 'group' },
        checkRow('Mic passthrough', 'Sends your voice to Discord along with your sounds. Turn off if you only want to play sounds.', s.micEnabled, (v) => { s.micEnabled = v; save({ audio: true }); renderMixerValues(); }),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Mute / unmute hotkey'), hotkeyInput(s.micHotkey, (a) => {
          if (a && conflictWith(a, 'toggleMic')) { toast(`${hotkeyLabel(a)} is already used by ${conflictWith(a, 'toggleMic')}.`, { kind: 'warn' }); return false; }
          s.micHotkey = a; save({ hotkeys: true }); return true;
        }))),
      h('div', { class: 'group' },
        checkRow('Lower my mic while sounds play', 'Makes sounds easier to hear over your voice.', s.duckMic, (v) => { s.duckMic = v; save({ audio: true }); ui.rerenderSettings(); }),
        s.duckMic ? h('div', { class: 'field' }, h('label', null, 'Mic level during sounds'), (() => {
          const out = h('output', null, pct(s.duckAmount));
          return h('div', { class: 'range-row' }, h('input', { type: 'range', class: 'plain', min: 0, max: 100, value: Math.round(s.duckAmount * 100), oninput: (e) => { s.duckAmount = e.target.value / 100; out.textContent = pct(s.duckAmount); save({ audio: true }); } }), out);
        })()) : null),
      h('div', { class: 'group' },
        h('h4', null, 'Voice processing'),
        h('div', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12px', lineHeight: 1.5 } }, 'Discord already processes your voice, so these are off by default. Turn one on only if Discord’s own version is off.'),
        checkRow('Noise suppression', null, p.noiseSuppression, set('noiseSuppression')),
        checkRow('Echo cancellation', null, p.echoCancellation, set('echoCancellation')),
        checkRow('Automatic gain', null, p.autoGainControl, set('autoGainControl'))),
    ];
  },
  playback() {
    const s = S();
    return [
      h('div', { class: 'group' },
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'When a sound starts'),
          seg([['overlap', 'Play over other sounds'], ['cut', 'Stop other sounds']], s.overlap, (v) => { s.overlap = v; save({ audio: true }); })),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'New sounds: pressing again while playing'),
          seg([['restart', 'Restart'], ['stop', 'Stop'], ['overlap', 'Layer']], s.defaultMode, (v) => { s.defaultMode = v; save(); })),
        checkRow('Hear sounds yourself', 'Plays sounds on your headphones too, so you know what others hear.', s.monitorSounds, (v) => { s.monitorSounds = v; save({ audio: true }); renderMixerValues(); })),
      h('div', { class: 'group' },
        h('h4', null, 'Hotkeys'),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Stop all sounds'), hotkeyInput(s.stopAllHotkey, (a) => {
          if (a && conflictWith(a, 'stopAll')) { toast(`${hotkeyLabel(a)} is already used by ${conflictWith(a, 'stopAll')}.`, { kind: 'warn' }); return false; }
          s.stopAllHotkey = a; save({ hotkeys: true }); renderMixerValues(); return true;
        })),
        h('div', { class: 'callout' }, 'Sound hotkeys are set per sound in its editor. They work everywhere, including in games. Numpad keys and F13–F24 work without Ctrl/Alt/Shift.')),
    ];
  },
  look() {
    const s = S();
    const accentRow = h('div', { class: 'swatches' });
    const drawAccents = () => accentRow.replaceChildren(...ACCENTS.map(([name, c]) => h('button', {
      class: 'swatch' + (s.accent === c ? ' on' : ''), style: { '--sw': c }, title: name,
      onclick: () => { s.accent = c; save(); applyTheme(); drawAccents(); },
    })), h('label', { class: 'swatch custom' + (ACCENTS.some((a) => a[1] === s.accent) ? '' : ' on'), title: 'Custom', style: { '--sw': s.accent } },
      h('input', { type: 'color', value: s.accent, oninput: (e) => { s.accent = e.target.value; save(); applyTheme(); } })));
    drawAccents();
    return [
      h('div', { class: 'group' },
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Theme'), seg([['system', 'Match Windows'], ['dark', 'Dark'], ['light', 'Light']], s.theme, (v) => { s.theme = v; save(); applyTheme(); })),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Accent colour'), accentRow),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Button size'), seg([['s', 'Compact'], ['m', 'Comfortable'], ['l', 'Large']], s.tileSize, (v) => { s.tileSize = v; save(); applyTheme(); }))),
      h('div', { class: 'group' },
        checkRow('Show hotkeys on buttons', null, s.showHotkeys, (v) => { s.showHotkeys = v; save(); renderGrid(); }),
        checkRow('Show lengths on buttons', null, s.showDurations, (v) => { s.showDurations = v; save(); renderGrid(); })),
    ];
  },
  app() {
    const s = S();
    return [
      h('div', { class: 'group' },
        checkRow('Launch when Windows starts', 'Starts quietly in the tray so your hotkeys are always ready.', s.launchAtStartup, (v) => { s.launchAtStartup = v; save(); }),
        checkRow('Start minimised to the tray', null, s.startMinimized, (v) => { s.startMinimized = v; save(); }),
        checkRow('Closing the window keeps SoundKami running', 'Hotkeys and shared audio keep working from the tray. Quit from the tray icon.', s.closeToTray, (v) => { s.closeToTray = v; save(); }),
        checkRow('Keep the window on top', null, s.alwaysOnTop, (v) => { s.alwaysOnTop = v; save(); })),
      h('div', { class: 'group' },
        h('h4', null, 'Your sounds'),
        h('div', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12px', lineHeight: 1.5 } }, 'SoundKami keeps its own copy of every sound you add, so moving or deleting the original won’t break a button.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => sk.openLibraryFolder() }, 'Open sounds folder'),
          h('button', { class: 'btn', onclick: () => { closeLayer(); importBoard(); } }, 'Import a board…'),
          h('button', { class: 'btn', onclick: () => exportBoard(activeBoard()) }, 'Export this board…'))),
      h('div', { class: 'group' },
        h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn danger', onclick: () => sk.quit() }, 'Quit SoundKami'))),
    ];
  },
};

// =====================================================================
// First-run setup
// =====================================================================
function openWizard() {
  closeLayer();
  let step = 0;
  const top = h('div', { class: 'wizard-top' });
  const body = h('div', { class: 'wizard-body' });
  const foot = h('div', { class: 'wizard-foot' });
  const modal = h('div', { class: 'modal wizard', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set up SoundKami' }, top, body, foot);
  openLayer(modal, { dismissable: false });

  const steps = [
    () => {
      const cable = detectCable();
      return {
        kicker: 'Step 1 of 3',
        title: 'Install a virtual audio cable',
        body: [
          h('p', null, 'Discord only listens to one microphone. SoundKami mixes your real mic, your sounds and any music you share into a virtual cable, and Discord uses that cable as your mic.'),
          h('div', { class: 'flow' }, h('span', null, 'Mic + sounds + music'), h('em', null, '→'), h('span', null, 'CABLE Input'), h('em', null, '→'), h('span', null, 'CABLE Output'), h('em', null, '→'), h('span', null, 'Discord')),
          cable
            ? h('div', { class: 'status-line' }, h('span', { class: 'dot' }), h('span', null, 'Found ', h('b', null, cable.label), '. You’re good to go.'))
            : h('div', { class: 'callout warn' },
              h('ol', null,
                h('li', null, 'Download ', h('b', null, 'VB-CABLE'), ' (free) and unzip it.'),
                h('li', null, 'Right-click ', h('b', null, 'VBCABLE_Setup_x64.exe'), ' → Run as administrator → Install Driver.'),
                h('li', null, 'Restart your PC, then open SoundKami again.'))),
        ],
        actions: cable ? [] : [
          h('button', { class: 'btn', onclick: async () => { await refreshDevices(); render(); } }, icon('refresh'), 'Check again'),
          h('button', { class: 'btn primary', onclick: () => sk.openExternal('https://vb-audio.com/Cable/') }, 'Download VB-CABLE'),
        ],
        canNext: true,
        nextLabel: 'Next',
      };
    },
    () => ({
      kicker: 'Step 2 of 3',
      title: 'Choose your devices',
      body: [
        h('div', { class: 'field' }, h('label', null, 'Your microphone'), deviceSelect(ui.devices.inputs, S().micId, (v) => {
          const d = ui.devices.inputs.find((x) => x.deviceId === v); S().micId = v; S().micLabel = d ? d.label : ''; save({ audio: true });
        })),
        h('div', { class: 'field' }, h('label', null, 'Virtual cable', h('span', null, 'Usually “CABLE Input”')), deviceSelect(ui.devices.outputs.filter((d) => d.deviceId !== 'default'), S().cableId, (v) => {
          const d = ui.devices.outputs.find((x) => x.deviceId === v); S().cableId = v; S().cableLabel = d ? d.label : ''; save({ audio: true }); renderRoute();
        }, { includeNone: true, noneLabel: 'Not selected' })),
        h('div', { class: 'field' }, h('label', null, 'Your headphones', h('span', null, 'Where you hear your sounds')), deviceSelect(ui.devices.outputs, S().monitorId, (v) => {
          const d = ui.devices.outputs.find((x) => x.deviceId === v); S().monitorId = v; S().monitorLabel = d ? d.label : ''; save({ audio: true });
        })),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'btn', onclick: () => engine.testTone('monitor') }, 'Test headphones')),
      ],
      canNext: true,
      nextLabel: 'Next',
    }),
    () => ({
      kicker: 'Step 3 of 3',
      title: 'Point Discord at SoundKami',
      body: [
        h('ol', null,
          h('li', null, 'Open ', h('b', null, 'Discord → User Settings → Voice & Video'), '.'),
          h('li', null, 'Set ', h('b', null, 'Input Device'), ' to ', h('b', null, (cableDevice()?.label || 'CABLE Input').replace(/input/i, 'Output')), '.'),
          h('li', null, 'Turn off ', h('b', null, 'Noise Suppression'), ' and ', h('b', null, 'Echo Cancellation'), ' so music and effects come through clearly.'),
          h('li', null, 'Use ', h('b', null, 'Voice Activity'), ' — or hold push-to-talk while you play a sound.')),
        h('div', { class: 'callout' }, 'Then drop some audio files into SoundKami and give them hotkeys. To play music for everyone, use ', h('b', null, 'Shared audio'), ' in the sidebar.'),
      ],
      canNext: true,
      nextLabel: 'Finish',
    }),
  ];

  function render() {
    const st = steps[step]();
    top.replaceChildren(
      h('div', { class: 'steps' }, steps.map((_, i) => h('i', { class: i <= step ? 'on' : '' }))),
      h('div', { class: 'kicker' }, st.kicker),
      h('h3', null, st.title));
    body.replaceChildren(...st.body);
    foot.replaceChildren(
      step > 0 ? h('button', { class: 'btn ghost', onclick: () => { step--; render(); } }, 'Back') : h('button', { class: 'btn ghost', onclick: finish }, 'Skip setup'),
      h('span', { class: 'grow' }),
      ...(st.actions || []),
      h('button', { class: 'btn ' + ((st.actions || []).length ? '' : 'primary'), onclick: () => { if (step === steps.length - 1) finish(); else { step++; render(); } } }, st.nextLabel));
  }
  function finish() {
    S().setupDone = true;
    save();
    closeLayer();
  }
  render();
}

// =====================================================================
// Layers: menus, popovers, modals, toasts
// =====================================================================
let layerCleanup = null;
function openLayer(content, { dismissable = true } = {}) {
  closeLayer();
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (dismissable && e.target === scrim) closeLayer(); } }, content);
  $('#layer').replaceChildren(scrim);
  layerCleanup = () => $('#layer').replaceChildren();
  content.tabIndex = -1;
  content.focus({ preventScroll: true });
}
function closeLayer() {
  if (layerCleanup) { layerCleanup(); layerCleanup = null; }
  ui.rerenderSettings = () => {};
}

let floating = null;
function closeFloating() {
  if (floating) { floating.remove(); floating = null; document.removeEventListener('mousedown', outside, true); }
}
function outside(e) { if (floating && !floating.contains(e.target)) closeFloating(); }
function place(el, x, y, anchor, placement) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    x = a.left;
    y = placement === 'top' ? a.top - r.height - 6 : a.bottom + 6;
    if (placement === 'top' && y < 46) y = a.bottom + 6;
  }
  el.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
  el.style.top = clamp(y, 8, innerHeight - r.height - 8) + 'px';
  floating = el;
  setTimeout(() => document.addEventListener('mousedown', outside, true));
}

function menu(x, y, items) {
  closeFloating();
  const el = h('div', { class: 'menu', role: 'menu' }, items.map((it) => {
    if (it.sep) return h('hr');
    if (it.title) return h('div', { class: 'menu-title' }, it.title);
    return h('button', {
      role: 'menuitem', class: it.danger ? 'danger' : '', disabled: !!it.disabled,
      style: it.disabled ? { opacity: '.4', pointerEvents: 'none' } : null,
      onclick: () => { closeFloating(); it.run(); },
    }, it.label, it.k ? h('span', { class: 'k' }, it.k) : null);
  }));
  place(el, x, y);
  el.querySelector('button')?.focus();
}

function popover(anchor, content, { placement = 'bottom' } = {}) {
  closeFloating();
  const el = h('div', { class: 'popover' }, content);
  place(el, 0, 0, anchor, placement);
  return el;
}

function emojiPicker(anchorOrX, y, onPick, allowNone = false) {
  const custom = h('input', { class: 'text', placeholder: 'Or type / paste any emoji', maxlength: 8 });
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter' && custom.value.trim()) { onPick(custom.value.trim()); closeFloating(); } });
  const content = h('div', { class: 'emoji-pop' },
    h('div', { class: 'emoji-grid' }, EMOJI.map((em) => h('button', { onclick: () => { onPick(em); closeFloating(); } }, em))),
    custom,
    allowNone ? h('button', { class: 'btn ghost', onclick: () => { onPick(''); closeFloating(); } }, 'No emoji') : null);
  closeFloating();
  const el = h('div', { class: 'popover' }, content);
  if (anchorOrX instanceof Element) place(el, 0, 0, anchorOrX, 'bottom');
  else place(el, anchorOrX, y);
}

function toast(text, { kind = '', action, onAction, onExpire, timeout = 4200 } = {}) {
  const root = $('#toasts');
  let done = false;
  const el = h('div', { class: 'toast ' + kind, role: 'status' }, h('span', null, text),
    action ? h('button', { onclick: () => { done = true; el.remove(); onAction && onAction(); } }, action) : null);
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => {
    el.remove();
    if (!done && onExpire) onExpire();
  }, timeout);
}

// =====================================================================
// Global UI events
// =====================================================================
function wireEvents() {
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-new-board').addEventListener('click', newBoard);
  $('#btn-add').addEventListener('click', () => pickSounds('files'));
  $('#btn-share').addEventListener('click', (e) => openSharePicker(e.currentTarget));
  $('#board-name').addEventListener('click', () => { if ($('#board-name').contentEditable !== 'true') startRenameBoard(); });
  $('#board-emoji').addEventListener('click', (e) => emojiPicker(e.currentTarget, null, (em) => { activeBoard().emoji = em; save(); renderAll(); }));
  $('#btn-board-menu').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.right - 220, r.bottom + 6, [
      { label: 'Add sounds…', run: () => pickSounds('files') },
      { label: 'Add a folder of sounds…', run: () => pickSounds('folder') },
      { sep: true },
      { label: 'Import a board…', run: importBoard },
      { label: 'Export this board…', run: () => exportBoard(activeBoard()) },
      { label: 'Open sounds folder', run: () => sk.openLibraryFolder() },
      { sep: true },
      { label: 'Delete this board', danger: true, disabled: cfg.boards.length === 1, run: () => deleteBoard(activeBoard()) },
    ]);
  });

  const search = $('#search');
  search.addEventListener('input', debounce(() => {
    ui.search = search.value.trim();
    closeDrawer();
    renderGrid(); renderBoards();
  }, 80));

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); return; }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (e.key === 'Escape') {
      if (floating) return closeFloating();
      if ($('#layer').children.length) { if (!$('.wizard')) closeLayer(); return; }
      if ($('#drawer').classList.contains('open')) return closeDrawer();
      if (ui.search || document.activeElement === search) { search.value = ''; ui.search = ''; search.blur(); renderGrid(); renderBoards(); return; }
      stopAll();
    }
    if (e.key === 'Delete' && document.activeElement?.classList.contains('tile')) {
      deleteSound(document.activeElement.dataset.id);
    }
  });

  // Drag files in from Explorer
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('#drop-veil').classList.add('on'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) hideVeil(); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; hideVeil();
    await importFiles([...e.dataTransfer.files]);
  });

  sk.onHotkey(onHotkey);
  sk.onCommand((cmd) => {
    if (cmd === 'stopAll') stopAll();
    if (cmd === 'toggleMic') toggleMic();
  });

  engine.on((type, data) => {
    if (type === 'mic' && !data.ok) toast(`Couldn’t open your microphone: ${data.message}`, { kind: 'err' });
    if (type === 'error' && data.where === 'cable') toast('Couldn’t send audio to the virtual cable. Check it in Settings → Audio routing.', { kind: 'err' });
  });
}
function hideVeil() { $('#drop-veil').classList.remove('on'); }

// =====================================================================
// Animation loop: progress ink + meters
// =====================================================================
function frame() {
  for (const [id, el] of ui.tileEls) {
    const p = engine.progress(id);
    if (p >= 0) {
      if (!el.classList.contains('playing')) el.classList.add('playing');
      el.style.setProperty('--p', p.toFixed(4));
    } else if (el.classList.contains('playing')) {
      el.classList.remove('playing');
      el.style.setProperty('--p', 0);
    }
  }
  const lv = engine.levels();
  if (mixer.micVolume?.fill) mixer.micVolume.fill.style.transform = `scaleX(${S().micEnabled ? lv.mic.toFixed(3) : 0})`;
  if (mixer.soundVolume?.fill) mixer.soundVolume.fill.style.transform = `scaleX(${lv.sounds.toFixed(3)})`;
  if (mixer.musicVolume?.fill) mixer.musicVolume.fill.style.transform = `scaleX(${lv.music.toFixed(3)})`;
  requestAnimationFrame(frame);
}

// =====================================================================
// Boot
// =====================================================================
async function boot() {
  ui.info = await sk.info();
  if (DEMO) ui.info.captureSupported = true;
  cfg = migrate(await sk.loadConfig());
  applyTheme();
  await engine.init();
  buildMixer();
  wireEvents();
  wireShareEvents();
  renderAll();
  await refreshDevices();
  syncAudio();
  syncHotkeys(true);
  requestAnimationFrame(frame);
  preloadBoard(activeBoard()).then(() => cfg.boards.forEach((b) => b !== activeBoard() && preloadBoard(b)));
  for (const entry of S().share) if (entry.enabled) startShare(entry);
  if (!S().setupDone && !DEMO) openWizard();
}

boot().catch((e) => {
  console.error(e);
  document.body.append(h('div', { class: 'toast err', style: { position: 'fixed', left: '20px', bottom: '20px' } }, 'SoundKami failed to start: ' + e.message));
});

// Expose for debugging in DevTools
window.__sk = { cfg: () => cfg, engine, ui, openWizard, openSettings, openEditor, openSharePicker, addImported, activeBoard };
