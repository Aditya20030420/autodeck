const { contextBridge, ipcRenderer } = require('electron')

// Minimal bridge so the page can show auto-update progress (desktop build only).
contextBridge.exposeInMainWorld('autodeck', {
  getUpdate: () => ipcRenderer.invoke('update:get'),
  onUpdate: (cb) => {
    const h = (_e, s) => cb(s)
    ipcRenderer.on('update:status', h)
    return () => ipcRenderer.removeListener('update:status', h)
  },
  installUpdate: () => ipcRenderer.send('update:install'),
})
