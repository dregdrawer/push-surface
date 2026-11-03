// Exposes the same window.ntpush API the Mac app injects into ui/window.html.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ntpush', {
  onStatus: (f) => ipcRenderer.on('status', (_e, s) => f(s)),
  onLog: (f) => ipcRenderer.on('log', (_e, l) => f(l)),
  setMode: (m) => ipcRenderer.send('mode', m),
  reload: () => ipcRenderer.send('reload'),
  openSettings: () => ipcRenderer.send('settings'),
  resize: (h) => ipcRenderer.send('resize', h),
});
