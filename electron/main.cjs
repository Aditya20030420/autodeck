const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')

// Reminders are checked inside the page, so the window has to stay alive for them to fire.
// With "background" on (the default), closing the window hides it to the tray instead of quitting,
// and AutoDeck starts hidden with Windows, so reminders arrive even when the app looks closed.
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json')
let prefs = { background: true }
const loadPrefs = () => { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) } } catch {} }
const savePrefs = () => { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)) } catch {} }
const applyAutostart = () => {
  if (!app.isPackaged) return // a dev run would register electron.exe itself
  app.setLoginItemSettings({ openAtLogin: prefs.background, args: ['--hidden'] })
}

let win = null
let tray = null
let quitting = false
const startHidden = process.argv.includes('--hidden')

// Only one copy may run, otherwise a second launch would fire every reminder twice.
if (!app.requestSingleInstanceLock()) app.quit()

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow(true)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: '#16304A',
    autoHideMenuBar: true,
    title: 'AutoDeck',
    icon: path.join(__dirname, 'icon.png'),
    // The reminder timer must keep its 20 s beat while the window is hidden in the tray.
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  })
  win.once('ready-to-show', () => { if (show) win.show() })

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

  // Closing hides to the tray (reminders keep running); "Quit" in the tray menu really exits.
  win.on('close', (e) => {
    if (!quitting && prefs.background) { e.preventDefault(); win.hide() }
  })
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setToolTip('AutoDeck: reminders are running')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AutoDeck', click: showWindow },
    { type: 'separator' },
    { label: 'Quit AutoDeck', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', showWindow)
}

// Auto-update status, mirrored to the page so it can show a progress bar.
let update = { state: 'idle' }
const setUpdate = (s) => {
  update = s
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update:status', s))
}

app.on('before-quit', () => { quitting = true })
app.on('second-instance', showWindow)

app.whenReady().then(() => {
  // Do not set an AppUserModelId here: the installed shortcuts and the taskbar pin carry Electron's default
  // ("electron.app.AutoDeck"), and a different id makes the running app a second taskbar button.
  loadPrefs()
  applyAutostart()
  ipcMain.handle('update:get', () => update)
  ipcMain.handle('bg:get', () => prefs.background)
  ipcMain.handle('bg:set', (_e, on) => { prefs.background = !!on; savePrefs(); applyAutostart(); return prefs.background })
  ipcMain.on('win:show', showWindow)
  createWindow(!startHidden)
  createTray()
  // Auto-update from GitHub Releases (installed build only).
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }))
      autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }))
      autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }))
      autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', version: update.version, percent: Math.round(p.percent) }))
      // Install as soon as it's downloaded (short delay so the banner shows). Tasks save live, so a restart loses nothing.
      autoUpdater.on('update-downloaded', (i) => {
        setUpdate({ state: 'ready', version: i.version })
        setTimeout(() => { quitting = true; autoUpdater.quitAndInstall(true, true) }, 5000)
      })
      autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String(e?.message || e).slice(0, 120) }))
      ipcMain.on('update:install', () => { quitting = true; autoUpdater.quitAndInstall(true, true) })
      // The app now lives in the tray and is rarely restarted, so look for updates on its own:
      // at start, every 10 minutes, when the PC wakes from sleep, and when the window is brought up.
      let lastCheck = 0
      const check = () => {
        if (['checking', 'downloading', 'ready'].includes(update.state) || Date.now() - lastCheck < 60 * 1000) return
        lastCheck = Date.now()
        autoUpdater.checkForUpdates().catch(() => {})
      }
      check()
      setInterval(check, 10 * 60 * 1000)
      powerMonitor.on('resume', () => setTimeout(check, 15 * 1000)) // give the network a moment to come back
      app.on('browser-window-focus', check)
    } catch {}
  }
  app.on('activate', showWindow)
})

// The tray keeps the app alive when every window is hidden; nothing to do here.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !prefs.background) app.quit()
})
