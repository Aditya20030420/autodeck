// One-off: render the built app with sample data and save a screenshot for the README.
// Run: npx electron scripts/capture.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const d = new Date()
const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const tasks = [
  { id: '1', text: 'Ship the AutoDeck redesign', priority: 'High', category: 'Work', done: false, pinned: true, reminder: '17:00', firedReminder: false, day, createdAt: 1, order: 1, subtasks: [{ id: 's1', text: 'Polish the progress ring', done: true }, { id: 's2', text: 'Write release notes', done: false }] },
  { id: '2', text: 'Book dentist appointment', priority: 'Medium', category: 'Personal', done: false, pinned: false, reminder: null, firedReminder: false, day, createdAt: 2, order: 2, subtasks: [] },
  { id: '3', text: 'Reply to design feedback', priority: 'High', category: 'Urgent', done: false, pinned: false, reminder: null, firedReminder: false, day, createdAt: 3, order: 3, subtasks: [] },
  { id: '4', text: 'Morning workout', priority: 'Low', category: 'Personal', done: true, pinned: false, reminder: null, firedReminder: false, day, createdAt: 4, order: 4, subtasks: [] },
  { id: '5', text: 'Review pull request', priority: 'Medium', category: 'Work', done: true, pinned: false, reminder: null, firedReminder: false, day, createdAt: 5, order: 5, subtasks: [] },
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1240, height: 1360, show: false, webPreferences: { offscreen: false } })
  const file = path.join(__dirname, '..', 'dist', 'index.html')
  await win.loadFile(file)
  await win.webContents.executeJavaScript(
    `localStorage.setItem('todo.tasks', JSON.stringify(${JSON.stringify(tasks)})); localStorage.setItem('todo.dark','true'); true;`,
  )
  await win.loadFile(file)
  win.webContents.enableDeviceEmulation({
    screenPosition: 'desktop',
    screenSize: { width: 1240, height: 1400 },
    viewSize: { width: 1240, height: 1400 },
    deviceScaleFactor: 0,
    viewPosition: { x: 0, y: 0 },
    scale: 1,
  })
  await new Promise((r) => setTimeout(r, 2000))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1240, height: 1400 })
  fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'screenshot.png'), img.toPNG())
  console.log('saved docs/screenshot.png')
  app.quit()
})
