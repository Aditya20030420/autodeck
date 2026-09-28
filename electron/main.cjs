const { app, BrowserWindow, shell } = require('electron')
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
    webPreferences: { contextIsolation: true },
  })

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // open external links in the system browser, not inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
