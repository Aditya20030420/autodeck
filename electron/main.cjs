const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, powerMonitor, session } = require('electron')
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

// only real web addresses are ever handed to the operating system (never file:, ms-: or other program handlers)
const openOutside = (url) => { try { if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url) } catch {} }
// IPC calls are only answered for AutoDeck's own page, never for anything else that might get loaded
const ownPage = (e) => { try { return new URL(e.senderFrame.url).protocol === 'file:' } catch { return false } }

// Reminders are timed inside the page, so Chromium must not slow its timers when the window is minimized, covered or hidden.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

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
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => { if (show) win.show() })

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // The app opens no windows of its own. A web address (http or https only) goes to the system browser; anything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' } })

  // never let the app window navigate away from the bundled page
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      openOutside(url)
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
  if (!app.hasSingleInstanceLock()) return // a second copy is quitting; it must not open a window or tray icon of its own
  // Do not set an AppUserModelId here: the installed shortcuts and the taskbar pin carry Electron's default
  // ("electron.app.AutoDeck"), and a different id makes the running app a second taskbar button.
  loadPrefs()
  applyAutostart()
  // The page may ask for notifications (reminders) and nothing else: no camera, microphone, location, USB and so on.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'notifications')
  app.on('web-contents-created', (_e, contents) => { contents.on('will-attach-webview', (ev) => ev.preventDefault()) })
  ipcMain.handle('update:get', (e) => (ownPage(e) ? update : null))
  ipcMain.handle('bg:get', (e) => (ownPage(e) ? prefs.background : null))
  ipcMain.handle('bg:set', (e, on) => { if (!ownPage(e)) return null; prefs.background = !!on; savePrefs(); applyAutostart(); return prefs.background })
  ipcMain.on('win:show', (e) => { if (ownPage(e)) showWindow() })
  createWindow(!startHidden)
  createTray()
  // A PC that slept pauses the page's timers: when Windows wakes, tell the page to check its reminders at once.
  powerMonitor.on('resume', () => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.executeJavaScript("window.dispatchEvent(new Event('autodeck-wake'))").catch(() => {}))
  })
  // Auto-update from GitHub Releases (installed build only).
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater')
      // A small log (userData/update.log) so a missed or failed update can be diagnosed afterwards.
      const logFile = path.join(app.getPath('userData'), 'update.log')
      try { if (fs.statSync(logFile).size > 200000) fs.unlinkSync(logFile) } catch {}
      const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} v${app.getVersion()} ${m}\n`) } catch {} }
      autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} }
      log(`start, background=${prefs.background}, hidden=${startHidden}`)
      autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }))
      autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }))
      autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }))
      autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', version: update.version, percent: Math.round(p.percent) }))
      // Install as soon as it's downloaded (short delay so the banner shows). Tasks save live, so a restart loses nothing.
      autoUpdater.on('update-downloaded', (i) => {
        setUpdate({ state: 'ready', version: i.version })
        log(`downloaded ${i.version}; installing in 5 s (background=${prefs.background}, window visible=${!!win && win.isVisible()})`)
        // quitting=true lets the window really close even when "Reminders when closed" would normally hide it to the tray.
        setTimeout(() => { quitting = true; autoUpdater.quitAndInstall(true, true) }, 5000)
      })
      autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String(e?.message || e).slice(0, 120) }))
      ipcMain.on('update:install', (e) => { if (!ownPage(e)) return; quitting = true; autoUpdater.quitAndInstall(true, true) })
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
