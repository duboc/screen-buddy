'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer runs with contextIsolation on and no node integration; this is
 * the entire surface it gets. Read-only by design — the HUD displays, it does
 * not command anything.
 */
contextBridge.exposeInMainWorld('screenBuddy', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getLatest: () => ipcRenderer.invoke('sensors:latest'),
  onSnapshot: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('sensors:snapshot', listener);
    return () => ipcRenderer.removeListener('sensors:snapshot', listener);
  },
});
