'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const channels = {
  message: 'desktop:push', storage: 'desktop:storage', file: 'desktop:file',
  command: 'desktop:command', close: 'desktop:close-request', notice: 'desktop:notice'
};

contextBridge.exposeInMainWorld('paperDesktop', Object.freeze({
  message: (message) => ipcRenderer.invoke('desktop:message', message),
  storage: (keys) => ipcRenderer.invoke('desktop:storage-get', keys),
  openOptions: () => ipcRenderer.invoke('desktop:options'),
  openFile: () => ipcRenderer.invoke('desktop:open-file'),
  requestClose: () => ipcRenderer.invoke('desktop:close-window'),
  ready: () => ipcRenderer.invoke('desktop:ready'),
  closeDecision: (token, allow) => ipcRenderer.invoke('desktop:close-decision', { token, allow: allow === true }),
  on: (name, callback) => {
    const channel = channels[name];
    if (!channel || typeof callback !== 'function') return () => {};
    const handler = (_event, value) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
}));
