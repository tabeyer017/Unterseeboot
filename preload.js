const { contextBridge, ipcRenderer } = require('electron');
const openGameManual = () => ipcRenderer.invoke('open-game-manual');

contextBridge.exposeInMainWorld('campaignStorage', {
  save: (campaign) => ipcRenderer.invoke('campaign:save', campaign),
  load: () => ipcRenderer.invoke('campaign:load'),
});

contextBridge.exposeInMainWorld('fieldManual', {
  open: openGameManual,
  saveCopy: () => ipcRenderer.invoke('save-game-manual-copy'),
});

contextBridge.exposeInMainWorld('electronAPI', {
  openGameManual,
  quitApp: () => ipcRenderer.send('quit-app'),
});
