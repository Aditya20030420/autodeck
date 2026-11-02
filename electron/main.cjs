const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#16304A',
    autoHideMenuBar: true,
    title: 'AutoDeck',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  })

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // open external links in the system browser, not inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })

  // never let the app window navigate away from the bundled page
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (url.startsWith('http')) shell.openExternal(url)
    }
  })
}

// Auto-update status, mirrored to the page so it can show a progress bar.
let update = { state: 'idle' }
const setUpdate = (s) => {
  update = s
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update:status', s))
}

app.whenReady().then(() => {
  ipcMain.handle('update:get', () => update)
  createWindow()
  // Auto-update from GitHub Releases (installed build only).
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }))
      autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }))
      autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }))
      autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', version: update.version, percent: Math.round(p.percent) }))
      autoUpdater.on('update-downloaded', (i) => setUpdate({ state: 'ready', version: i.version }))
      autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String(e?.message || e).slice(0, 120) }))
      ipcMain.on('update:install', () => autoUpdater.quitAndInstall(true, true))
      autoUpdater.checkForUpdates()
    } catch {}
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
