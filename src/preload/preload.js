'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer runs with contextIsolation on and no node integration; this is
 * the entire surface it gets. Read-only by design — the HUD displays, it does
 * not command anything. `onConfigChanged` is a push from the settings editor,
 * not a channel the HUD can write back through.
 */
contextBridge.exposeInMainWorld('screenBuddy', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getLatest: () => ipcRenderer.invoke('sensors:latest'),
  onSnapshot: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('sensors:snapshot', listener);
    return () => ipcRenderer.removeListener('sensors:snapshot', listener);
  },
  onConfigChanged: (handler) => {
    const listener = (_event, config) => handler(config);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },
});
