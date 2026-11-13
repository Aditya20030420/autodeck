// Reminders for the Android app. The page's own timer only runs while the app is open, so each reminder is also
// handed to Android's alarm manager (through the Local Notifications plugin), which fires it with the app closed.
// Everything here is a no-op outside the Android app.
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

export const isAndroid = () => Capacitor.getPlatform() === 'android'
export const androidNotifyGranted = async () => (await LocalNotifications.checkPermissions()).display === 'granted'
export const androidRequestNotify = async () => (await LocalNotifications.requestPermissions()).display === 'granted'

const DISMISSED = 8640000000000000 // same sentinel as TodoApp: a dismissed one-time reminder
const MAX_REPEATS = 8              // alarms scheduled ahead for a repeating reminder; they are re-planned whenever the app opens
const CHANNEL = { High: 'reminders-high', Medium: 'reminders-medium', Low: 'reminders-low' }

/** A stable 31-bit-safe id per (task, occurrence), as the plugin wants integers. */
function notificationId(taskId, k) {
  let h = 0
  for (let i = 0; i < taskId.length; i++) h = (h * 31 + taskId.charCodeAt(i)) & 0x7fffff
  return h * 16 + k
}

const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
const matches = (recur, dt, anchorDow) =>
  recur === 'daily' || (recur === 'weekdays' && dt.getDay() >= 1 && dt.getDay() <= 5) || (recur === 'weekly' && dt.getDay() === anchorDow)

/** The moments Android should fire this task's reminder, mirroring the page's own rules (TodoApp check()). */
export function alertTimes(task, now) {
  const r = task.reminder
  const [h, m] = r.time.split(':').map(Number)
  const at = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), h, m, 0, 0).getTime() - (r.lead || 0) * 60000
  const every = (r.repeat || 0) * 60000
  const out = []

  // This instance of the task. (A recurring task whose date has passed is stale: the page moves it to its next day
  // when it opens, so the future days below cover it.)
  const [y, mo, d] = r.date.split('-').map(Number)
  const stale = task.recur && r.date < ymd(new Date(now))
  if (!task.done && !stale && r.snoozeUntil !== DISMISSED) {
    const trigger = at(new Date(y, mo - 1, d))
    let first = null
    if (r.snoozeUntil && r.snoozeUntil > now) first = r.snoozeUntil      // snoozed: fires when the snooze ends
    else if (trigger > now) first = trigger                              // not due yet
    else if (every) first = (r.lastAlert || now) + every                 // due: the page alerts now; Android takes over the repeats
    if (first !== null) {
      first = Math.max(first, now + 1000)
      for (let k = 0; k < (every ? MAX_REPEATS : 1); k++) out.push(first + k * every)
    }
  }

  // A recurring task comes back on its matching days, even if the app isn't opened in between.
  if (task.recur) {
    const anchorDow = new Date(`${task.day}T00:00`).getDay()
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    for (let i = 0, added = 0; i < 30 && added < 7; i++, day.setDate(day.getDate() + 1)) {
      if (ymd(day) === r.date || !matches(task.recur, day, anchorDow)) continue
      if (at(day) > now + 1000) { out.push(at(day)); added++ }
    }
  }
  return out.slice(0, 16) // the id scheme has 16 slots per task
}

/** Replace every pending alarm with the current ones. `enabled` false (muted / no permission) just clears them. */
export async function syncAndroidReminders(tasks, enabled) {
  if (!isAndroid()) return
  try {
    const { notifications } = await LocalNotifications.getPending()
    if (notifications.length) await LocalNotifications.cancel({ notifications })
    if (!enabled) return
    const now = Date.now()
    const list = []
    for (const t of tasks) {
      if (t.done || !t.reminder) continue
      alertTimes(t, now).forEach((at, k) => list.push({
        id: notificationId(t.id, k),
        title: `${t.priority === 'High' ? '🔴 ' : ''}Reminder · ${t.priority} priority`,
        body: t.text,
        channelId: CHANNEL[t.priority] || CHANNEL.Medium,
        schedule: { at: new Date(at), allowWhileIdle: true },
        extra: { taskId: t.id },
      }))
    }
    if (list.length) await LocalNotifications.schedule({ notifications: list })
  } catch { /* plugin not ready or permission missing: the in-app alerts still work */ }
}

/** One-time setup: notification channels (their importance decides the sound / pop-up) and the tap handler. */
export function initAndroidReminders(onOpenTask) {
  if (!isAndroid()) return () => {}
  const chan = (id, name, importance) => LocalNotifications.createChannel({ id, name, importance, vibration: true }).catch(() => {})
  chan(CHANNEL.High, 'High priority reminders', 5)
  chan(CHANNEL.Medium, 'Reminders', 4)
  chan(CHANNEL.Low, 'Low priority reminders', 3)
  const sub = LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const id = e.notification?.extra?.taskId
    if (id) onOpenTask(id)
  })
  return () => { sub.then((s) => s.remove()).catch(() => {}) }
}
