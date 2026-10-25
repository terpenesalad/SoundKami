'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, nativeImage,
  shell, protocol, net, session, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const AdmZip = require('adm-zip');

const APP_NAME = 'SoundKami';
const IS_WIN = process.platform === 'win32';
const RENDERER_DIR = path.join(__dirname, 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.webm', '.wma', '.mp4']);

app.setName(APP_NAME);

// Portable mode: a "data" folder next to SoundKami.exe keeps everything on the stick.
(() => {
  const portable = path.join(path.dirname(process.execPath), 'data');
  const custom = process.env.SK_DATA_DIR;
  try {
    if (custom) app.setPath('userData', path.resolve(custom));
    else if (app.isPackaged && fs.statSync(portable).isDirectory()) app.setPath('userData', portable);
  } catch {}
})();
if (IS_WIN) app.setAppUserModelId('com.soundkami.app');

// Keep audio running smoothly when the window is hidden or in the tray.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let config = null;
const captures = new Map(); // key -> child process

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const dataDir = () => app.getPath('userData');
const configPath = () => path.join(dataDir(), 'config.json');
const libraryDir = () => path.join(dataDir(), 'sounds');

function helperPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'sk-capture.exe'),
    path.join(__dirname, '..', 'native', 'sk-capture.exe'),
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Keep a one-step backup in case a future save goes wrong.
    try { fs.writeFileSync(configPath() + '.bak', raw); } catch {}
    return parsed;
  } catch {
    try {
      return JSON.parse(fs.readFileSync(configPath() + '.bak', 'utf8'));
    } catch {
      return null; // renderer fills in defaults
    }
  }
}

let saveChain = Promise.resolve();
function saveConfig(next) {
  config = next;
  const data = JSON.stringify(next, null, 2);
  saveChain = saveChain.then(async () => {
    const tmp = configPath() + '.tmp';
    await fsp.mkdir(dataDir(), { recursive: true });
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, configPath());
  }).catch((err) => console.error('config save failed', err));
  applyWindowSettings();
  return saveChain;
}

const setting = (key, fallback) => (config && config.settings && key in config.settings ? config.settings[key] : fallback);

function applyWindowSettings() {
  if (!win) return;
  win.setAlwaysOnTop(!!setting('alwaysOnTop', false));
  if (IS_WIN) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!setting('launchAtStartup', false), args: ['--hidden'] });
    } catch {}
  }
  updateTray();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function iconPath(name) {
  return path.join(ASSETS_DIR, name);
}

