'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('sk', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  importPaths: (paths) => ipcRenderer.invoke('library:import', paths),
  pickSounds: (mode) => ipcRenderer.invoke('library:pick', mode),
  readSound: (file) => ipcRenderer.invoke('library:read', file),
  removeSounds: (files) => ipcRenderer.invoke('library:remove', files),
  openLibraryFolder: () => ipcRenderer.invoke('library:openFolder'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  exportBoard: (board) => ipcRenderer.invoke('board:export', board),
  importBoard: () => ipcRenderer.invoke('board:import'),

  setHotkeys: (list) => ipcRenderer.invoke('hotkeys:set', list),
  pauseHotkeys: () => ipcRenderer.invoke('hotkeys:pause'),
  onHotkey: on('hotkey'),
  onCommand: on('command'),

  listAudioApps: () => ipcRenderer.invoke('music:list'),
  startMusic: (key, pid) => ipcRenderer.invoke('music:start', key, pid),
  stopMusic: (key) => ipcRenderer.invoke('music:stop', key),
  onMusicData: on('music:data'),
  onMusicFormat: on('music:format'),
  onMusicError: on('music:error'),
  onMusicEnded: on('music:ended'),

  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openSoundSettings: () => ipcRenderer.invoke('app:openSoundSettings'),
  quit: () => ipcRenderer.invoke('app:quit'),
  setTheme: (t) => ipcRenderer.invoke('window:theme', t),
});
