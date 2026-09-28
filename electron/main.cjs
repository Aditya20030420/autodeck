const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron')
const path = require('path')

let win = null
let tray = null

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#16304A',
    autoHideMenuBar: true,
    title: 'AutoDeck',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true },
  })

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // open external links in the system browser, not inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })

  // minimize → hide to tray
  win.on('minimize', (e) => { e.preventDefault(); win.hide() })

  // closing the window hides to tray instead of quitting (until a real Quit)
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide() }
  })
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  win.show()
  win.focus()
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'))
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('AutoDeck')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AutoDeck', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
  ]))
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Keep running in the tray even when the window is closed; quit only via the
// tray menu (or ⌘Q on macOS).
app.on('window-all-closed', () => { /* stay alive in tray */ })