function createWindow() {
  const startHidden = process.argv.includes('--hidden') || !!setting('startMinimized', false);
  const bounds = setting('windowBounds', null);
  const dark = nativeTheme.shouldUseDarkColors;

  win = new BrowserWindow({
    width: bounds?.width || 1120,
    height: bounds?.height || 720,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: APP_NAME,
    icon: iconPath(IS_WIN ? 'icon.ico' : 'icon.png'),
    backgroundColor: dark ? '#16181d' : '#eef0f4',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#16181d' : '#eef0f4', symbolColor: dark ? '#c9ccd4' : '#3a3f4b', height: 39 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.loadURL('app://soundkami/index.html' + (process.env.SK_DEMO ? '?demo' : ''));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  if (process.env.SK_SHOT) require('./dev-shot')(win);

  win.on('close', (e) => {
    if (!quitting && setting('closeToTray', true)) {
      e.preventDefault();
      win.hide();
      if (IS_WIN && tray && config && config.settings && !config.settings.trayHintShown) {
        config.settings.trayHintShown = true;
        saveConfig(config);
        try {
          tray.displayBalloon({
            iconType: 'info',
            title: 'SoundKami is still running',
            content: 'Your hotkeys and shared audio keep working. Right-click the tray icon to quit.',
          });
        } catch {}
      }
    }
  });

  const rememberBounds = debounce(() => {
    if (!win || win.isMinimized() || win.isMaximized()) return;
    if (config && config.settings) {
      config.settings.windowBounds = win.getBounds();
      saveConfig(config);
    }
  }, 800);
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);

  // Links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const micOn = setting('micEnabled', true);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open SoundKami', click: showWindow },
    { type: 'separator' },
    { label: 'Stop all sounds', click: () => send('command', 'stopAll') },
    { label: 'Mic passthrough', type: 'checkbox', checked: !!micOn, click: () => send('command', 'toggleMic') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  let img = nativeImage.createFromPath(iconPath(IS_WIN ? 'tray.ico' : 'tray.png'));
  if (img.isEmpty()) img = nativeImage.createFromPath(iconPath('icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------------------
// Sound library
// ---------------------------------------------------------------------------
function prettyName(file) {
  const base = path.basename(file, path.extname(file));
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
}

async function uniqueLibraryName(original) {
  const ext = path.extname(original).toLowerCase();
  const stem = path.basename(original, path.extname(original))
    .replace(/[^\w\- ]+/g, '').trim().slice(0, 48) || 'sound';
  let name = stem + ext;
  for (let i = 2; ; i++) {
    try { await fsp.access(path.join(libraryDir(), name)); } catch { return name; }
    name = `${stem} (${i})${ext}`;
  }
}

async function collectAudio(p, out, depth = 0) {
  let st;
  try { st = await fsp.stat(p); } catch { return; }
  if (st.isDirectory()) {
    if (depth > 4) return;
    const entries = await fsp.readdir(p);
    entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const e of entries) await collectAudio(path.join(p, e), out, depth + 1);
  } else if (st.isFile() && AUDIO_EXT.has(path.extname(p).toLowerCase())) {
    out.push(p);
  }
}

async function importPaths(paths) {
  await fsp.mkdir(libraryDir(), { recursive: true });
  const files = [];
  for (const p of paths || []) await collectAudio(p, files);
  const result = [];
  for (const src of files.slice(0, 500)) {
    const dest = await uniqueLibraryName(src);
    await fsp.copyFile(src, path.join(libraryDir(), dest));
    result.push({ file: dest, name: prettyName(src) });
  }
  return result;
}

function safeLibraryPath(file) {
  const full = path.resolve(libraryDir(), String(file || ''));
  if (!full.startsWith(path.resolve(libraryDir()) + path.sep)) throw new Error('Invalid sound path');
  return full;
}

// ---------------------------------------------------------------------------
// Board export / import (.skboard = zip of board.json + audio files)
// ---------------------------------------------------------------------------
async function exportBoard(board) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export board',
    defaultPath: `${(board.name || 'board').replace(/[^\w\- ]+/g, '')}.skboard`,
    filters: [{ name: 'SoundKami board', extensions: ['skboard'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const zip = new AdmZip();
  const clean = JSON.parse(JSON.stringify(board));
  for (const s of clean.sounds || []) {
    try {
      zip.addLocalFile(safeLibraryPath(s.file), 'sounds');
    } catch {}
    s.hotkey = ''; // hotkeys are personal; don't carry them over
  }
  zip.addFile('board.json', Buffer.from(JSON.stringify({ format: 'skboard', version: 1, board: clean }, null, 2)));
  zip.writeZip(filePath);
  return { ok: true, path: filePath };
}

async function importBoard() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import board',
    properties: ['openFile'],
    filters: [{ name: 'SoundKami board', extensions: ['skboard', 'zip'] }],
  });
  if (canceled || !filePaths.length) return null;
  const zip = new AdmZip(filePaths[0]);
  const meta = JSON.parse(zip.readAsText('board.json'));
  const board = meta.board;
  await fsp.mkdir(libraryDir(), { recursive: true });
  for (const s of board.sounds || []) {
    const entry = zip.getEntry(`sounds/${s.file}`);
    if (!entry) { s.missing = true; continue; }
    const dest = await uniqueLibraryName(s.file);
    await fsp.writeFile(path.join(libraryDir(), dest), entry.getData());
    s.file = dest;
  }
  return board;
}

// ---------------------------------------------------------------------------
// App-audio sharing (music) via sk-capture.exe
// ---------------------------------------------------------------------------
const OWN_EXE = path.basename(process.execPath).toLowerCase();
const HIDDEN_APPS = /^(discord|discordptb|discordcanary|discorddevelopment)\.exe$/i;

function listAudioApps() {
  return new Promise((resolve) => {
    const exe = helperPath();
    if (!IS_WIN || !exe) return resolve({ supported: false, apps: [] });
    execFile(exe, ['list'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, async (err, stdout) => {
      let apps = [];
      try { apps = JSON.parse(String(stdout || '[]')); } catch {}
      apps = apps.filter((a) => a.exe && a.exe.toLowerCase() !== OWN_EXE && !HIDDEN_APPS.test(a.exe));
      for (const a of apps) {
        if (a.path) {
          try {
            const img = await app.getFileIcon(a.path, { size: 'normal' });
            a.icon = img.toDataURL();
          } catch {}
        }
      }
      resolve({ supported: true, apps, error: err && !stdout ? String(err.message || err) : null });
    });
  });
}

function startCapture(key, pid) {
  stopCapture(key);
  const exe = helperPath();
  if (!IS_WIN || !exe) {
    send('music:error', key, 'Sharing app audio needs Windows 10 (version 2004) or newer.');
    return false;
  }
  const child = spawn(exe, ['capture', String(pid), 'include'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  captures.set(key, child);
  let errBuf = '';
  child.stdout.on('data', (chunk) => send('music:data', key, chunk));
  child.stderr.on('data', (d) => {
    errBuf += d.toString();
    let nl;
    while ((nl = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, nl).trim();
      errBuf = errBuf.slice(nl + 1);
      const fm = /^FORMAT (\d+) (\d+) (\d+)/.exec(line);
      if (fm) send('music:format', key, { rate: +fm[1], channels: +fm[2], bits: +fm[3] });
      else if (line.startsWith('ERROR')) send('music:error', key, describeCaptureError(line));
    }
  });
  child.on('exit', (code) => {
    // Only report exits we didn't cause (the app closed, capture failed).
    if (captures.get(key) === child) {
      captures.delete(key);
      send('music:ended', key, code);
    }
  });
  child.on('error', (e) => send('music:error', key, String(e.message || e)));
  return true;
}

function describeCaptureError(line) {
  if (/unsupported|0x80004001/i.test(line)) return 'This version of Windows can’t capture a single app’s audio. Update to Windows 10 2004 or newer.';
  if (/activate/i.test(line)) return 'Windows wouldn’t let SoundKami listen to that app. Try restarting the app you want to share.';
  return `Couldn’t capture that app (${line.replace(/^ERROR\s*/, '')}).`;
}

function stopCapture(key) {
  const child = captures.get(key);
  if (child) {
    captures.delete(key);
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------
function setHotkeys(list) {
  globalShortcut.unregisterAll();
  const failed = [];
  const seen = new Set();
  for (const { accel, id } of list || []) {
    if (!accel) continue;
    if (seen.has(accel)) { failed.push({ accel, id, reason: 'duplicate' }); continue; }
    seen.add(accel);
    try {
      const ok = globalShortcut.register(accel, () => send('hotkey', id));
      if (!ok) failed.push({ accel, id, reason: 'taken' });
    } catch (e) {
      failed.push({ accel, id, reason: 'invalid' });
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('config:load', () => config);
  ipcMain.handle('config:save', (_e, next) => {
    // A few settings are owned by this process; don't let a renderer save clobber them.
    if (next && next.settings && config && config.settings) {
      for (const k of ['windowBounds', 'trayHintShown']) {
        if (config.settings[k] !== undefined) next.settings[k] = config.settings[k];
      }
    }
    return saveConfig(next);
  });

  ipcMain.handle('library:import', (_e, paths) => importPaths(paths));
  ipcMain.handle('library:read', (_e, file) => fsp.readFile(safeLibraryPath(file)));
  ipcMain.handle('library:remove', async (_e, files) => {
    for (const f of files || []) { try { await fsp.unlink(safeLibraryPath(f)); } catch {} }
  });
  ipcMain.handle('library:openFolder', async () => {
    await fsp.mkdir(libraryDir(), { recursive: true });
    return shell.openPath(libraryDir());
  });
  ipcMain.handle('library:pick', async (_e, mode) => {
    const res = await dialog.showOpenDialog(win, mode === 'folder'
      ? { title: 'Add a folder of sounds', properties: ['openDirectory'] }
      : {
        title: 'Add sounds',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio', extensions: [...AUDIO_EXT].map((e) => e.slice(1)) }, { name: 'All files', extensions: ['*'] }],
      });
    if (res.canceled) return [];
    return importPaths(res.filePaths);
  });

  ipcMain.handle('board:export', (_e, board) => exportBoard(board));
  ipcMain.handle('board:import', () => importBoard());

  ipcMain.handle('hotkeys:set', (_e, list) => setHotkeys(list));
  ipcMain.handle('hotkeys:pause', () => { globalShortcut.unregisterAll(); });

  ipcMain.handle('music:list', () => listAudioApps());
  ipcMain.handle('music:start', (_e, key, pid) => startCapture(key, pid));
  ipcMain.handle('music:stop', (_e, key) => stopCapture(key));

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    captureSupported: IS_WIN && !!helperPath(),
    dataDir: dataDir(),
  }));
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\//i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('app:openSoundSettings', () => {
    if (IS_WIN) return shell.openExternal('ms-settings:sound');
  });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('window:theme', (_e, { dark, bg }) => {
    if (win && IS_WIN) {
      try { win.setTitleBarOverlay({ color: bg || (dark ? '#16181d' : '#eef0f4'), symbolColor: dark ? '#c9ccd4' : '#3a3f4b', height: 39 }); } catch {}
    }
    if (win && bg) win.setBackgroundColor(bg);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  config = loadConfig();

  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.resolve(RENDERER_DIR, rel);
    if (!full.startsWith(RENDERER_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });

  // Microphone access for the passthrough; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'speaker-selection');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'media' || permission === 'speaker-selection');

  registerIpc();
  createWindow();
  createTray();
  applyWindowSettings();
});

app.on('before-quit', () => {
  quitting = true;
  for (const key of [...captures.keys()]) stopCapture(key);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stay alive in the tray */ });
