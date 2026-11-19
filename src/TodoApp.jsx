import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, memo, Children, isValidElement } from 'react'
import { createPortal } from 'react-dom'
import { isAndroid, androidNotifyGranted, androidRequestNotify, syncAndroidReminders, initAndroidReminders } from './androidReminders.js'
import {
  Plus, Search, Check, Pencil, Trash2, CalendarArrowUp, Copy, Pin, PinOff,
  Bell, Sun, Moon, ListTodo, PartyPopper, Inbox, Coffee, CheckCircle2,
  LayoutGrid, Circle, Flame, Briefcase, User,
  GripVertical, ChevronDown, Download, Upload, X,
  FileText, ClipboardList, Share2, Clipboard, CheckCircle, Settings, Volume2, RotateCw, CalendarDays,
  Archive as ArchiveIcon, ArchiveRestore, SignalLow, SignalMedium, SignalHigh, Tag, TriangleAlert, House,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import AutoDeckIcon from './AutoDeckIcon.tsx'
// jspdf is lazy-loaded inside exportPDF so its weight isn't in the initial bundle.
// (Excel export uses dependency-free CSV — see exportCSV.)

/** Time-of-day greeting + matching icon (finer bands than a plain 3-way split). */
function greeting() {
  const h = new Date().getHours()
  if (h < 5) return { text: 'Still up?', Icon: Moon }
  if (h < 12) return { text: 'Good morning', Icon: Coffee }
  if (h < 17) return { text: 'Good afternoon', Icon: Sun }
  if (h < 21) return { text: 'Good evening', Icon: Moon }
  return { text: 'Winding down', Icon: Moon }
}

/* ============================================================================
   DATA MODEL & PERSISTENCE
   Tasks are one array in localStorage under "todo.tasks".
   task: {
     id, text, priority: 'Low'|'Medium'|'High', category: 'Work'|'Personal'|'Urgent',
     done, pinned, reminder: {date,time,lead,repeat,lastAlert}|null, day: 'YYYY-MM-DD', createdAt
   }
   On load we keep today's tasks, roll unfinished older ones forward to today,
   and drop finished old ones (daily reset).
   ============================================================================ */

// Local calendar date (YYYY-MM-DD). Not toISOString() — that's UTC and would
// flip "today" at the wrong midnight for anyone not on UTC.
const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayStr = () => dateStr(new Date())

// localStorage throws in data:/private windows — wrap so the app degrades gracefully.
const safe = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
}

/** Persisted state hook: like useState but mirrored to localStorage under `key`. */
function useLocalStorage(key, initial, revive = (v) => v) {
  const [value, setValue] = useState(() => {
    const raw = safe.get(key)
    if (raw == null) return typeof initial === 'function' ? initial() : initial
    // `revive` upgrades older saved shapes before the first render, so an old save can't crash the page
    try { return revive(JSON.parse(raw)) } catch { return initial }
  })
  useEffect(() => { safe.set(key, JSON.stringify(value)) }, [key, value])
  // Another tab or window of the same page saved something: take it, so the two never overwrite each other's changes.
  // (The browser only raises this event for a change that really differs, so the write above can't ping-pong.)
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== key || e.newValue == null) return
      try { setValue(revive(JSON.parse(e.newValue))) } catch { /* unreadable: keep what we have */ }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue]
}

/* A backup file is someone else's data until proven otherwise: keep only the fields the app knows, in the shapes it expects,
   with sensible limits, so a damaged or hostile file can't crash the app or fill its storage. */
const clip = (v, n) => (typeof v === 'string' ? v : '').slice(0, n)
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
const isDay = (v) =>typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const fin = (v, d) => (Number.isFinite(v) ? v : d)
const RECURS = ['daily', 'weekdays', 'weekly']
function cleanReminder(r) {
  return r && typeof r === 'object'
    ? { date: isDay(r.date) ? r.date : todayStr(), time: isTime(r.time) ? r.time : '09:00',
        lead: Math.max(0, fin(r.lead, 0)), repeat: Math.max(0, fin(r.repeat, 0)), lastAlert: fin(r.lastAlert, null), snoozeUntil: fin(r.snoozeUntil, null) }
    : null
}
/** A subtask as read from storage: text and done as always, plus an optional own priority, category, repeat, reminder and day. */
function cleanSubtask(s) {
  const out = { id: clip(String(s.id ?? ''), 64) || crypto.randomUUID(), text: clip(s.text, 500), done: !!s.done }
  if (PRIORITIES.includes(s.priority)) out.priority = s.priority
  if (typeof s.category === 'string' && s.category) out.category = clip(s.category, 60)
  if (RECURS.includes(s.recur)) out.recur = s.recur
  const rem = cleanReminder(s.reminder)
  if (rem) out.reminder = rem
  if (isDay(s.day)) out.day = s.day
  return out
}
function sanitizeImported(list) {
  return list.slice(0, 5000).filter((x) => x && typeof x === 'object' && typeof x.text === 'string').map((x, i) => {
    const r = x.reminder
    const reminder = r && typeof r === 'object'
      ? { date: isDay(r.date) ? r.date : todayStr(), time: isTime(r.time) ? r.time : '09:00',
          lead: fin(r.lead, 0), repeat: fin(r.repeat, 0), lastAlert: fin(r.lastAlert, null), snoozeUntil: fin(r.snoozeUntil, null) }
      : (isTime(r) ? r : null)
    return {
      id: clip(String(x.id ?? ''), 64) || crypto.randomUUID(),
      text: clip(x.text, 2000), priority: PRIORITIES.includes(x.priority) ? x.priority : 'Medium',
      category: clip(x.category, 60) || 'Personal', reminder, recur: ['daily', 'weekdays', 'weekly'].includes(x.recur) ? x.recur : null,
      done: !!x.done, pinned: !!x.pinned, day: isDay(x.day) ? x.day : todayStr(),
      createdAt: fin(x.createdAt, Date.now()), order: fin(x.order, i),
      subtasks: Array.isArray(x.subtasks)
        ? x.subtasks.slice(0, 200).filter((s) => s && typeof s === 'object').map(cleanSubtask)
        : [],
    }
  })
}

/* ARCHIVE: every task that leaves the list is kept here instead of vanishing: deleted ones, finished ones the daily
   reset clears away, and the ones an import replaces. Stored under "todo.archive" as the task plus { archivedAt, reason }. */
const ARCHIVE_MAX = 3000  // oldest go first beyond this, so storage can't grow without limit
const ARCHIVE_REASONS = { deleted: 'Deleted', completed: 'Completed', replaced: 'Replaced by import' }
const reviveArchive = (v) => (Array.isArray(v)
  ? v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.text === 'string')
      .map((x) => ({ ...x, archivedAt: Number.isFinite(x.archivedAt) ? x.archivedAt : Date.now(), reason: ARCHIVE_REASONS[x.reason] ? x.reason : 'deleted' }))
  : [])
/** An archived entry back as an ordinary task for today: not done, alarms re-armed, a reminder that already passed dropped. */
function revivedTask(a, order) {
  const { archivedAt, reason, ...task } = a  // eslint-disable-line no-unused-vars
  let reminder = task.reminder
  if (reminder && task.recur) reminder = { ...reminder, date: todayStr(), lastAlert: null, snoozeUntil: null }
  else if (reminder && reminderEventTime(reminder).getTime() <= Date.now()) reminder = null
  else if (reminder) reminder = { ...reminder, lastAlert: null, snoozeUntil: null }
  const subtasks = (task.subtasks || []).map((st) => {
    if (!st.reminder) return st
    if (st.recur) return { ...st, reminder: { ...st.reminder, date: todayStr(), lastAlert: null, snoozeUntil: null } }
    if (reminderEventTime(st.reminder).getTime() <= Date.now()) { const { reminder: gone, ...rest } = st; return rest } // eslint-disable-line no-unused-vars
    return { ...st, reminder: { ...st.reminder, lastAlert: null, snoozeUntil: null } }
  })
  return { ...task, subtasks, day: todayStr(), done: false, pinned: false, order, reminder }
}

/* Every reminder in the app as one flat list: a task's own, plus those of its subtasks. A subtask reminder is presented as
   a task-like item (its own id, "step (in task)" as the text, its own or the task's priority), so alerts, snoozes, the banner
   and the Android alarms handle both the same way. */
function subItem(task, st) {
  return { id: st.id, text: `${st.text} (in ${task.text})`, priority: st.priority || task.priority, category: st.category || task.category,
    done: !!(st.done || task.done), reminder: st.reminder, recur: st.recur || null, day: st.day || task.day, pinned: false, subtasks: [], subOf: task.id }
}
function reminderItems(tasks) {
  const out = []
  for (const x of tasks) {
    if (x.reminder) out.push(x)
    for (const st of x.subtasks || []) if (st.reminder) out.push(subItem(x, st))
  }
  return out
}
/** Apply `fn` to the tasks or subtasks whose ids are in `ids`. For a subtask, fn sees (and may change) its item's reminder/done. */
function patchItems(tasks, ids, fn) {
  return tasks.map((x) => {
    let y = ids.has(x.id) ? fn(x) : x
    if ((x.subtasks || []).some((st) => ids.has(st.id))) {
      y = { ...y, subtasks: y.subtasks.map((st) => {
        if (!ids.has(st.id)) return st
        const item = subItem(x, st)
        const r = fn(item)
        return { ...st, done: r.done !== item.done ? r.done : st.done, reminder: r.reminder === undefined ? st.reminder : r.reminder }
      }) }
    }
    return y
  })
}
/** "[x] Send notes (High, Work, daily, 17:00)": a step with the options it has of its own, for the exports. */
const subLine = (st) => {
  const own = [st.priority, st.category, st.recur, st.reminder && st.reminder.time].filter(Boolean).join(', ')
  return `${st.done ? '[x]' : '[ ]'} ${st.text}${own ? ` (${own})` : ''}`
}
/** A new step with the options it was given (priority, category, repeat, reminder); anything left empty follows the task. */
function newSubtask(d) {
  return applySubFields({ id: crypto.randomUUID(), text: d.text, done: false, day: todayStr() }, d)
}
function applySubFields(st, f) {
  const out = { ...st }
  if ('priority' in f) { if (PRIORITIES.includes(f.priority)) out.priority = f.priority; else delete out.priority }
  if ('category' in f) { if (f.category) out.category = f.category; else delete out.category }
  if ('recur' in f) { if (RECURS.includes(f.recur)) out.recur = f.recur; else delete out.recur }
  if ('reminder' in f) { if (f.reminder) out.reminder = { ...f.reminder, lastAlert: null, snoozeUntil: null }; else delete out.reminder }
  return out
}
/** A repeating subtask starts over on its next matching day, like a repeating task. */
function normSub(st, task, t) {
  if (!st.recur) return st
  const d = st.day || task.day || t
  if (d >= t) return st
  const next = nextOccurrence(st.recur, new Date(), new Date(`${d}T00:00`).getDay())
  return { ...st, done: false, day: next, reminder: st.reminder ? { ...st.reminder, date: next, lastAlert: null, snoozeUntil: null } : st.reminder }
}

/* Tasks as read from storage: known fields only, and old-style reminders upgraded, so the first screen can't crash on them. */
const reviveTasks = (v) => sanitizeImported(Array.isArray(v) ? v : []).map((x) => ({ ...x, reminder: migrateReminder(x.reminder) }))

function normalizeForToday(tasks) {
  const t = todayStr()
  return tasks
    // Keep today's tasks, any unfinished task, and every recurring task.
    .filter((x) => x.day === t || !x.done || x.recur)
    .map((x, i) => {
      const base = {
        subtasks: [],                       // default for tasks saved before subtasks existed
        order: x.order ?? x.createdAt ?? i, // default manual-sort order
        ...x,
        // Migrate legacy 'HH:MM' string reminders → object; keep future-dated ones as-is.
        reminder: migrateReminder(x.reminder),
      }
      base.subtasks = (base.subtasks || []).map((st) => normSub(st, x, t))
      if (x.day === t) return base
      // A recurring task re-spawns fresh (undone) on its next matching day.
      if (x.recur) {
        if (x.day > t) return base  // already scheduled ahead — leave it
        const anchorDow = new Date(`${x.day}T00:00`).getDay()
        const next = nextOccurrence(x.recur, new Date(), anchorDow)
        return {
          ...base, day: next, done: false,
          reminder: base.reminder ? { ...base.reminder, date: next, lastAlert: null, snoozeUntil: null } : null,
        }
      }
      // Past unfinished task rolls forward to today; future-dated (postponed) stays put.
      return x.day < t ? { ...base, day: t } : base
    })
}

/**
 * Parse natural-language shortcuts out of the task text:
 *   time     "at 5pm", "5:30pm", "@17:00"      → reminder "HH:MM"
 *   category "#work" / "#personal" / "#urgent" → category
 *   priority "!high" / "!med" / "!low"         → priority
 * Returns the cleaned text plus any detected fields (undefined if not present).
 */
function parseQuickAdd(raw, categories = DEFAULT_CATEGORIES) {
  let text = ` ${raw} `
  let category, priority, reminder

  const catMap = Object.fromEntries(categories.map((c) => [c.name.toLowerCase(), c.name]))
  // a tag only counts at the start of a word, so "wow!high" and a link ending "/#work" are left alone
  text = text.replace(/(\s)#(\w+)/g, (m, sp, tag) => {
    const c = catMap[tag.toLowerCase()]
    if (c) { category = c; return ' ' }
    return m
  })

  text = text.replace(/(\s)!(high|medium|med|low)\b/i, (m, sp, p) => {
    priority = { high: 'High', medium: 'Medium', med: 'Medium', low: 'Low' }[p.toLowerCase()]
    return ' '
  })

  // 12-hour: "at 5pm", "5:30 pm", "@7am"
  const t12 = text.match(/(?:\bat\s+|@)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  // 24-hour needs an "at"/"@" so a plain "20" isn't mistaken for a time
  const t24 = text.match(/(?:\bat\s+|@)(\d{1,2}):(\d{2})\b/)
  if (t12) {
    let h = parseInt(t12[1], 10)
    const min = t12[2] ? parseInt(t12[2], 10) : 0
    const pm = t12[3].toLowerCase() === 'pm'
    if (pm && h < 12) h += 12
    if (!pm && h === 12) h = 0
    if (h < 24 && min < 60) { reminder = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`; text = text.replace(t12[0], ' ') }
  } else if (t24) {
    const h = +t24[1], min = +t24[2]
    if (h < 24 && min < 60) { reminder = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`; text = text.replace(t24[0], ' ') }
  }

  // "…at 5pm tomorrow": the reminder is for tomorrow, and the word itself is left out of the title
  let tomorrow = false
  if (reminder && /\btomorrow\b/i.test(text)) { tomorrow = true; text = text.replace(/\btomorrow\b/i, ' ') }

  return { text: text.replace(/\s{2,}/g, ' ').trim(), category, priority, reminder, tomorrow }
}

/** "17:30" → "5:30 PM" for display. */
function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`
}

/* ----------------------------------------------------------------------------
   REMINDERS
   task.reminder = null | { date:'YYYY-MM-DD', time:'HH:MM', lead:minutes,
                            repeat:minutes, lastAlert:epoch|null }
   - lead:   fire this many minutes BEFORE the event time (0 = at the time).
   - repeat: re-alert (loud sound + desktop notification) every N minutes until
             the task is marked done (0 = alert once). The on-page banner stays
             visible until done regardless of repeat.
   Old tasks stored reminder as a plain 'HH:MM' string — migrateReminder upgrades
   those to today's date. ------------------------------------------------------ */
function migrateReminder(r) {
  if (!r) return null
  if (typeof r === 'string') return isTime(r) ? { date: todayStr(), time: r, lead: 0, repeat: 0, lastAlert: null, snoozeUntil: null } : null
  if (!isTime(r.time)) return null  // a reminder without a usable time can't fire (and used to crash the page)
  // snoozeUntil must survive a restart, or every snoozed or dismissed reminder pops back up on the next launch
  return { date: r.date || todayStr(), time: r.time, lead: r.lead || 0, repeat: r.repeat || 0, lastAlert: r.lastAlert ?? null, snoozeUntil: r.snoozeUntil ?? null }
}
/** The moment a reminder first fires (event time minus lead). */
function reminderTrigger(r) {
  const [y, mo, d] = r.date.split('-').map(Number)
  const [h, m] = r.time.split(':').map(Number)
  const dt = new Date(y, mo - 1, d, h, m, 0, 0)
  dt.setMinutes(dt.getMinutes() - (r.lead || 0))
  return dt
}
/** The event moment itself (for sorting/display). */
function reminderEventTime(r) {
  const [y, mo, d] = r.date.split('-').map(Number)
  const [h, m] = r.time.split(':').map(Number)
  return new Date(y, mo - 1, d, h, m, 0, 0)
}
/** Short label: "5:00 PM", with date when not today, plus lead/repeat markers. */
function reminderLabel(r) {
  if (!r) return ''
  const datePart = r.date === todayStr() ? '' : `${r.date.slice(5)} `  // "MM-DD "
  const lead = r.lead ? ` −${r.lead}m` : ''
  const rep = r.repeat ? ` ↻${r.repeat}m` : ''
  return `${datePart}${fmtTime(r.time)}${lead}${rep}`
}
/** True while a reminder is snoozed/dismissed (suppressed from banner + alarms). */
const isSuppressed = (r, now) => !!r.snoozeUntil && r.snoozeUntil > now
/** When this reminder should next surface (snooze end, else its trigger). */
const nextReminderAt = (r, now) => (r.snoozeUntil && r.snoozeUntil > now && r.snoozeUntil !== DISMISSED)
  ? r.snoozeUntil : reminderTrigger(r).getTime()
/** Minutes a task is past its due (event) time; 0 if not overdue. */
const overdueMins = (r, now) => Math.max(0, Math.floor((now - reminderEventTime(r).getTime()) / 60000))
/** Compact duration: 45m · 3h · 2d (keeps badges short). */
const fmtDur = (m) => (m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`)
/** Human frequency for the upcoming-reminders table. */
const freqLabel = (r) => r.repeat ? `Every ${r.repeat} min` : r.lead ? `${r.lead} min before` : 'Once'
/** The next future moment any reminder needs attention (its time, a snooze ending, a repeat), or null. Anything already due is
    handled by the alert check itself, so only moments after `now` count here. */
function nextAlertAt(tasks, now) {
  let best = Infinity
  for (const x of tasks) {
    const r = x.reminder
    if (x.done || !r || r.snoozeUntil === DISMISSED) continue
    let at
    if (r.snoozeUntil && r.snoozeUntil > now) at = r.snoozeUntil
    else {
      const trig = reminderTrigger(r).getTime()
      if (trig > now) at = trig
      else if (r.repeat > 0 && r.lastAlert) at = r.lastAlert + r.repeat * 60000
    }
    if (at !== undefined && at > now && at < best) best = at
  }
  return best === Infinity ? null : best
}
/** Pick the alert sound for a priority level. */
const prioritySfx = (priority) => (priority === 'High' ? 'alarm' : priority === 'Medium' ? 'reminder' : 'soft')

/* Recurrence: a task can re-spawn (fresh, undone) on each matching day. */
const RECUR_OPTIONS = [['Does not repeat', ''], ['Every day', 'daily'], ['Weekdays', 'weekdays'], ['Every week', 'weekly']]
const RECUR_LABEL = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' }
/** Next date (YYYY-MM-DD) on/after `from` that matches the recurrence rule. */
function nextOccurrence(recur, from, anchorDow) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let i = 0; i < 14; i++) {
    const dow = d.getDay()
    if (recur === 'daily') return dateStr(d)
    if (recur === 'weekdays' && dow >= 1 && dow <= 5) return dateStr(d)
    if (recur === 'weekly' && dow === anchorDow) return dateStr(d)
    d.setDate(d.getDate() + 1)
  }
  return dateStr(from)
}

// --- static config ---
const PRIORITIES = ['Low', 'Medium', 'High']
const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2 }
// Categories are user-editable (name + colour), stored under "todo.categories".
const DEFAULT_CATEGORIES = [
  { name: 'Work', color: '#0ea5e9' },
  { name: 'Personal', color: '#8b5cf6' },
  { name: 'Urgent', color: '#f43f5e' },
]
/** Colour for a category name (falls back to slate for deleted ones). */
const catColor = (cats, name) => cats.find((c) => c.name === name)?.color || '#94a3b8'
/** Inline style for a category badge — a translucent tint of its own colour. */
const catBadgeStyle = (cats, name) => { const c = catColor(cats, name); return { backgroundColor: `${c}26`, color: c } }
// Reminder dropdown presets: [label, minutes]. 'custom' lets the user type any value.
const LEAD_OPTIONS = [['At the time', 0], ['5 min before', 5], ['10 min before', 10], ['15 min before', 15], ['30 min before', 30], ['1 hour before', 60], ['2 hours before', 120]]
const REPEAT_OPTIONS = [['Once', 0], ['Every 5 min', 5], ['Every 10 min', 10], ['Every 15 min', 15], ['Every 30 min', 30], ['Every hour', 60], ['Every 2 hours', 120]]
const SNOOZE_OPTIONS = [['5 min', 5], ['10 min', 10], ['15 min', 15], ['30 min', 30], ['1 hour', 60]]
const DISMISSED = 8640000000000000  // sentinel snoozeUntil for a dismissed one-time reminder (effectively "off")

const PRIORITY_BADGE = {
  Low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  Medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  High: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
}
// Symbols instead of plain dots: signal bars for priority, a fitting icon for each category (a tag for ones you add yourself)
const PRIORITY_ICON = { Low: SignalLow, Medium: SignalMedium, High: SignalHigh }
const PRIORITY_TEXT = { Low: 'text-slate-400', Medium: 'text-amber-500', High: 'text-rose-500' }
function PriorityIcon({ p, size = 16 }) {
  const I = PRIORITY_ICON[p] || SignalMedium
  return <I size={size} strokeWidth={2.4} className={PRIORITY_TEXT[p] || PRIORITY_TEXT.Medium} aria-hidden="true" />
}
const PRIORITY_TINT = { Low: 'bg-slate-500/15', Medium: 'bg-amber-500/15', High: 'bg-rose-500/15' }
/** The priority symbol in a small rounded tile (cards, banner, week view, archive). */
function PriorityChip({ p, size = 15 }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${PRIORITY_TINT[p] || PRIORITY_TINT.Medium}`}
      style={{ width: size + 9, height: size + 9 }} title={`${p} priority`}>
      <PriorityIcon p={p} size={size} />
    </span>
  )
}
function categoryIconFor(name) {
  const n = String(name).toLowerCase()
  if (/work|office|job|business|project|client/.test(n)) return Briefcase
  if (/personal|private|\bself\b|family|\bme\b/.test(n)) return User
  if (/urgent|important|asap|critical/.test(n)) return TriangleAlert
  if (/home|house|chore/.test(n)) return House
  return Tag
}
function CategoryIcon({ name, color, size = 16 }) {
  const I = categoryIconFor(name)
  return <I size={size} strokeWidth={2.3} style={{ color }} aria-hidden="true" />
}
// Status filters are fixed; category filters are appended dynamically from the
// user's categories at render time.
const STATUS_FILTERS = ['All', 'Active', 'Completed', 'High Priority']

const FILTER_ICON = {
  All: LayoutGrid, Active: Circle, Completed: CheckCircle2, 'High Priority': Flame,
}

// Per-filter colours: [active pill, inactive tinted pill].
const FILTER_STYLE = {
  All: ['bg-sky-600 text-white shadow-lg shadow-sky-600/30 ring-1 ring-inset ring-white/20',
        'bg-slate-500/10 text-slate-600 ring-1 ring-inset ring-slate-500/15 hover:bg-slate-500/15 dark:text-slate-300'],
  Active: ['bg-blue-600 text-white shadow-lg shadow-blue-600/30 ring-1 ring-inset ring-white/20',
        'bg-blue-500/10 text-blue-700 ring-1 ring-inset ring-blue-500/15 hover:bg-blue-500/15 dark:text-blue-300'],
  Completed: ['bg-lime-500 text-white shadow-lg shadow-lime-500/30 ring-1 ring-inset ring-white/20',
        'bg-lime-500/15 text-lime-700 ring-1 ring-inset ring-lime-500/20 hover:bg-lime-500/25 dark:text-lime-300'],
  'High Priority': ['bg-rose-600 text-white shadow-lg shadow-rose-600/30 ring-1 ring-inset ring-white/20',
        'bg-rose-500/10 text-rose-700 ring-1 ring-inset ring-rose-500/15 hover:bg-rose-500/15 dark:text-rose-300'],
}

/* Shared AudioContext. Browsers keep it suspended until a user gesture, so we
   create it once and resume it (a) on the first interaction and (b) before each
   chime — otherwise a timer-fired reminder would play silently. */
let audioCtx = null
function getAudioCtx() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!audioCtx) audioCtx = new AC()
  return audioCtx
}
/** Unlock/resume audio on a user gesture (call once from a click/keydown). */
function unlockAudio() {
  const ctx = getAudioCtx()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}

/* Sound library — each event gets its own tone/pattern.
   Each preset is a list of notes: [frequency, startOffset(s), duration(s), waveform]. */
const SFX = {
  add:       [[523, 0, 0.10, 'sine']],                                              // soft blip
  complete:  [[659, 0, 0.09, 'sine'], [988, 0.08, 0.16, 'sine']],                   // bright rising ding
  delete:    [[320, 0, 0.12, 'triangle'], [180, 0.09, 0.20, 'triangle']],           // low descending thunk
  reminder:  [[880, 0, 0.13, 'sine'], [1174, 0.13, 0.13, 'sine'], [1568, 0.26, 0.22, 'sine']], // 3-note alert
  // Loud, urgent alarm for due reminders — square waves + higher gain (5th note field).
  alarm:     [[988, 0, 0.18, 'square', 0.5], [988, 0.24, 0.18, 'square', 0.5], [1319, 0.52, 0.32, 'square', 0.55],
              [988, 0.95, 0.18, 'square', 0.5], [988, 1.19, 0.18, 'square', 0.5], [1319, 1.47, 0.38, 'square', 0.55]],
  celebrate: [[523, 0, 0.12, 'sine'], [659, 0.11, 0.12, 'sine'], [784, 0.22, 0.12, 'sine'], [1046, 0.33, 0.26, 'sine']], // arpeggio
  toggleOff: [[420, 0, 0.09, 'sine']],                                              // soft un-check
  soft:      [[660, 0, 0.14, 'sine', 0.18], [880, 0.14, 0.18, 'sine', 0.18]],       // gentle low-priority nudge
}

let soundEnabled = true  // toggled by the UI sound switch
let sfxVolume = 0.8      // 0–1 master volume (Settings)
let hpAlarmOn = true     // use the loud alarm for high-priority reminders (Settings)

/** Play a named sound effect via the Web Audio API (no audio files). */
function playSfx(name) {
  if (!soundEnabled || sfxVolume <= 0) return
  try {
    const ctx = getAudioCtx()
    if (!ctx) return
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const now = ctx.currentTime
    ;(SFX[name] || []).forEach(([freq, offset, dur, type, peak]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = type || 'sine'
      osc.frequency.value = freq
      const start = now + offset
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, (peak ?? 0.25) * sfxVolume), start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + dur + 0.02)
    })
  } catch { /* audio unavailable — ignore */ }
}

// ============================================================================

export default function TodoApp() {
  const [tasks, setTasks] = useLocalStorage('todo.tasks', [], reviveTasks)
  const [archive, setArchive] = useLocalStorage('todo.archive', [], reviveArchive)
  const [archiveKeep, setArchiveKeep] = useLocalStorage('todo.archiveKeep', 0)  // days to keep archived tasks; 0 = for ever
  const [dark, setDark] = useLocalStorage('todo.dark', () =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [filter, setFilter] = useState('All')
  const [query, setQuery] = useState('')
  const [view, setView] = useState('tasks')  // 'tasks' | 'report'
  const [nowTick, setNowTick] = useState(() => Date.now())  // drives the live due-reminder banner
  const [highlightId, setHighlightId] = useState(null)      // task briefly ring-highlighted after "View task"
  const [notify, setNotify] = useState(
    typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false)
  const [muted, setMuted] = useLocalStorage('todo.muted', false)  // app-level mute (browser can't revoke permission)
  const [soundOn, setSoundOn] = useLocalStorage('todo.sound', true)  // UI sound effects on/off
  const [volume, setVolume] = useLocalStorage('todo.volume', 0.8)    // master sound volume 0–1
  const [hpAlarm, setHpAlarm] = useLocalStorage('todo.hpAlarm', true) // loud alarm for high-priority reminders
  const [remDefaults, setRemDefaults] = useLocalStorage('todo.remDefaults', { lead: 0, repeat: 0 })
  const [categories, setCategories] = useLocalStorage('todo.categories', DEFAULT_CATEGORIES)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [celebrate, setCelebrate] = useState(false)
  const [undo, setUndo] = useState(null)  // last deleted task, for the undo toast
  const [notice, setNotice] = useState(null)  // transient status message toast
  const prevAllDone = useRef(false)
  const fileRef = useRef(null)  // hidden import file input
  const swRegRef = useRef(null) // service-worker registration (for actionable notifications)
  const [exportOpen, setExportOpen] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Auto-dismiss the undo toast after 5s.
  useEffect(() => {
    if (!undo) return
    const id = setTimeout(() => setUndo(null), 5000)
    return () => clearTimeout(id)
  }, [undo])

  // Auto-dismiss transient notices after 4s; sticky ones (reminders) stay until dismissed.
  useEffect(() => {
    if (!notice || notice.sticky) return
    const id = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(id)
  }, [notice])

  // Unlock the audio context on the first user interaction so the chime can
  // sound later when a reminder fires on a timer (no gesture at that moment).
  useEffect(() => {
    const onGesture = () => unlockAudio()
    window.addEventListener('pointerdown', onGesture, { once: true })
    window.addEventListener('keydown', onGesture, { once: true })
    return () => {
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
    }
  }, [])

  // Keep the notify indicator in sync with the real browser permission,
  // even when the user changes it outside the app (address bar, site settings).
  useEffect(() => {
    if (isAndroid()) { // the Android app asks the OS (through the plugin), not the browser
      const syncA = () => androidNotifyGranted().then(setNotify).catch(() => {})
      syncA()
      window.addEventListener('focus', syncA)
      document.addEventListener('visibilitychange', syncA)
      return () => { window.removeEventListener('focus', syncA); document.removeEventListener('visibilitychange', syncA) }
    }
    if (typeof Notification === 'undefined') return
    const sync = () => setNotify(Notification.permission === 'granted')
    sync()
    window.addEventListener('focus', sync)
    let status
    navigator.permissions?.query({ name: 'notifications' })
      .then((s) => { status = s; s.addEventListener('change', sync) })
      .catch(() => {})
    return () => {
      window.removeEventListener('focus', sync)
      status?.removeEventListener('change', sync)
    }
  }, [])

  // Normalise for the new day: on load, and again when midnight passes with the app left open
  // (nowTick re-renders every 20 s, so `today` changes by itself).
  const today = todayStr()
  // Finished tasks from earlier days that the reset clears away are archived, not lost.
  const archiveAdd = useCallback((list, reason) => {
    if (!list.length) return
    setArchive((prev) => {
      const have = new Set(prev.map((x) => x.id))  // also makes a repeated call (React strict mode) harmless
      const add = list.filter((x) => !have.has(x.id)).map((x) => ({ ...x, archivedAt: Date.now(), reason }))
      return add.length ? [...add, ...prev].slice(0, ARCHIVE_MAX) : prev
    })
  }, [setArchive])
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const items = useMemo(() => reminderItems(tasks), [tasks])  // every reminder: the tasks' own and their subtasks'
  useEffect(() => {
    const prev = tasksRef.current
    const next = normalizeForToday(prev)
    const kept = new Set(next.map((x) => x.id))
    archiveAdd(prev.filter((x) => !kept.has(x.id)), 'completed')
    setTasks(next)
  }, [setTasks, archiveAdd, today])
  // Optional automatic clean-up of old archive entries (Archive tab → "Keep for").
  useEffect(() => {
    if (!archiveKeep) return
    const cut = Date.now() - archiveKeep * 864e5
    setArchive((prev) => (prev.some((x) => x.archivedAt < cut) ? prev.filter((x) => x.archivedAt >= cut) : prev))
  }, [archiveKeep, today, setArchive])

  // Apply theme class to <html>.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  // Mirror sound preferences to the module flags playSfx reads.
  useEffect(() => { soundEnabled = soundOn }, [soundOn])
  useEffect(() => { sfxVolume = volume }, [volume])
  useEffect(() => { hpAlarmOn = hpAlarm }, [hpAlarm])

  // --- reminders: check every 20s. A reminder is "due" once now passes its
  //     trigger (event time − lead) and stays due until the task is marked done.
  //     On becoming due we sound a loud alarm + desktop notification, then re-nag
  //     every `repeat` minutes (0 = once). The always-visible banner (below) keeps
  //     showing due reminders regardless. Muting silences the sound + notifications.
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const liveNotes = useRef(new Map())  // desktop alerts on screen, by task id
  // A reminder that is still showing (a high-priority one stays until dismissed) goes away as soon as its task is completed,
  // deleted, snoozed or has its reminder removed.
  useEffect(() => {
    const stale = (id) => {
      const t = items.find((x) => x.id === id)
      return !t || t.done || !t.reminder || isSuppressed(t.reminder, Date.now())
    }
    for (const [id, n] of liveNotes.current) if (stale(id)) { try { n.close() } catch { /* already gone */ } liveNotes.current.delete(id) }
    swRegRef.current?.getNotifications?.().then((list) => list.forEach((n) => { if (n.tag && stale(n.tag)) n.close() })).catch(() => {})
  }, [items])
  useEffect(() => {
    const check = () => {
      setNowTick(Date.now())  // keep the due-banner fresh even when muted
      if (mutedRef.current) return
      const now = Date.now()
      const due = reminderItems(tasksRef.current).filter((x) =>
        !x.done && x.reminder && reminderTrigger(x.reminder).getTime() <= now && !isSuppressed(x.reminder, now))
      // Which due reminders need a (re)alert now, per their repeat cadence.
      const toAlert = due.filter((x) => {
        const la = x.reminder.lastAlert
        if (!la) return true
        return x.reminder.repeat > 0 && now - la >= x.reminder.repeat * 60000
      })
      if (toAlert.length === 0) return

      const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'granted'
      // Notify highest-priority first; high-priority alerts stay until dismissed.
      // Via the service worker (when registered) the notification carries action
      // buttons and click-routing; otherwise fall back to a plain Notification.
      ;[...toAlert]
        .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority])
        .forEach((x) => {
          if (!canNotify) return
          const od = overdueMins(x.reminder, now)
          const title = `${x.priority === 'High' ? '🔴 ' : ''}Reminder · ${x.priority} priority`
          const opts = {
            body: `${x.text}${od ? ` (overdue ${fmtDur(od)})` : ''}`,
            tag: x.id, renotify: true, requireInteraction: x.priority === 'High',
            data: { taskId: x.id, url: location.href },
          }
          const reg = swRegRef.current
          if (reg && reg.showNotification) {
            reg.showNotification(title, { ...opts, actions: [
              { action: 'done', title: '✓ Done' },
              { action: 'snooze', title: '💤 Snooze 10m' },
              { action: 'view', title: 'View' },
            ] })
          } else {
            const n = new Notification(title, opts)
            liveNotes.current.set(x.id, n)  // so it can be taken down when the task is finished
            // Clicking the toast brings the (possibly hidden-in-tray) window back.
            n.onclick = () => window.autodeck?.showWindow?.()
          }
        })
      // One sound per tick, matched to the highest priority alerting now.
      const topRank = Math.max(...toAlert.map((x) => PRIORITY_RANK[x.priority]))
      const level = topRank === 2 ? 'High' : topRank === 1 ? 'Medium' : 'Low'
      playSfx(level === 'High' && !hpAlarmOn ? 'reminder' : prioritySfx(level))

      const ids = new Set(toAlert.map((x) => x.id))
      setTasks((prev) => patchItems(prev, ids, (x) => ({ ...x, reminder: { ...x.reminder, lastAlert: now } })))
    }
    // Exact timing: a timer is set for the very next moment anything is due (a reminder's time, the end of a snooze, the next
    // repeat) instead of waiting for a polling beat, so alerts fire at the scheduled second, not up to 20 s late.
    let timer = null
    const arm = () => {
      clearTimeout(timer)
      if (mutedRef.current) return
      const at = nextAlertAt(reminderItems(tasksRef.current), Date.now())
      if (at != null) timer = setTimeout(run, Math.min(Math.max(0, at - Date.now()) + 15, 2 ** 31 - 1))
    }
    const run = () => { check(); arm() }
    // Coming back (window shown, tab visible, PC woke from sleep) must not wait for the next timer: a sleeping PC pauses them.
    const onWake = () => { if (!document.hidden) run() }
    run()
    const id = setInterval(run, 20000)  // safety net, and keeps the on-screen clock and "overdue" badges fresh
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    window.addEventListener('autodeck-wake', onWake)  // sent by the desktop shell when Windows resumes from sleep
    return () => {
      clearTimeout(timer); clearInterval(id)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
      window.removeEventListener('autodeck-wake', onWake)
    }
  }, [setTasks, tasks, muted])

  // --- derived: today's tasks, counts, progress ---
  const t = todayStr()
  const todays = useMemo(() => tasks.filter((x) => x.day === t), [tasks, t])
  const doneCount = useMemo(() => todays.filter((x) => x.done).length, [todays])
  const total = todays.length
  const pct = total ? Math.round((doneCount / total) * 100) : 0

  // Celebration + chime when the last open task of a non-empty list gets done.
  useEffect(() => {
    const allDone = total > 0 && doneCount === total
    if (allDone && !prevAllDone.current) {
      playSfx('celebrate')
      setCelebrate(true)
      const id = setTimeout(() => setCelebrate(false), 2600)
      prevAllDone.current = true
      return () => clearTimeout(id)
    }
    if (!allDone) { prevAllDone.current = false; setCelebrate(false) }
  }, [doneCount, total])

  // --- filtered + searched + sorted (pinned first, then priority) ---
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return todays
      .filter((x) => {
        if (filter === 'Active' && x.done) return false
        if (filter === 'Completed' && !x.done) return false
        if (filter === 'High Priority' && x.priority !== 'High') return false
        // Any non-status filter is a category name.
        if (!STATUS_FILTERS.includes(filter) && x.category !== filter) return false
        if (q && !x.text.toLowerCase().includes(q)) return false
        return true
      })
      // Pinned first, incomplete before done, then manual drag order.
      .sort((a, b) =>
        (b.pinned - a.pinned) ||
        (a.done - b.done) ||
        (a.order - b.order))
  }, [todays, filter, query])

  const pending = visible.filter((x) => !x.done)
  const completed = visible.filter((x) => x.done)
  const highPending = todays.filter((x) => !x.done && x.priority === 'High').length
  // how many tasks each filter pill would show (searching doesn't change them)
  const filterCount = useMemo(() => {
    const c = { All: todays.length, Active: 0, Completed: 0, 'High Priority': 0 }
    for (const x of todays) {
      if (x.done) c.Completed++; else c.Active++
      if (x.priority === 'High') c['High Priority']++
      c[x.category] = (c[x.category] || 0) + 1
    }
    return c
  }, [todays])
  // Next upcoming reminder (across all pending tasks, any date) for the header chip.
  const nextReminder = useMemo(() => {
    const up = items
      .filter((x) => !x.done && x.reminder && reminderEventTime(x.reminder).getTime() >= Date.now())
      .sort((a, b) => reminderEventTime(a.reminder) - reminderEventTime(b.reminder))[0]
    return up ? reminderLabel(up.reminder) : null
  }, [items, nowTick])
  // Reminders currently due (past trigger, not done, not snoozed) — powers the
  // always-visible banner, ordered by priority then event time.
  const dueReminders = useMemo(() =>
    items
      .filter((x) => !x.done && x.reminder && reminderTrigger(x.reminder).getTime() <= nowTick && !isSuppressed(x.reminder, nowTick))
      .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        reminderEventTime(a.reminder) - reminderEventTime(b.reminder)),
    [items, nowTick])
  // Reminders scheduled but not yet firing (future trigger, or snoozed) — the
  // "Upcoming reminders" table, ordered by when they'll next surface.
  const upcoming = useMemo(() =>
    items
      .filter((x) => !x.done && x.reminder && x.reminder.snoozeUntil !== DISMISSED &&
        (reminderTrigger(x.reminder).getTime() > nowTick || isSuppressed(x.reminder, nowTick)))
      .sort((a, b) => nextReminderAt(a.reminder, nowTick) - nextReminderAt(b.reminder, nowTick)),
    [items, nowTick])

  // --- mutations (memoized; used across many cards) ---
  const patch = useCallback((id, fn) => setTasks((prev) => patchItems(prev, new Set([id]), fn)), [setTasks])  // a task, or a subtask's reminder item
  const toggle = useCallback((id) => patch(id, (x) => {
    playSfx(x.done ? 'toggleOff' : 'complete')  // different sound for check vs un-check
    return { ...x, done: !x.done }
  }), [patch])
  // Delete keeps the removed task around briefly so it can be undone from the toast.
  const remove = useCallback((id) => {
    const victim = tasksRef.current.find((x) => x.id === id)
    if (!victim) return
    playSfx('delete')
    setUndo(victim)
    archiveAdd([victim], 'deleted')  // kept in the Archive, so a delete is never final
    setTasks((prev) => prev.filter((x) => x.id !== id))
  }, [setTasks, archiveAdd])
  const undoDelete = useCallback(() => {
    if (!undo) return
    setTasks((prev) => (prev.some((x) => x.id === undo.id) ? prev : [...prev, undo]))
    setArchive((prev) => prev.filter((x) => x.id !== undo.id))
    setUndo(null)
  }, [undo, setTasks, setArchive])
  // Archive tab actions
  const restoreArchived = useCallback((ids) => {
    const set = new Set(ids)
    const items = archive.filter((x) => set.has(x.id) && !tasksRef.current.some((t) => t.id === x.id))
    if (!items.length) return
    const base = Date.now()
    setTasks((prev) => [...prev, ...items.map((x, i) => revivedTask(x, base + i))])
    setArchive((prev) => prev.filter((x) => !set.has(x.id)))
    setNotice({ text: `Restored ${items.length} task${items.length === 1 ? '' : 's'} to today.` })
  }, [archive, setTasks, setArchive])
  const deleteArchived = useCallback((ids) => {
    const set = new Set(ids)
    setArchive((prev) => prev.filter((x) => !set.has(x.id)))
    setNotice({ text: `Permanently deleted ${set.size} task${set.size === 1 ? '' : 's'}.` })
  }, [setArchive])
  const rename = useCallback((id, text) => {
    const v = text.trim()
    if (v) patch(id, (x) => ({ ...x, text: v }))
    setEditingId(null)
  }, [patch])
  const togglePin = useCallback((id) => patch(id, (x) => ({ ...x, pinned: !x.pinned })), [patch])
  // --- reminder actions (banner + card) ---
  const snoozeReminder = useCallback((id, mins) => patch(id, (x) =>
    x.reminder ? { ...x, reminder: { ...x.reminder, snoozeUntil: Date.now() + mins * 60000, lastAlert: null } } : x), [patch])
  // Dismiss the current occurrence: recurring skips to its next interval; one-time turns off.
  const dismissReminder = useCallback((id) => patch(id, (x) => {
    if (!x.reminder) return x
    const until = x.reminder.repeat > 0 ? Date.now() + x.reminder.repeat * 60000 : DISMISSED
    return { ...x, reminder: { ...x.reminder, snoozeUntil: until } }
  }), [patch])
  // The same two actions for many at once (the banner's "Snooze all" / "Dismiss all").
  const snoozeAll = useCallback((ids, mins) => {
    const set = new Set(ids)
    setTasks((prev) => patchItems(prev, set, (x) => (x.reminder
      ? { ...x, reminder: { ...x.reminder, snoozeUntil: Date.now() + mins * 60000, lastAlert: null } } : x)))
  }, [setTasks])
  const dismissAll = useCallback((ids) => {
    const set = new Set(ids)
    setTasks((prev) => patchItems(prev, set, (x) => {
      if (!x.reminder) return x
      const until = x.reminder.repeat > 0 ? Date.now() + x.reminder.repeat * 60000 : DISMISSED
      return { ...x, reminder: { ...x.reminder, snoozeUntil: until } }
    }))
  }, [setTasks])
  // Set/replace/clear a task's reminder (re-arms alerts).
  const editReminder = useCallback((id, reminder) => patch(id, (x) =>
    ({ ...x, reminder: reminder ? { ...reminder, lastAlert: null, snoozeUntil: null } : null })), [patch])
  const viewTask = useCallback((rawId) => {
    const id = tasksRef.current.find((x) => (x.subtasks || []).some((st) => st.id === rawId))?.id || rawId  // a step opens its task
    setView('tasks'); setHighlightId(id)
    setTimeout(() => document.getElementById(`task-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
    setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2400)
  }, [])

  // Android: keep the phone's alarm manager in step with the task list, so reminders fire with the app closed,
  // and open the task when its notification is tapped.
  useEffect(() => {
    if (!isAndroid()) return
    const run = () => syncAndroidReminders(items, notify && !muted)
    const id = setTimeout(run, 150)
    // leaving the app right after ticking a task off must not leave its alarm behind: sync at once when the app is hidden
    const onHide = () => { if (document.hidden) { clearTimeout(id); run() } }
    document.addEventListener('visibilitychange', onHide)
    return () => { clearTimeout(id); document.removeEventListener('visibilitychange', onHide) }
  }, [items, notify, muted])
  useEffect(() => initAndroidReminders(viewTask), [viewTask])

  // Register the service worker (skipped on file:// — the desktop build falls
  // back to plain Notifications) and route notification-action clicks back here.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .then((reg) => { swRegRef.current = reg })
      .catch(() => {})
    const onMsg = (e) => {
      const m = e.data
      if (!m || m.type !== 'reminder-action') return
      if (m.action === 'done') patch(m.taskId, (x) => ({ ...x, done: true }))  // "Done" never un-does a finished task
      else if (m.action === 'snooze') snoozeReminder(m.taskId, 10)
      else viewTask(m.taskId)
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    return () => navigator.serviceWorker.removeEventListener('message', onMsg)
  }, [patch, snoozeReminder, viewTask])

  // Move a task to any day (YYYY-MM-DD). Its reminder follows the day and re-arms;
  // a finished task becomes pending again when it lands on a different day.
  const reschedule = useCallback((id, day) => {
    if (day < todayStr()) day = todayStr()  // a typed past date would hide the task from every view
    patch(id, (x) => ({
      ...x, day, done: x.day === day ? x.done : false,
      reminder: x.reminder ? { ...x.reminder, date: day, lastAlert: null, snoozeUntil: null } : null,
      subtasks: (x.subtasks || []).map((st) => (st.reminder ? { ...st, reminder: { ...st.reminder, date: day, lastAlert: null, snoozeUntil: null } } : st)),
    }))
  }, [patch])
  const postpone = useCallback((id) => {
    const d = new Date(); d.setDate(d.getDate() + 1)
    reschedule(id, dateStr(d))
  }, [reschedule])
  const duplicate = useCallback((id) => setTasks((prev) => {
    const src = prev.find((x) => x.id === id)
    if (!src) return prev
    return [...prev, { ...src, id: crypto.randomUUID(), done: false, pinned: false, order: Date.now(), createdAt: Date.now(),
      reminder: src.reminder ? { ...src.reminder, lastAlert: null } : null,
      subtasks: (src.subtasks || []).map((st) => ({ ...st, id: crypto.randomUUID(), done: false,
        reminder: st.reminder ? { ...st.reminder, lastAlert: null, snoozeUntil: null } : st.reminder }))}]
  }), [setTasks])

  const addTask = useCallback((data) => {
    playSfx('add')
    setTasks((prev) => [...prev, {
      id: crypto.randomUUID(),
      text: data.text, priority: data.priority, category: data.category,
      reminder: data.reminder || null, recur: data.recur || null,
      done: false, pinned: false, day: todayStr(), createdAt: Date.now(),
      order: Date.now(), subtasks: data.subtasks || [],
    }])
  }, [setTasks])

  // --- subtasks ---
  // `data` is the step's title, or { text, priority, category, recur, reminder } when it has options of its own
  const addSubtask = useCallback((id, data) => {
    const d = typeof data === 'string' ? { text: data } : data
    const v = (d.text || '').trim()
    if (!v) return
    patch(id, (x) => ({ ...x, subtasks: [...(x.subtasks || []), newSubtask({ ...d, text: v })] }))
  }, [patch])
  // change a step's own priority / category / repeat / reminder (an empty value goes back to "same as the task")
  const editSubtask = useCallback((id, sid, fields) => patch(id, (x) => ({
    ...x, subtasks: x.subtasks.map((st) => (st.id === sid ? applySubFields(st, fields) : st)),
  })), [patch])
  const toggleSubtask = useCallback((id, sid) => patch(id, (x) => ({
    ...x, subtasks: x.subtasks.map((s) => (s.id === sid ? { ...s, done: !s.done } : s)),
  })), [patch])
  const removeSubtask = useCallback((id, sid) => patch(id, (x) => ({
    ...x, subtasks: x.subtasks.filter((s) => s.id !== sid),
  })), [patch])

  // --- drag reorder: reassign order to the new sequence of ids within today's tasks ---
  const reorder = useCallback((activeId, overId) => {
    setTasks((prev) => {
      const t = todayStr()
      const ids = prev.filter((x) => x.day === t).sort((a, b) => a.order - b.order).map((x) => x.id)
      const from = ids.indexOf(activeId)
      const to = ids.indexOf(overId)
      if (from === -1 || to === -1 || from === to) return prev
      ids.splice(to, 0, ids.splice(from, 1)[0])
      const orderMap = Object.fromEntries(ids.map((id, i) => [id, i]))
      return prev.map((x) => (x.id in orderMap ? { ...x, order: orderMap[x.id] } : x))
    })
  }, [setTasks])

  // --- export ---
  // Flatten tasks into printable rows shared by every export format.
  const exportRows = useCallback(() => tasks.map((t) => ({
    Task: t.text,
    Priority: t.priority,
    Category: t.category,
    Status: t.done ? 'Done' : 'Pending',
    Reminder: t.reminder ? `${t.reminder.date} ${t.reminder.time}${t.reminder.lead ? ` (-${t.reminder.lead}m)` : ''}${t.reminder.repeat ? ` /${t.reminder.repeat}m` : ''}` : '',
    Subtasks: (t.subtasks || []).map(subLine).join('; '),
  })), [tasks])

  const download = (blob, ext) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `today-todo-${todayStr()}.${ext}`; a.click()
    URL.revokeObjectURL(url)
  }
  const done = (fmt) => setNotice({ text: `Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${fmt}.` })

  const exportJSON = useCallback(() => {
    download(new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' }), 'json'); done('JSON')
  }, [tasks])

  // CSV opens in Excel/Sheets, needs no dependency (the xlsx lib had unpatched
  // prototype-pollution/ReDoS advisories, and we only ever export, never parse).
  const exportCSV = useCallback(() => {
    const cols = ['Task', 'Priority', 'Category', 'Status', 'Reminder', 'Subtasks']
    // a task starting with = + - or @ would run as a formula when the CSV is opened in Excel: a leading ' makes it plain text
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const csv = [cols.join(','), ...exportRows().map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'csv'); done('CSV')
  }, [exportRows, tasks])

  const exportPDF = useCallback(async () => {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    const title = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    doc.setFontSize(16); doc.text(`Tasks for ${title}`, 14, 18)
    const cols = ['Task', 'Priority', 'Category', 'Status', 'Reminder', 'Subtasks']
    autoTable(doc, {
      startY: 24, head: [cols], body: exportRows().map((r) => cols.map((c) => r[c])),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [79, 70, 229] },
    })
    doc.save(`today-todo-${todayStr()}.pdf`); done('PDF')
  }, [exportRows, tasks])

  const exportWord = useCallback(() => {
    const title = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    const cols = ['Task', 'Priority', 'Category', 'Status', 'Reminder', 'Subtasks']
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    const head = cols.map((c) => `<th>${c}</th>`).join('')
    const body = exportRows().map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'></head>
      <body><h2 style="font-family:Calibri,sans-serif">Tasks for ${title}</h2>
      <table border='1' cellspacing='0' cellpadding='6' style="border-collapse:collapse;font-family:Calibri,sans-serif;font-size:11pt">
      <thead><tr style="background:#4f46e5;color:#fff">${head}</tr></thead><tbody>${body}</tbody></table></body></html>`
    download(new Blob([html], { type: 'application/msword' }), 'doc'); done('Word')
  }, [exportRows, tasks])
  const importTasks = useCallback((file) => {
    if (file.size > 5 * 1024 * 1024) { setNotice({ text: 'Import failed: the file is too large to be a backup.' }); return }
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result)
        if (!Array.isArray(data)) throw new Error('not an array')
        const clean = sanitizeImported(data)
        // the tasks an import replaces go to the Archive (unless the backup contains them again)
        const incoming = new Set(clean.map((x) => x.id))
        archiveAdd(tasksRef.current.filter((x) => !incoming.has(x.id)), 'replaced')
        setTasks(normalizeForToday(clean))
        setNotice({ text: `Imported ${clean.length} task${clean.length === 1 ? '' : 's'}${clean.length < data.length ? ` (${data.length - clean.length} entries were not tasks and were skipped)` : ''}.` })
      } catch {
        setNotice({ text: 'Import failed: not a valid backup file.' })
      }
    }
    reader.readAsText(file)
  }, [setTasks, archiveAdd])

  // Bell click: request permission if needed, otherwise mute/unmute in-app.
  const requestNotify = useCallback(async () => {
    if (isAndroid()) {
      if (notify) { // already allowed: the bell toggles the in-app mute
        setMuted((m) => { setNotice({ text: m ? 'Notifications unmuted.' : 'Notifications muted.' }); return !m })
        return
      }
      const ok = await androidRequestNotify().catch(() => false)
      setNotify(ok)
      if (ok) setMuted(false)
      setNotice({ text: ok ? 'Notifications enabled.' : 'Notifications are off. Allow them for AutoDeck in the phone settings.' })
      return
    }
    if (typeof Notification === 'undefined') {
      setNotice({ text: "This browser doesn't support notifications." })
      return
    }
    if (Notification.permission === 'denied') {
      setNotice({ text: 'Notifications are blocked. Enable them in your browser site settings.' })
      return
    }
    if (Notification.permission === 'granted') {
      // Permission already granted → toggle the app-level mute.
      setMuted((m) => { setNotice({ text: m ? 'Notifications unmuted.' : 'Notifications muted.' }); return !m })
      return
    }
    const res = await Notification.requestPermission()
    setNotify(res === 'granted')
    if (res === 'granted') setMuted(false)
    setNotice({ text: res === 'granted' ? 'Notifications enabled.' : 'Notifications not enabled.' })
  }, [setMuted, notify])

  return (
    <div className="min-h-screen text-slate-900 dark:text-slate-100 transition-colors">
      {/* the page grows with the window instead of staying a narrow strip in the middle of a wide screen */}
      <div className="mx-auto max-w-5xl px-5 py-12 sm:py-16 lg:max-w-6xl lg:px-8 xl:max-w-7xl 2xl:max-w-[96rem]">

        <UpdateBanner />

        {/* Brand */}
        <div className="animate-fade-in mb-8 flex items-center gap-3">
          <AutoDeckIcon size={46} background={false} />
          <div className="leading-none">
            <div className="text-xl font-bold tracking-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
              <span className="text-slate-900 dark:text-white">Auto</span><span className="text-teal-500">Deck</span>
              <span className="ml-2 rounded-full bg-slate-500/10 px-2 py-0.5 align-middle font-sans text-[10px] font-semibold tracking-normal text-slate-500 dark:text-slate-400">v{__APP_VERSION__}</span>
            </div>
            <div className="mt-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Your workflow, on autopilot.
            </div>
          </div>
        </div>

        {/* Header */}
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div className="animate-fade-in min-w-0">
            <Clock />
            <h1 className="mt-1.5 text-4xl font-extrabold tracking-[-0.03em] text-slate-900 sm:text-5xl dark:text-white">
              {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            </h1>
            {total === 0 ? (
              <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">No tasks yet. Add one to get started.</p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatChip className="bg-sky-500/10 text-sky-600 dark:text-sky-300">
                  {pending.length} to do
                </StatChip>
                <StatChip className="bg-lime-500/15 text-lime-700 dark:text-lime-300">
                  {doneCount} done
                </StatChip>
                {highPending > 0 && (
                  <StatChip className="bg-rose-500/10 text-rose-600 dark:text-rose-300">
                    {highPending} high priority
                  </StatChip>
                )}
                {nextReminder && (
                  <StatChip className="bg-slate-500/10 text-slate-600 dark:text-slate-300">
                    <Bell size={11} strokeWidth={2} /> next {nextReminder}
                  </StatChip>
                )}
              </div>
            )}
          </div>
          <div className="glass flex max-w-full items-center gap-0.5 rounded-full p-1 shadow-sm">
            <IconButton
              title={!notify ? 'Notifications off. Click to enable'
                : muted ? 'Notifications muted. Click to unmute'
                : 'Notifications on. Click to mute'}
              onClick={requestNotify} active={notify && !muted}
              className="hover:[&_svg]:scale-[1.15] active:[&_svg]:scale-90">
              <BellIcon active={notify && !muted} size={18} />
              <span className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white transition-colors dark:ring-slate-900 ${
                notify && !muted ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
              }`} />
            </IconButton>
            <IconButton
              title={soundOn ? 'Sound on — click to mute sounds' : 'Sound off — click to enable sounds'}
              onClick={() => { const next = !soundOn; soundEnabled = next; setSoundOn(next); if (next) playSfx('add') }}
              active={soundOn}
              className="hover:[&_svg]:scale-[1.15] active:[&_svg]:scale-90">
              <VolumeIcon on={soundOn} size={18} />
            </IconButton>
            <span className="mx-1 h-4 w-px bg-black/[0.07] dark:bg-white/[0.08]" />
            <div className="relative">
              <IconButton title="Export tasks" onClick={() => setExportOpen((v) => !v)} active={exportOpen}
                  >
                <ExportIcon size={18} />
              </IconButton>
              {exportOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                  <div className="glass animate-fade-up absolute right-0 top-11 z-50 w-40 overflow-hidden rounded-xl p-1 text-sm">
                    {[['PDF', exportPDF], ['CSV', exportCSV], ['Word', exportWord], ['JSON (backup)', exportJSON]].map(([label, fn]) => (
                      <button key={label} disabled={tasks.length === 0}
                        onClick={() => { fn(); setExportOpen(false) }}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left font-medium transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10">
                        <Download size={14} strokeWidth={2} /> {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <IconButton title="Import tasks from backup" onClick={() => fileRef.current?.click()}
              >
              <ImportIcon size={18} />
            </IconButton>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => { if (e.target.files[0]) importTasks(e.target.files[0]); e.target.value = '' }} />
            <span className="mx-1 h-4 w-px bg-black/[0.07] dark:bg-white/[0.08]" />
            <IconButton title="Settings" onClick={() => setSettingsOpen(true)} active={settingsOpen}
              className="hover:[&_svg]:rotate-45">
              <Settings size={18} />
            </IconButton>
            <IconButton title="Toggle theme" onClick={() => setDark((d) => !d)}
              className="hover:[&_svg]:scale-[1.15] active:[&_svg]:scale-90">
              <ThemeIcon dark={dark} size={18} />
            </IconButton>
          </div>
        </header>

        {settingsOpen && (
          <SettingsPanel onClose={() => setSettingsOpen(false)}
            soundOn={soundOn} setSoundOn={setSoundOn}
            volume={volume} setVolume={setVolume}
            hpAlarm={hpAlarm} setHpAlarm={setHpAlarm}
            remDefaults={remDefaults} setRemDefaults={setRemDefaults}
            categories={categories} setCategories={setCategories}
            notify={notify} muted={muted} onRequestNotify={requestNotify} />
        )}

        {/* Always-visible reminder banner — sticks to the top until every due task
            is marked done. Ordered by priority, styled by the top priority present. */}
        {dueReminders.length > 0 && (
          <ReminderBanner items={dueReminders} nowTick={nowTick}
            onDone={toggle} onSnooze={snoozeReminder} onDismiss={dismissReminder} onView={viewTask}
            onSnoozeAll={snoozeAll} onDismissAll={dismissAll}
            notify={notify} muted={muted} />
        )}

        {/* View tabs: Tasks board vs Daily Report */}
        <div className="glass mb-6 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full p-1 shadow-sm">
          {[['tasks', 'Tasks', ListTodo], ['week', 'Week', CalendarDays], ['report', 'Daily Report', ClipboardList], ['archive', 'Archive', ArchiveIcon]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setView(id)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-semibold transition-all duration-300 active:scale-[0.97] sm:px-4 ${
                view === id ? 'bg-teal-500 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
              }`}>
              <Icon size={13} strokeWidth={2.2} className="hidden sm:block" /> {id === 'report' ? <><span className="sm:hidden">Report</span><span className="hidden sm:inline">Daily Report</span></> : label}
              {id === 'archive' && archive.length > 0 && (
                <span className={`rounded-full px-1.5 text-[10px] font-bold tabular-nums ${view === id ? 'bg-white/25' : 'bg-slate-500/15'}`}>{archive.length}</span>
              )}
            </button>
          ))}
        </div>

        {view === 'report' ? (
          <DailyReport tasks={tasks} onAddGoal={addTask} onToggleGoal={toggle} />
        ) : view === 'archive' ? (
          <ArchiveView archive={archive} categories={categories} keepDays={archiveKeep} setKeepDays={setArchiveKeep}
            onRestore={restoreArchived} onDelete={deleteArchived} />
        ) : view === 'week' ? (
          <WeekView tasks={tasks} onView={viewTask} onToggle={toggle} onReschedule={reschedule} onDelete={remove} />
        ) : (
        <>
        <ProgressDashboard pct={pct} done={doneCount} total={total} celebrate={celebrate} />

        <AddTaskForm onAdd={addTask} onFirstReminder={requestNotify} notifyOn={notify && !muted} remDefaults={remDefaults} categories={categories} />

        {upcoming.length > 0 && <UpcomingReminders items={upcoming} nowTick={nowTick} onView={viewTask} onCancel={(id) => editReminder(id, null)} />}

        {/* Search */}
        <div className="relative mb-3">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="glass w-full rounded-full py-3 pl-10 pr-4 text-sm outline-none transition focus:ring-2 focus:ring-sky-500/30"
          />
        </div>

        {/* Filter tabs: fixed status filters + one pill per category */}
        <div className="mb-5 flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => {
            const Icon = FILTER_ICON[f]
            return (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] [&_svg]:transition-transform hover:[&_svg]:scale-110 ${
                  FILTER_STYLE[f][filter === f ? 0 : 1]}`}>
                <Icon size={13} strokeWidth={2.2} />{f}
                <span className="rounded-full bg-black/10 px-1.5 text-[10px] font-bold tabular-nums dark:bg-white/10">{filterCount[f] || 0}</span>
              </button>
            )
          })}
          {categories.map((c) => {
            const active = filter === c.name
            return (
              <button key={c.name} onClick={() => setFilter(c.name)}
                style={active ? { backgroundColor: c.color, color: '#fff' } : { backgroundColor: `${c.color}1a`, color: c.color }}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 ring-inset transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97]">
                <CategoryIcon name={c.name} color={active ? '#fff' : c.color} size={13} />
                {c.name}
                <span className="rounded-full bg-black/10 px-1.5 text-[10px] font-bold tabular-nums dark:bg-white/10">{filterCount[c.name] || 0}</span>
              </button>
            )
          })}
        </div>

        {/* Two boards side-by-side: Pending | Completed */}
        <div className="grid items-start gap-5 md:grid-cols-2">
          <Board label="Pending" count={pending.length}>
            {pending.length === 0 ? (
              <EmptyState icon={Inbox}
                title={query || filter !== 'All' ? 'No matching tasks' : 'All clear'}
                copy={query || filter !== 'All' ? 'Try a different filter or search.' : 'Nothing pending. Enjoy the calm.'} />
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragEnd={({ active, over }) => { if (over && active.id !== over.id) reorder(active.id, over.id) }}>
                <SortableContext items={pending.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-2" aria-label="Pending tasks">
                    {pending.map((task, i) => (
                      <SortableTaskCard key={task.id} task={task} index={i} editing={editingId === task.id}
                        highlight={highlightId === task.id} nowTick={nowTick} categories={categories}
                        onToggle={toggle} onEdit={setEditingId} onRename={rename}
                        onDelete={remove} onPostpone={postpone} onDuplicate={duplicate} onPin={togglePin}
                        onEditReminder={editReminder}
                        onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask} onRemoveSubtask={removeSubtask} onEditSubtask={editSubtask} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
          </Board>

          <Board label="Completed" count={completed.length}>
            {completed.length === 0 ? (
              <EmptyState icon={CheckCircle2}
                title="Nothing done yet" copy="Check off a task and it lands here." />
            ) : (
              <ul className="space-y-2" aria-label="Completed tasks">
                {completed.map((task, i) => (
                  <TaskCard key={task.id} task={task} index={i} editing={editingId === task.id}
                    highlight={highlightId === task.id} nowTick={nowTick} categories={categories}
                    onToggle={toggle} onEdit={setEditingId} onRename={rename}
                    onDelete={remove} onPostpone={postpone} onDuplicate={duplicate} onPin={togglePin}
                    onEditReminder={editReminder}
                    onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask} onRemoveSubtask={removeSubtask} onEditSubtask={editSubtask} />
                ))}
              </ul>
            )}
          </Board>
        </div>
        </>
        )}
      </div>

      {/* Undo toast — restore an accidentally deleted task */}
      {undo && (
        <div className="animate-fade-up fixed inset-x-0 bottom-6 z-50 mx-auto flex w-max max-w-[90vw] items-center gap-3 rounded-full bg-slate-900 py-2.5 pl-5 pr-2.5 text-sm text-white shadow-soft dark:bg-white dark:text-slate-900">
          <span className="truncate">Task deleted</span>
          <button onClick={undoDelete}
            className="rounded-full bg-white/15 px-3 py-1 font-semibold text-white transition hover:bg-white/25 dark:bg-slate-900/10 dark:text-slate-900 dark:hover:bg-slate-900/20">
            Undo
          </button>
        </div>
      )}

      {/* Status / reminder notice toast. Reminders (sticky) stay until dismissed. */}
      {notice && (
        <div className="animate-fade-up shadow-soft fixed inset-x-0 bottom-6 z-50 mx-auto flex w-max max-w-[90vw] items-center gap-3 rounded-full bg-slate-900 py-2.5 pl-5 pr-2.5 text-sm text-white dark:bg-white dark:text-slate-900">
          {notice.sticky && <Bell size={15} strokeWidth={2} className="animate-bell shrink-0 text-sky-400 dark:text-sky-500" />}
          <span className="truncate">{notice.text}</span>
          {notice.sticky && (
            <button onClick={() => setNotice(null)}
              className="rounded-full bg-white/15 px-3 py-1 font-semibold text-white transition hover:bg-white/25 dark:bg-slate-900/10 dark:text-slate-900 dark:hover:bg-slate-900/20">
              OK
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------- Long titles ------------------------------- */
/** A task title that shows two lines, with "more" / "less" to read the rest. Works by tap or click, so the same on
 *  the desktop and Android apps. The cue only appears when the text really is cut. */
function ClampText({ text, className = '', innerClass = '', onDoubleClick }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => { if (!open) setCut(el.scrollHeight > el.clientHeight + 1) }
    measure()
    const ro = new ResizeObserver(measure) // a resized window or rotated phone re-wraps the text
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, open])
  return (
    <span className={`flex-1 ${className}`} onDoubleClick={onDoubleClick}>
      <span ref={ref} className={`break-words ${open ? 'block' : 'line-clamp-2'} ${innerClass}`}>{text}</span>
      {(cut || open) && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          aria-expanded={open}
          className="mt-0.5 text-[11px] font-semibold text-teal-600 hover:underline dark:text-teal-400">
          {open ? 'less' : 'more'}
        </button>
      )}
    </span>
  )
}

/* ------------------------------ Update banner ------------------------------ */
/** Desktop-app auto-update progress (window.autodeck is injected by electron/preload.cjs). */
function UpdateBanner() {
  const [u, setU] = useState({ state: 'idle' })
  useEffect(() => {
    const api = window.autodeck
    if (!api) return
    api.getUpdate().then(setU).catch(() => {})
    return api.onUpdate(setU)
  }, [])
  if (u.state !== 'downloading' && u.state !== 'ready') return null
  const ready = u.state === 'ready'
  return (
    <div className="glass animate-fade-up mb-6 rounded-2xl p-3.5 text-sm" role="status">
      <div className="flex items-center gap-3">
        <Download size={16} className="shrink-0 text-teal-500" />
        <span className="flex-1 font-semibold text-slate-700 dark:text-slate-200">
          {ready ? (u.manual ? `Update ${u.version} is ready to install` : `Update ${u.version} downloaded — restarting to install…`) : `Downloading update ${u.version}… ${u.percent}%`}
        </span>
        {ready && (
          <button onClick={() => window.autodeck.installUpdate()}
            className="rounded-full bg-teal-500 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-600 active:scale-95">
            {u.manual ? 'Install' : 'Restart now'}
          </button>
        )}
      </div>
      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-500/10">
        <div className="h-full rounded-full bg-gradient-to-r from-teal-400 to-sky-500 transition-all duration-300"
          style={{ width: `${ready ? 100 : u.percent}%` }} />
      </div>
    </div>
  )
}

/* ------------------------------- Daily Report ------------------------------ */
/* Reuses tasks as the day's goals. Reports are stored per-date under
   "todo.reports" as { blockers, notes, sharedWith, sharedAt, status, snapshot }.
   Today is always live from current tasks; a saved snapshot lets past days
   survive the daily reset (which prunes finished old tasks). */

const goalStatus = (g) => {
  if (g.done) return 'Completed'
  const subs = g.subtasks || []
  return subs.length && subs.some((s) => s.done) ? 'In Progress' : 'Pending'
}
const fmtDate = (ymd) => new Date(`${ymd}T00:00`).toLocaleDateString(undefined,
  { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

/** Plain-text report in the standard structure — used for copy & download. */
function formatReport({ date, goals, blockers, notes, sharedWith, status }) {
  const done = goals.filter((g) => g.done)
  const remaining = goals.filter((g) => !g.done)
  const pct = goals.length ? Math.round((done.length / goals.length) * 100) : 0
  const list = (arr, fn) => (arr.length ? arr.map(fn).join('\n') : '- —')
  return [
    `Daily Report — ${fmtDate(date)}`,
    '',
    "Today's Goals",
    list(goals, (g) => `- ${g.text} — ${goalStatus(g)}`),
    '',
    'Progress',
    `- Completed: ${done.length}/${goals.length}`,
    `- Overall Progress: ${pct}%`,
    '',
    'Completed Today',
    list(done, (g) => `- ${g.text}`),
    '',
    'Remaining',
    list(remaining, (g) => `- ${g.text}`),
    '',
    'Challenges / Blockers',
    blockers.trim() ? blockers.trim() : '- —',
    '',
    'Additional Notes',
    notes.trim() ? notes.trim() : '- —',
    '',
    'Shared With',
    sharedWith.trim() ? `- ${sharedWith.trim()}` : '- —',
    '',
    'Report Status',
    `- ${status}`,
  ].join('\n')
}

function DailyReport({ tasks, onAddGoal, onToggleGoal }) {
  const [reports, setReports] = useLocalStorage('todo.reports', {})
  const [date, setDate] = useState(todayStr())
  const [newGoal, setNewGoal] = useState('')
  const [copied, setCopied] = useState(false)
  const isToday = date === todayStr()

  const saved = reports[date]
  // Goals: live for today, otherwise the saved snapshot (empty if none).
  const goals = isToday ? tasks.filter((x) => x.day === date) : (saved?.snapshot ?? [])
  const blockers = saved?.blockers ?? ''
  const notes = saved?.notes ?? ''
  const sharedWith = saved?.sharedWith ?? ''
  const status = saved?.status ?? 'Draft'

  const done = goals.filter((g) => g.done).length
  const pct = goals.length ? Math.round((done / goals.length) * 100) : 0

  // Merge fields into the stored report for the selected date.
  const patchReport = (fields) => setReports((r) => ({
    ...r,
    [date]: {
      blockers, notes, sharedWith, status,
      ...r[date],
      // Snapshot the live goals so past dates survive the daily reset (kept fresh on every save).
      snapshot: goals.map((g) => ({ id: g.id, text: g.text, done: g.done, priority: g.priority, subtasks: g.subtasks || [] })),
      ...fields,
    },
  }))

  const addGoal = () => {
    const v = newGoal.trim()
    if (!v || !isToday) return
    onAddGoal({ text: v, priority: 'Medium', category: 'Work', reminder: null })
    setNewGoal('')
  }

  const report = { date, goals, blockers, notes, sharedWith, status }
  const text = formatReport(report)

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { /* clipboard blocked — the download button is the fallback */ }
  }
  const downloadTxt = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `daily-report-${date}.txt`; a.click()
    URL.revokeObjectURL(url)
  }
  const share = () => { patchReport({ sharedAt: Date.now(), status: 'Finalized' }); copy() }

  const badge = (s) => ({
    Completed: 'bg-lime-500/15 text-lime-700 dark:text-lime-300',
    'In Progress': 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    Pending: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  }[s])

  const history = Object.entries(reports)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .filter(([d]) => d !== date)

  return (
    <div className="space-y-5">
      {/* Date picker + status */}
      <div className="glass flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] p-4">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <ClipboardList size={16} className="text-teal-500" />
          <input type="date" value={date} max={todayStr()} onChange={(e) => { if (e.target.value) setDate(e.target.value) }}
            className="glass-sm rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-500/30" />
        </label>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${status === 'Finalized' ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300' : 'bg-slate-500/10 text-slate-500 dark:text-slate-400'}`}>
          {status}{saved?.sharedAt ? ` · shared ${new Date(saved.sharedAt).toLocaleDateString()}` : ''}
        </span>
      </div>

      {/* Summary */}
      <div className="glass grid grid-cols-2 gap-3 rounded-[1.5rem] p-5 sm:grid-cols-4">
        {[['Goals', goals.length], ['Completed', done], ['Remaining', goals.length - done], ['Progress', `${pct}%`]].map(([k, v]) => (
          <div key={k} className="text-center">
            <div className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">{v}</div>
            <div className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{k}</div>
          </div>
        ))}
        <div className="col-span-2 sm:col-span-4">
          <div className="h-2 overflow-hidden rounded-full bg-slate-500/10">
            <div className="h-full rounded-full bg-gradient-to-r from-teal-400 to-sky-500 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {/* Goals */}
      <div className="glass rounded-[1.5rem] p-5">
        <h3 className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">Today's Goals</h3>
        {isToday && (
          <div className="mb-3 flex gap-2">
            <input value={newGoal} onChange={(e) => setNewGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addGoal() }}
              placeholder="Add a goal for today…"
              className="glass-sm flex-1 rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-500/30" />
            <button onClick={addGoal} className="rounded-full bg-teal-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-600 active:scale-95">
              <Plus size={16} strokeWidth={2.5} />
            </button>
          </div>
        )}
        {goals.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-400">{isToday ? 'No goals yet. Add one above.' : 'No report saved for this date.'}</p>
        ) : (
          <ul className="space-y-2">
            {goals.map((g) => {
              const s = goalStatus(g)
              return (
                <li key={g.id} className="glass-sm flex items-center gap-3 rounded-xl px-3 py-2.5">
                  <button onClick={() => isToday && onToggleGoal(g.id)} disabled={!isToday}
                    title={isToday ? 'Toggle complete' : 'Read-only (past date)'}
                    className="shrink-0 transition active:scale-90 disabled:cursor-default">
                    {g.done ? <CheckCircle size={20} className="text-lime-500" /> : <Circle size={20} className="text-slate-300 dark:text-slate-600" />}
                  </button>
                  <span className={`flex-1 text-sm ${g.done ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200'}`}>{g.text}</span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${badge(s)}`}>{s}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Blockers & Notes */}
      <div className="grid gap-5 md:grid-cols-2">
        {[['Challenges / Blockers', blockers, 'blockers', "What's getting in the way…"],
          ['Additional Notes', notes, 'notes', 'Anything else worth sharing…']].map(([label, val, key, ph]) => (
          <div key={key} className="glass rounded-[1.5rem] p-5">
            <h3 className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">{label}</h3>
            <textarea value={val} onChange={(e) => patchReport({ [key]: e.target.value })} rows={4} placeholder={ph}
              className="glass-sm w-full resize-y rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-teal-500/30" />
          </div>
        ))}
      </div>

      {/* Share / finalize */}
      <div className="glass flex flex-wrap items-end gap-3 rounded-[1.5rem] p-5">
        <label className="flex-1 min-w-[180px] text-sm">
          <span className="mb-1 block font-bold text-slate-700 dark:text-slate-200">Share with (manager / senior)</span>
          <input value={sharedWith} onChange={(e) => patchReport({ sharedWith: e.target.value })}
            placeholder="e.g. Priya (Engineering Lead)"
            className="glass-sm w-full rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-500/30" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button onClick={copy} className="flex items-center gap-1.5 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-95 dark:bg-white dark:text-slate-900">
            {copied ? <CheckCircle size={15} /> : <Clipboard size={15} />} {copied ? 'Copied' : 'Copy report'}
          </button>
          <button onClick={downloadTxt} className="flex items-center gap-1.5 rounded-full bg-slate-500/10 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-500/20 active:scale-95 dark:text-slate-200">
            <Download size={15} /> Download
          </button>
          <button onClick={share} disabled={!sharedWith.trim()}
            className="flex items-center gap-1.5 rounded-full bg-teal-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-600 active:scale-95 disabled:opacity-40">
            <Share2 size={15} /> Copy &amp; mark shared
          </button>
        </div>
        <p className="w-full text-xs text-slate-400">
          Sharing copies the report to your clipboard and marks it Finalized — paste it into email/chat to your manager. (No accounts on this device, so it can't be pushed to someone else automatically.)
        </p>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="glass rounded-[1.5rem] p-5">
          <h3 className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">Previous reports</h3>
          <ul className="space-y-2">
            {history.map(([d, r]) => {
              const g = r.snapshot ?? []
              const dn = g.filter((x) => x.done).length
              const p = g.length ? Math.round((dn / g.length) * 100) : 0
              return (
                <li key={d}>
                  <button onClick={() => setDate(d)}
                    className="glass-sm flex w-full items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-left transition hover:ring-2 hover:ring-teal-500/20">
                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{fmtDate(d)}</span>
                    <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      {dn}/{g.length} · {p}%
                      <span className={`rounded-full px-2 py-0.5 font-bold ${r.status === 'Finalized' ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300' : 'bg-slate-500/10'}`}>{r.status ?? 'Draft'}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/* -------------------------------- Archive ---------------------------------- */
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const KEEP_OPTIONS = [['Keep for ever', 0], ['Keep 30 days', 30], ['Keep 90 days', 90], ['Keep 1 year', 365]]
const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['priority', 'Priority'], ['az', 'A to Z']]
const fmtStamp = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dayOf = (ms) => dateStr(new Date(ms))

/** Everything that left the task list: search, filter, sort, restore, delete for good, export, and automatic clean-up. */
function ArchiveView({ archive, categories, keepDays, setKeepDays, onRestore, onDelete }) {
  const [query, setQuery] = useState('')
  const [reason, setReason] = useState('all')
  const [cat, setCat] = useState('all')
  const [pri, setPri] = useState('all')
  const [sort, setSort] = useState('newest')
  const [from, setFrom] = useState('')  // archived on or after
  const [to, setTo] = useState('')      // archived on or before
  const [sel, setSel] = useState(() => new Set())
  const [confirm, setConfirm] = useState(null)  // what a pending "delete for good" would remove: 'selected' | 'all' | a task id
  const [openId, setOpenId] = useState(null)
  const sel_ = 'rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs outline-none focus:border-teal-500 dark:border-slate-800 dark:bg-slate-950/50'
  const pill = 'rounded-full px-3 py-1.5 text-xs font-semibold transition active:scale-95'

  const catNames = useMemo(() => [...new Set([...categories.map((c) => c.name), ...archive.map((x) => x.category)])], [categories, archive])
  const byReason = useMemo(() => {
    const c = { deleted: 0, completed: 0, replaced: 0 }
    archive.forEach((x) => { c[x.reason] = (c[x.reason] || 0) + 1 })
    return c
  }, [archive])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const lo = from ? new Date(`${from}T00:00`).getTime() : -Infinity
    const hi = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity
    const list = archive.filter((x) =>
      (reason === 'all' || x.reason === reason) && (cat === 'all' || x.category === cat) && (pri === 'all' || x.priority === pri) &&
      x.archivedAt >= lo && x.archivedAt <= hi &&
      (!q || x.text.toLowerCase().includes(q) || (x.subtasks || []).some((s) => s.text.toLowerCase().includes(q))))
    const cmp = {
      newest: (a, b) => b.archivedAt - a.archivedAt,
      oldest: (a, b) => a.archivedAt - b.archivedAt,
      priority: (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.archivedAt - a.archivedAt,
      az: (a, b) => a.text.localeCompare(b.text),
    }[sort]
    return [...list].sort(cmp)
  }, [archive, query, reason, cat, pri, sort, from, to])

  // only what is on screen can be selected or acted on, so nothing hidden by a filter is ever touched
  const picked = shown.filter((x) => sel.has(x.id))
  const allPicked = shown.length > 0 && picked.length === shown.length
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const pickAll = () => setSel(allPicked ? new Set() : new Set(shown.map((x) => x.id)))
  const filtered = !!(query || reason !== 'all' || cat !== 'all' || pri !== 'all' || from || to)
  const clearFilters = () => { setQuery(''); setReason('all'); setCat('all'); setPri('all'); setFrom(''); setTo('') }

  const doRestore = (ids) => { onRestore(ids); setSel(new Set()) }
  const doDelete = (ids) => { onDelete(ids); setSel(new Set()); setConfirm(null) }

  const save = (blob, ext) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `autodeck-archive-${todayStr()}.${ext}`; a.click()
    URL.revokeObjectURL(url)
  }
  const exportJSON = () => save(new Blob([JSON.stringify(shown, null, 2)], { type: 'application/json' }), 'json')
  const exportCSV = () => {
    const cols = ['Task', 'Priority', 'Category', 'Archived', 'Why', 'Was done', 'Task day', 'Reminder', 'Subtasks']
    const rows = shown.map((x) => [x.text, x.priority, x.category, new Date(x.archivedAt).toISOString(), ARCHIVE_REASONS[x.reason], x.done ? 'Yes' : 'No', x.day,
      x.reminder ? `${x.reminder.date} ${x.reminder.time}` : '', (x.subtasks || []).map(subLine).join('; ')])
    save(new Blob(['﻿' + [cols.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'csv')
  }

  const row = (x) => {
    const subs = x.subtasks || []
    const open = openId === x.id
    return (
      <li key={x.id} className="glass-sm rounded-2xl border-l-[3px] px-3 py-2.5" style={{ borderLeftColor: catColor(categories, x.category) }}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <input type="checkbox" checked={sel.has(x.id)} onChange={() => toggle(x.id)} aria-label={`Select ${x.text}`} className="h-4 w-4 shrink-0 accent-teal-500" />
          <PriorityChip p={x.priority} size={13} />
          <button onClick={() => setOpenId(open ? null : x.id)} aria-expanded={open}
            className={`min-w-[9rem] flex-1 break-words text-left text-sm ${open ? '' : 'line-clamp-2'} ${x.done ? 'text-slate-400 line-through' : ''}`}>{x.text}</button>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button onClick={() => doRestore([x.id])} title="Restore to today" aria-label="Restore to today"
              className="flex items-center gap-1 rounded-full bg-teal-500/10 px-2.5 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-teal-500/20 active:scale-95 dark:text-teal-300">
              <ArchiveRestore size={13} /> Restore
            </button>
            {confirm === x.id ? (
              <>
                <button onClick={() => doDelete([x.id])} className="rounded-full bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white transition active:scale-95">Delete for good</button>
                <button onClick={() => setConfirm(null)} className="rounded-full px-2 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-600">Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirm(x.id)} title="Delete for good" aria-label="Delete for good"
                className="rounded-full p-1.5 text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-500"><Trash2 size={14} /></button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold sm:text-[11px] ${PRIORITY_BADGE[x.priority]}`}>{x.priority}</span>
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold sm:text-[11px]" style={catBadgeStyle(categories, x.category)}>
            <CategoryIcon name={x.category} color="currentColor" size={11} />{x.category}
          </span>
          <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-semibold text-slate-500 sm:text-[11px] dark:text-slate-400">{ARCHIVE_REASONS[x.reason]}</span>
          {x.done && <span className="rounded-full bg-lime-500/15 px-2 py-0.5 text-[10px] font-semibold text-lime-700 sm:text-[11px] dark:text-lime-300">Was done</span>}
          {subs.length > 0 && <span className="text-[11px] text-slate-400">{subs.filter((s) => s.done).length}/{subs.length} subtasks</span>}
          <span className="text-[11px] text-slate-400">archived {fmtStamp(x.archivedAt)}</span>
        </div>
        {open && (
          <div className="mt-2 space-y-1 border-t border-slate-200/60 pt-2 pl-6 text-xs text-slate-500 dark:border-slate-700/60 dark:text-slate-400">
            <div>Task day: {fmtDate(x.day)}{x.recur ? ` · repeats ${RECUR_LABEL[x.recur].toLowerCase()}` : ''}</div>
            {x.reminder && <div>Reminder: {reminderLabel(x.reminder)} on {x.reminder.date}</div>}
            {subs.map((s) => <div key={s.id} className={s.done ? 'line-through' : ''}>{s.done ? '[x]' : '[ ]'} {s.text}</div>)}
          </div>
        )}
      </li>
    )
  }

  // newest / oldest sorts are grouped under the day they were archived
  const grouped = sort === 'newest' || sort === 'oldest'
  const groups = []
  if (grouped) shown.forEach((x) => { const d = dayOf(x.archivedAt); const g = groups[groups.length - 1]; if (g && g.day === d) g.items.push(x); else groups.push({ day: d, items: [x] }) })

  return (
    <div className="space-y-4">
      <div className="glass rounded-[1.5rem] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ArchiveIcon size={16} className="text-teal-500" />
          <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Archive</span>
          <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{archive.length} task{archive.length === 1 ? '' : 's'}</span>
          {Object.entries(ARCHIVE_REASONS).map(([k, l]) => byReason[k] > 0 && (
            <span key={k} className="text-[11px] text-slate-400">{byReason[k]} {l.toLowerCase()}</span>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select label="Keep archived tasks" title="Old archived tasks are removed automatically" className={sel_} value={keepDays}
              onChange={(e) => setKeepDays(+e.target.value)}>
              {KEEP_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <button onClick={exportCSV} disabled={!shown.length} className={`${pill} bg-slate-500/10 text-slate-600 hover:bg-slate-500/20 disabled:opacity-40 dark:text-slate-300`}>Export CSV</button>
            <button onClick={exportJSON} disabled={!shown.length} className={`${pill} bg-slate-500/10 text-slate-600 hover:bg-slate-500/20 disabled:opacity-40 dark:text-slate-300`}>Export JSON</button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-400">Deleted tasks, finished tasks cleared by the daily reset, and tasks replaced by an import all wait here until you restore or delete them for good.</p>
      </div>

      {archive.length === 0 ? (
        <div className="glass rounded-[1.5rem] p-4"><EmptyState icon={ArchiveIcon} title="Archive is empty" copy="Deleted tasks will appear here, ready to restore." /></div>
      ) : (
        <>
          <div className="glass rounded-[1.5rem] p-4 space-y-3">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the archive…" aria-label="Search the archive"
                className="glass-sm w-full rounded-full py-2.5 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-teal-500/30" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select label="Why archived" className={sel_} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="all">Any reason</option>
                {Object.entries(ARCHIVE_REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
              <Select label="Category" className={sel_} value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="all">Any category</option>
                {catNames.map((n) => <option key={n} value={n} icon={<CategoryIcon name={n} color={catColor(categories, n)} size={14} />}>{n}</option>)}
              </Select>
              <Select label="Priority" className={sel_} value={pri} onChange={(e) => setPri(e.target.value)}>
                <option value="all">Any priority</option>
                {PRIORITIES.map((p) => <option key={p} value={p} icon={<PriorityIcon p={p} size={14} />}>{p}</option>)}
              </Select>
              <Select label="Sort" className={sel_} value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              <label className="flex items-center gap-1 text-[11px] text-slate-400">From
                <input type="date" aria-label="Archived from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={sel_} /></label>
              <label className="flex items-center gap-1 text-[11px] text-slate-400">To
                <input type="date" aria-label="Archived to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={sel_} /></label>
              {filtered && <button onClick={clearFilters} className="text-xs font-semibold text-teal-600 hover:underline dark:text-teal-400">Clear filters</button>}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-3 dark:border-white/10">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={allPicked} onChange={pickAll} disabled={!shown.length} aria-label="Select all shown" className="h-4 w-4 accent-teal-500" />
                {picked.length ? `${picked.length} selected` : `Select all ${shown.length} shown`}
              </label>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button onClick={() => doRestore(picked.map((x) => x.id))} disabled={!picked.length}
                  className={`${pill} bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-40`}>Restore selected</button>
                {confirm === 'selected' ? (
                  <>
                    <button onClick={() => doDelete(picked.map((x) => x.id))} className={`${pill} bg-rose-500 text-white`}>Delete {picked.length} for good</button>
                    <button onClick={() => setConfirm(null)} className={`${pill} text-slate-400`}>Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirm('selected')} disabled={!picked.length}
                    className={`${pill} bg-slate-500/10 text-slate-600 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40 dark:text-slate-300`}>Delete selected</button>
                )}
                {confirm === 'all' ? (
                  <>
                    <button onClick={() => doDelete(archive.map((x) => x.id))} className={`${pill} bg-rose-600 text-white`}>Yes, empty all {archive.length}</button>
                    <button onClick={() => setConfirm(null)} className={`${pill} text-slate-400`}>Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirm('all')} className={`${pill} text-rose-500 hover:bg-rose-500/10`}>Empty archive</button>
                )}
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="glass rounded-[1.5rem] p-4"><EmptyState icon={Inbox} title="Nothing matches" copy="Try different filters or clear them." /></div>
          ) : grouped ? (
            groups.map((g) => (
              <section key={g.day} aria-label={`Archived ${g.day}`}>
                <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {g.day === todayStr() ? 'Today' : fmtDate(g.day)} <span className="font-normal normal-case text-slate-400">· {g.items.length}</span>
                </h3>
                <ul className="space-y-2">{g.items.map(row)}</ul>
              </section>
            ))
          ) : (
            <ul className="space-y-2">{shown.map(row)}</ul>
          )}
        </>
      )}
    </div>
  )
}

/* ---------------------------------- Week ----------------------------------- */
/** 7-day overview (today + 6). Tasks are grouped by their scheduled day, so
    postponed and future recurring tasks show up on the right day. */
function WeekView({ tasks, onView, onToggle, onReschedule, onDelete }) {
  const [openId, setOpenId] = useState(null)  // task whose action row is expanded
  const t0 = todayStr()
  const days = useMemo(() => {  // rebuilt when the date changes, so the week doesn't go stale past midnight
    const base = new Date()
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(base.getDate() + i); return d })
  }, [t0])
  const lastDay = dateStr(days[6])
  // Tasks scheduled beyond the 7 shown days would otherwise be invisible.
  const later = tasks.filter((x) => x.day > lastDay).sort((a, b) => a.day.localeCompare(b.day) || (a.done - b.done))
  const renderItem = (x, isToday, showDate = false) => (
    <li key={x.id} className="glass-sm rounded-lg">
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <button onClick={() => onToggle(x.id)} aria-label={x.done ? 'Mark incomplete' : 'Mark complete'}
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition ${
                            x.done ? 'border-transparent bg-lime-500 text-white' : 'border-slate-300 hover:border-teal-500 dark:border-slate-600'}`}>
                          {x.done && <Check size={10} strokeWidth={3} />}
                        </button>
                        <button onClick={() => setOpenId(openId === x.id ? null : x.id)} aria-expanded={openId === x.id}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          <PriorityChip p={x.priority} size={12} />
                          {/* two lines; the tap that opens the details also shows the whole title */}
                          <span className={`min-w-0 flex-1 break-words text-xs ${openId === x.id ? '' : 'line-clamp-2'} ${x.done ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200'}`}>{x.text}</span>
                          {showDate && <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{x.day.slice(5)}</span>}
                          {x.recur && <RotateCw size={10} className="shrink-0 text-teal-500" />}
                          {x.reminder && <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{fmtTime(x.reminder.time)}</span>}
                        </button>
                      </div>
                      {openId === x.id && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-black/5 px-2 py-1.5 dark:border-white/10">
                          <input type="date" value={x.day} min={t0} aria-label="Move to date"
                            onChange={(e) => e.target.value && onReschedule(x.id, e.target.value)}
                            className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] outline-none focus:border-teal-500 dark:border-slate-800 dark:bg-slate-950/50" />
                          {!isToday && (
                            <button onClick={() => onReschedule(x.id, t0)}
                              className="rounded-full bg-teal-500 px-2.5 py-0.5 text-[11px] font-semibold text-white transition hover:bg-teal-600 active:scale-95">
                              Move to today
                            </button>
                          )}
                          {isToday && (
                            <button onClick={() => onView(x.id)}
                              className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-500/20 dark:text-slate-300">
                              Open
                            </button>
                          )}
                          <button onClick={() => { onDelete(x.id); setOpenId(null) }} aria-label="Delete task" title="Delete"
                            className="ml-auto rounded-md p-1 text-slate-400 transition hover:text-rose-500"><Trash2 size={13} /></button>
                        </div>
                      )}
                    </li>
  )
  return (
    <>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {days.map((d) => {
        const ds = dateStr(d)
        const items = tasks.filter((x) => x.day === ds)
          .sort((a, b) => (a.done - b.done) || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority])
        const isToday = ds === t0
        const openCount = items.filter((x) => !x.done).length
        return (
          <div key={ds} className={`glass rounded-2xl p-3 ${isToday ? 'ring-2 ring-teal-500/40' : ''}`}>
            <div className="mb-2 flex items-baseline justify-between">
              <span className={`text-sm font-bold ${isToday ? 'text-teal-600 dark:text-teal-300' : 'text-slate-700 dark:text-slate-200'}`}>
                {isToday ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
              <span className="text-xs text-slate-400">{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </div>
            {items.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-300 dark:text-slate-600">—</p>
            ) : (
              <ul className="space-y-1.5">
                {items.map((x) => renderItem(x, isToday))}
              </ul>
            )}
            {openCount > 0 && <div className="mt-2 text-right text-[10px] font-semibold text-slate-400">{openCount} open</div>}
          </div>
        )
      })}
    </div>
    {later.length > 0 && (
      <div className="glass mt-3 rounded-2xl p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Later</span>
          <span className="text-xs text-slate-400">{later.length} scheduled after this week</span>
        </div>
        <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {later.map((x) => renderItem(x, false, true))}
        </ul>
      </div>
    )}
    </>
  )
}

/* --------------------------------- Progress -------------------------------- */
/** @param {{pct:number, done:number, total:number, celebrate:boolean}} props */
function ProgressDashboard({ pct, done, total, celebrate }) {
  const R = 30, C = 2 * Math.PI * R
  const msg = total === 0 ? 'Add your first task to get going.'
    : celebrate ? 'Everything done. You crushed today.'
    : pct === 0 ? "Let's make a dent."
    : pct < 50 ? 'Good start. Keep the momentum.'
    : pct < 100 ? 'More than halfway there!'
    : 'All done. Beautiful.'

  return (
    // Double-bezel: outer shell (tray) + inner core (glass plate) with concentric radii.
    <div className={`animate-fade-in mb-6 rounded-[2rem] bg-white/20 p-1.5 ring-1 ring-white/50 transition dark:bg-white/[0.04] dark:ring-white/15 ${celebrate ? 'ring-2 ring-sky-500/50' : ''}`}>
      <div className="glass bezel-core relative flex items-center gap-5 overflow-hidden rounded-[calc(2rem-0.375rem)] p-6">
      {/* diagonal light sheen */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/25 via-transparent to-transparent dark:from-white/[0.08]" />
      <div className="relative shrink-0">
        <svg width="80" height="80" viewBox="0 0 80 80" className="-rotate-90">
          <defs>
            <linearGradient id="prog-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#0EA5E9" />
              <stop offset="100%" stopColor="#2DD4BF" />
            </linearGradient>
          </defs>
          <circle cx="40" cy="40" r={R} strokeWidth="8" className="fill-none stroke-slate-200/70 dark:stroke-white/10" />
          <circle cx="40" cy="40" r={R} strokeWidth="8" strokeLinecap="round" stroke="url(#prog-grad)"
            className={`fill-none [transition:stroke-dashoffset_.7s_cubic-bezier(0.32,0.72,0,1)] ${pct === 100 ? 'glow-pulse' : ''}`}
            strokeDasharray={C} strokeDashoffset={C - (pct / 100) * C} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {celebrate
            ? <PartyPopper size={24} className="animate-wiggle text-lime-500" />
            : <span className="bg-gradient-to-br from-sky-500 to-teal-400 bg-clip-text text-lg font-extrabold tabular-nums text-transparent">{pct}<span className="text-xs">%</span></span>}
        </div>
      </div>
      <div className="relative min-w-0">
        <p className="text-[15px] font-semibold">
          <span className="text-slate-900 dark:text-white">{done}</span>
          <span className="text-slate-400"> / {total} </span>
          <span className="text-slate-500 dark:text-slate-400">done today</span>
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{msg}</p>
      </div>
      </div>
    </div>
  )
}

/* ------------------------------ Reminder editor ---------------------------- */
const REM_CLS = 'rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition focus:border-sky-500 dark:border-slate-800 dark:bg-slate-950/50'
// shared look of the small pill controls under the task box (priority, category, repeat, reminder, subtasks)
const CHIP_BASE = 'inline-flex h-9 items-center rounded-full border border-slate-200 bg-slate-50 px-3 text-sm font-medium outline-none transition dark:border-slate-800 dark:bg-slate-950/50'
const sameReminder = (a, b) => (!a && !b) || (!!a && !!b && a.date === b.date && a.time === b.time && (a.lead || 0) === (b.lead || 0) && (a.repeat || 0) === (b.repeat || 0))
/** The same four pills as the main task, for one step: priority, category, repeat and reminder. Left empty, a step simply
    follows its task. `onChange` gets only the field that changed. */
function SubOptions({ value, onChange, categories, task, remDefaults, remKey = 0 }) {
  const prio = value.priority || ''
  const cat = value.category || ''
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <ChipSelect label="Subtask priority" value={prio} onChange={(e) => onChange({ priority: e.target.value })}
        lead={<PriorityIcon p={prio || task.priority} />}>
        <option value="" icon={<PriorityIcon p={task.priority} />}>Same priority</option>
        {PRIORITIES.map((p) => <option key={p} value={p} icon={<PriorityIcon p={p} />}>{p} priority</option>)}
      </ChipSelect>
      <ChipSelect label="Subtask category" value={cat} onChange={(e) => onChange({ category: e.target.value })}
        lead={<CategoryIcon name={cat || task.category} color={catColor(categories, cat || task.category)} />}>
        <option value="" icon={<CategoryIcon name={task.category} color={catColor(categories, task.category)} />}>Same category</option>
        {categories.map((c) => <option key={c.name} value={c.name} icon={<CategoryIcon name={c.name} color={c.color} />}>{c.name}</option>)}
      </ChipSelect>
      <ChipSelect label="Subtask repeat" value={value.recur || ''} onChange={(e) => onChange({ recur: e.target.value })} lead={<RotateCw size={13} strokeWidth={2.2} />}>
        {RECUR_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l || 'No repeat'}</option>)}
      </ChipSelect>
      <ReminderEditor key={remKey} initial={value.reminder || null} defaults={remDefaults}
        onChange={(r) => { if (!sameReminder(r, value.reminder)) onChange({ reminder: r }) }} />
    </div>
  )
}
/** What a step has of its own, as small badges (nothing is shown for a step that just follows its task). */
function SubChips({ st, categories, nowTick = Date.now() }) {
  const late = st.reminder && !st.done && overdueMins(st.reminder, nowTick) > 0
  if (!st.priority && !st.category && !st.recur && !st.reminder) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {st.priority && <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${PRIORITY_BADGE[st.priority]}`}>{st.priority}</span>}
      {st.category && <span className="rounded-full px-1.5 py-px text-[10px] font-semibold" style={catBadgeStyle(categories, st.category)}>{st.category}</span>}
      {st.recur && <span className="flex items-center gap-0.5 rounded-full bg-teal-500/15 px-1.5 py-px text-[10px] font-bold text-teal-700 dark:text-teal-300"><RotateCw size={9} /> {RECUR_LABEL[st.recur]}</span>}
      {st.reminder && (
        <span className={`flex items-center gap-0.5 text-[10px] ${late ? 'font-bold text-rose-500' : 'text-slate-400'}`} title={`Reminds ${reminderLabel(st.reminder)}`}>
          <Bell size={10} />{reminderLabel(st.reminder)}{late ? ` · overdue ${fmtDur(overdueMins(st.reminder, nowTick))}` : ''}
        </span>
      )}
    </span>
  )
}
/* ------------------------------- Dropdowns --------------------------------- */
/** A drop-in replacement for the native dropdown with a styled list: same <option> children, onChange gets { target: { value } }.
    The list opens under the button (above it when there is no room), works with the mouse, touch and keyboard (arrows, Home,
    End, Enter, Escape, type a letter to jump), shows a tick on the chosen entry, and an option may carry a colour dot
    (dotClass for a Tailwind background class, dotColor for a hex colour). An empty disabled option is the placeholder. */
let selectIds = 0
function Select({ value, onChange, label, title, className = '', lead, disabled, children }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState({ left: 0, top: 0, minWidth: 0 })
  const btn = useRef(null)
  const list = useRef(null)
  const typed = useRef({ text: '', at: 0 })
  const id = useRef(`sel-${++selectIds}`).current

  const all = Children.toArray(children).filter((c) => isValidElement(c) && c.type === 'option').map((c) => ({
    value: String(c.props.value ?? ''), label: Children.toArray(c.props.children).join(''), disabled: !!c.props.disabled,
    dotClass: c.props.dotClass, dotColor: c.props.dotColor, icon: c.props.icon,
  }))
  const chosen = all.find((o) => o.value === String(value ?? ''))
  const shown = all.filter((o) => !(o.value === '' && o.disabled))  // the placeholder is only the button's text, not a choice

  const close = useCallback(() => setOpen(false), [])
  const openList = () => {
    if (disabled) return
    const r = btn.current.getBoundingClientRect()
    setPos({ left: r.left, top: r.bottom + 6, minWidth: r.width, bottom: r.top - 6 })
    const i = shown.findIndex((o) => o.value === String(value ?? ''))
    setActive(i >= 0 ? i : shown.findIndex((o) => !o.disabled))
    setOpen(true)
  }
  const pick = (o) => {
    if (!o || o.disabled) return
    onChange?.({ target: { value: o.value } })
    close()
    btn.current?.focus()
  }

  // place the list once it exists: keep it on screen, and flip above the button when there is no room below
  useLayoutEffect(() => {
    if (!open || !list.current) return
    const h = list.current.offsetHeight, w = list.current.offsetWidth
    setPos((p) => {
      let { left, top } = p
      if (top + h > window.innerHeight - 8 && p.bottom - h > 8) top = p.bottom - h
      else if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h)
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w)
      return top === p.top && left === p.left ? p : { ...p, left, top }
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!list.current?.contains(e.target) && !btn.current?.contains(e.target)) close() }
    const moved = (e) => { if (!list.current?.contains(e.target)) close() }  // scrolling the page under an open list closes it
    document.addEventListener('pointerdown', away)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('scroll', moved, true); window.removeEventListener('resize', close) }
  }, [open, close])

  useEffect(() => { if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [open, active])

  const step = (dir) => {
    let i = active
    for (let n = 0; n < shown.length; n++) { i = (i + dir + shown.length) % shown.length; if (!shown[i].disabled) break }
    setActive(i)
  }
  const onKeyDown = (e) => {
    if (disabled) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(shown.findIndex((o) => !o.disabled)) }
    else if (e.key === 'End') { e.preventDefault(); setActive(shown.length - 1 - [...shown].reverse().findIndex((o) => !o.disabled)) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(shown[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }  // closes the list only, not a dialog behind it
    else if (e.key === 'Tab') close()
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {  // type a few letters to jump to an entry
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now }
      const i = shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text))
      if (i >= 0) setActive(i)
    }
  }

  return (
    <>
      <button ref={btn} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined} aria-label={label} title={title || label} disabled={disabled}
        onClick={() => (open ? close() : openList())} onKeyDown={onKeyDown}
        className={`${className} relative inline-flex min-w-0 cursor-pointer items-center text-left disabled:cursor-default disabled:opacity-50 ${lead ? 'pl-8' : ''} pr-8`}>
        {lead && <span className="pointer-events-none absolute left-3 flex items-center text-slate-500 dark:text-slate-400">{lead}</span>}
        <span className="truncate">{chosen ? chosen.label : ''}</span>
        <ChevronDown size={13} className={`pointer-events-none absolute right-3 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <ul ref={list} id={id} role="listbox" aria-label={label}
          style={{ left: pos.left, top: pos.top, minWidth: Math.max(pos.minWidth, 150), maxWidth: 'calc(100vw - 16px)' }}
          className="thin-scroll animate-fade-up fixed z-[70] max-h-72 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white/95 p-1 text-sm shadow-soft backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/95">
          {shown.map((o, i) => {
            const sel = o.value === String(value ?? '')
            return (
              <li key={o.value + i} id={`${id}-${i}`} role="option" aria-selected={sel} aria-disabled={o.disabled || undefined} data-active={i === active}
                onPointerDown={(e) => e.preventDefault()} /* keep the button focused so the keyboard keeps working */
                onMouseEnter={() => !o.disabled && setActive(i)} onClick={() => pick(o)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 transition-colors ${o.disabled ? 'cursor-default opacity-40' : ''} ${
                  i === active && !o.disabled ? 'bg-sky-500/10 dark:bg-sky-400/10' : ''} ${sel ? 'font-semibold text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'}`}>
                {o.icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{o.icon}</span>}
                {!o.icon && (o.dotClass || o.dotColor) && <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${o.dotClass || ''}`} style={o.dotColor ? { backgroundColor: o.dotColor } : undefined} />}
                <span className="min-w-0 flex-1 whitespace-nowrap">{o.label}</span>
                {sel && <Check size={14} strokeWidth={2.6} className="shrink-0" />}
              </li>
            )
          })}
        </ul>,
        document.body,
      )}
    </>
  )
}

/** A pill-shaped dropdown with a small icon or colour dot in front. */
function ChipSelect({ lead, label, value, onChange, children }) {
  return (
    <Select lead={lead} label={label} value={value} onChange={onChange}
      className={`${CHIP_BASE} hover:border-slate-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20`}>
      {children}
    </Select>
  )
}
const inPreset = (opts, v) => opts.some(([, x]) => x === v)

/** Shared reminder configuration row. Emits a reminder object (no lastAlert/snooze)
    or null via onChange. Used by the add form and the per-task editor. */
function ReminderEditor({ initial, onChange, defaults }) {
  const [on, setOn] = useState(!!initial)
  const [date, setDate] = useState(initial?.date || todayStr())
  const [time, setTime] = useState(initial?.time || '')
  const [lead, setLead] = useState(initial?.lead ?? defaults?.lead ?? 0)
  const [repeat, setRepeat] = useState(initial?.repeat ?? defaults?.repeat ?? 0)
  const [leadCustom, setLeadCustom] = useState(!!initial && initial.lead > 0 && !inPreset(LEAD_OPTIONS, initial.lead))
  const [repeatCustom, setRepeatCustom] = useState(!!initial && initial.repeat > 0 && !inPreset(REPEAT_OPTIONS, initial.repeat))

  useEffect(() => {
    onChange(on && time ? { date: date || todayStr(), time, lead: Math.max(0, +lead || 0), repeat: Math.max(0, +repeat || 0) } : null)
    // onChange is a stable setter; re-emitting only when inputs change is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, date, time, lead, repeat])

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className={`${CHIP_BASE} cursor-pointer gap-1.5 focus-within:ring-2 focus-within:ring-sky-500/40 ${on ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'text-slate-600 hover:border-slate-300 dark:text-slate-300'}`}
        title="Alert (in-app banner + sound, plus desktop when allowed) on a date/time">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="sr-only" />
        <Bell size={14} strokeWidth={2.2} /> Remind me
      </label>
      {on && (
        <>
          <input type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value)} aria-label="Reminder date" className={REM_CLS} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Reminder time" className={REM_CLS} />
          <Select label="Lead time" title="Alert this long before the time" className={REM_CLS}
            value={leadCustom ? 'custom' : lead}
            onChange={(e) => { if (e.target.value === 'custom') setLeadCustom(true); else { setLeadCustom(false); setLead(+e.target.value) } }}>
            {LEAD_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
            <option value="custom">Custom…</option>
          </Select>
          {leadCustom && <input type="number" min="1" value={lead} onChange={(e) => setLead(e.target.value)} aria-label="Custom minutes before" title="Minutes before" className={`${REM_CLS} w-24`} placeholder="min" />}
          <Select label="Repeat interval" title="Repeat until the task is done" className={REM_CLS}
            value={repeatCustom ? 'custom' : repeat}
            onChange={(e) => { if (e.target.value === 'custom') setRepeatCustom(true); else { setRepeatCustom(false); setRepeat(+e.target.value) } }}>
            {REPEAT_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
            <option value="custom">Custom…</option>
          </Select>
          {repeatCustom && <input type="number" min="1" value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Custom repeat minutes" title="Repeat every N minutes" className={`${REM_CLS} w-24`} placeholder="min" />}
        </>
      )}
    </div>
  )
}

/* --------------------------------- Add form -------------------------------- */
function AddTaskForm({ onAdd, onFirstReminder, notifyOn, remDefaults, categories }) {
  const [text, setText] = useState('')
  const [priority, setPriority] = useState('Medium')
  const [category, setCategory] = useState(categories[0]?.name || 'Work')
  const [recur, setRecur] = useState('')   // recurrence rule ('' = none)
  const [rem, setRem] = useState(null)     // reminder object from ReminderEditor
  const [remKey, setRemKey] = useState(0)  // bump to remount/reset the editor after add
  const [subs, setSubs] = useState([])     // steps added before the task is created: { text, priority, category, recur, reminder }
  const [subDraft, setSubDraft] = useState('')
  const [subOpts, setSubOpts] = useState({})  // options for the step being typed
  const [subOptsKey, setSubOptsKey] = useState(0)
  const [editSub, setEditSub] = useState(null) // index of a listed step whose options are open
  const [subsOpen, setSubsOpen] = useState(false)
  const subRef = useRef(null)

  // Keep the selected category valid if the list changes (e.g. deleted in settings).
  useEffect(() => { if (!categories.some((c) => c.name === category)) setCategory(categories[0]?.name || '') }, [categories, category])

  // Live parse of what's typed, so we can preview and use natural-language shortcuts.
  const parsed = text.trim() ? parseQuickAdd(text, categories) : null
  const detected = parsed && (parsed.category || parsed.priority || parsed.reminder)

  // one or many lines (a pasted list becomes one subtask per line); blanks are dropped, titles capped like everywhere else
  const addSubs = (raw) => {
    const lines = String(raw).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\[ ?\]|\d+[.)])\s+/, '').trim().slice(0, 500)).filter(Boolean)
    if (lines.length) setSubs((s) => [...s, ...lines.map((text) => ({ ...subOpts, text }))].slice(0, 200))
  }
  const commitSubDraft = () => {
    if (!subDraft.trim()) return
    addSubs(subDraft); setSubDraft(''); setSubOpts({}); setSubOptsKey((k) => k + 1)  // the next step starts plain again
  }
  const editListed = (i, fields) => setSubs((s) => s.map((st, j) => (j === i ? { ...st, ...fields } : st)))

  const submit = (e) => {
    e.preventDefault()
    const p = parseQuickAdd(text, categories)
    if (!p.text) return
    // Manual editor wins; otherwise fall back to a natural-language time (today, once).
    const reminder = rem
      ? { ...rem, lastAlert: null, snoozeUntil: null }
      : (p.reminder ? { date: p.tomorrow ? dateStr(new Date(Date.now() + 864e5)) : todayStr(), time: p.reminder, lead: 0, repeat: 0, lastAlert: null, snoozeUntil: null } : null)
    const pending = subDraft.trim() ? [...subs, { ...subOpts, text: subDraft.trim().slice(0, 500) }] : subs  // a half-typed subtask is not lost
    onAdd({
      text: p.text,
      priority: p.priority || priority,
      category: p.category || category,
      reminder,
      recur: recur || null,
      subtasks: pending.map((st) => newSubtask(st)),
    })
    setText(''); setRem(null); setRemKey((k) => k + 1); setRecur(''); setSubs([]); setSubDraft(''); setSubOpts({}); setSubOptsKey((k) => k + 1); setEditSub(null); setSubsOpen(false)
    if (reminder) onFirstReminder()  // ask for desktop-notification permission (optional bonus)
  }

  const subCount = subs.length + (subDraft.trim() ? 1 : 0)
  const catDot = (name) => <CategoryIcon name={name} color={catColor(categories, name)} />

  return (
    <form onSubmit={submit}
      className="glass mb-5 rounded-[1.75rem] p-5">
      <div className="flex items-center gap-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Try: Email Sam at 5pm #work !high"
          aria-label="New task" maxLength={2000}
          autoFocus={!matchMedia("(pointer: coarse)").matches}  /* a phone would pop the keyboard up on every launch */
          className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-5 py-3 text-base outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950/50"
        />
        <button type="submit" title="Add task (Enter)"
          className="group flex shrink-0 items-center gap-2 rounded-full bg-sky-600 py-2.5 pl-5 pr-2.5 text-sm font-semibold text-white transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-sky-500 active:scale-[0.98]">
          Add
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105">
            <Plus size={15} strokeWidth={2} />
          </span>
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <ChipSelect label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}
          lead={<PriorityIcon p={priority} />}>
          {PRIORITIES.map((p) => <option key={p} value={p} icon={<PriorityIcon p={p} />}>{p} priority</option>)}
        </ChipSelect>
        <ChipSelect label="Category" value={category} onChange={(e) => setCategory(e.target.value)} lead={catDot(category)}>
          {categories.map((c) => <option key={c.name} value={c.name} icon={<CategoryIcon name={c.name} color={c.color} />}>{c.name}</option>)}
        </ChipSelect>
        <ChipSelect label="Repeat" value={recur} onChange={(e) => setRecur(e.target.value)} lead={<RotateCw size={13} strokeWidth={2.2} />}>
          {RECUR_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l || 'No repeat'}</option>)}
        </ChipSelect>
        <button type="button" onClick={() => { setSubsOpen((o) => !o); setTimeout(() => subRef.current?.focus(), 50) }} aria-expanded={subsOpen}
          title="Break the task into steps"
          className={`${CHIP_BASE} gap-1.5 hover:border-slate-300 ${subsOpen || subCount ? 'border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300' : 'text-slate-600 dark:text-slate-300'}`}>
          <ListTodo size={14} strokeWidth={2.2} /> Subtasks
          {subCount > 0 && <span className="rounded-full bg-teal-500/20 px-1.5 text-[11px] font-bold tabular-nums">{subCount}</span>}
        </button>
        <ReminderEditor key={`${remKey}-${remDefaults.lead}-${remDefaults.repeat}`} initial={null} onChange={setRem} defaults={remDefaults} />
        {rem && !notifyOn && (
          <span className="text-xs text-slate-400">Alerts in-app. Enable notifications for desktop alerts too.</span>
        )}
      </div>

      {/* subtasks added together with the task */}
      {subsOpen && (
        <div className="animate-fade-up mt-3 rounded-2xl border border-slate-200/70 bg-slate-500/[0.04] p-3 dark:border-slate-700/60">
          {subs.length > 0 && (
            <ul className="mb-2 space-y-1" aria-label="Subtasks to add">
              {subs.map((st, i) => (
                <li key={i} className="rounded-lg px-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="h-4 w-4 shrink-0 rounded border border-slate-300 dark:border-slate-600" aria-hidden="true" />
                    <span className="min-w-0 flex-1 break-words">{st.text}</span>
                    <button type="button" onClick={() => setEditSub(editSub === i ? null : i)} aria-label={`Options for subtask ${st.text}`} aria-expanded={editSub === i}
                      className="shrink-0 rounded p-0.5 text-slate-300 transition hover:text-sky-500"><Pencil size={13} /></button>
                    <button type="button" onClick={() => { setSubs((s) => s.filter((_, j) => j !== i)); setEditSub(null) }} aria-label={`Remove subtask ${st.text}`}
                      className="shrink-0 rounded p-0.5 text-slate-300 transition hover:text-rose-500"><X size={13} /></button>
                  </div>
                  <div className="pl-6"><SubChips st={st} categories={categories} /></div>
                  {editSub === i && (
                    <div className="mb-1 mt-1.5 pl-6">
                      <SubOptions value={st} onChange={(f) => editListed(i, f)} categories={categories} task={{ priority, category }} remDefaults={remDefaults} remKey={`l${i}`} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Plus size={14} className="shrink-0 text-slate-400" />
            <input ref={subRef} value={subDraft} onChange={(e) => setSubDraft(e.target.value)} aria-label="New subtask"
              placeholder={subs.length ? 'Add another step… (Enter)' : 'Add a step… (Enter). Paste a list to add several.'}
              maxLength={500}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitSubDraft() }
                else if (e.key === 'Escape') { e.stopPropagation(); setSubDraft(''); setSubsOpen(false) }
                else if (e.key === 'Backspace' && !subDraft && subs.length) setSubs((s) => s.slice(0, -1))
              }}
              onPaste={(e) => {
                const t = e.clipboardData.getData('text')
                if (/\r?\n/.test(t.trim())) { e.preventDefault(); addSubs(t) }
              }}
              className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-slate-400" />
          </div>
          {/* the same pills as the main task, for the step being typed */}
          <div className="mt-2.5 border-t border-slate-200/60 pt-2.5 dark:border-slate-700/60">
            <SubOptions value={subOpts} onChange={(f) => setSubOpts((o) => ({ ...o, ...f }))} categories={categories} task={{ priority, category }}
              remDefaults={remDefaults} remKey={`n${subOptsKey}`} />
          </div>
        </div>
      )}

      {/* live preview of natural-language shortcuts */}
      {detected && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-black/5 pt-3 text-[11px] dark:border-white/10">
          <span className="text-slate-400">Detected:</span>
          {parsed.priority && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 font-semibold text-rose-600 dark:text-rose-300">
              <Flame size={11} />{parsed.priority}
            </span>
          )}
          {parsed.category && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 font-semibold text-sky-600 dark:text-sky-300">
              <Briefcase size={11} />{parsed.category}
            </span>
          )}
          {parsed.reminder && (
            <span className="inline-flex items-center gap-1 rounded-full bg-lime-500/15 px-2 py-0.5 font-semibold text-lime-700 dark:text-lime-300">
              <Bell size={11} />{parsed.tomorrow ? 'Tomorrow ' : ''}{fmtTime(parsed.reminder)}
            </span>
          )}
        </div>
      )}
    </form>
  )
}

/* -------------------------------- Task card -------------------------------- */
// Sortable wrapper: gives TaskCard its drag ref, transform style, and handle props.
function SortableTaskCard(props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.task.id })
  // steady values, so the memoised card below only re-renders when its own task changes
  const tr = CSS.Transform.toString(transform)
  const dragStyle = useMemo(() => ({ transform: tr, transition }), [tr, transition])
  const handleProps = useMemo(() => ({ ...attributes, ...listeners }), [attributes, listeners])
  return <TaskCard {...props} dragRef={setNodeRef} dragStyle={dragStyle} isDragging={isDragging} handleProps={handleProps} />
}

// memo: ticking one task off no longer re-draws every other card (slow with a couple of hundred tasks)
const TaskCard = memo(function TaskCard({ task, index = 0, editing, highlight, nowTick = Date.now(), categories = DEFAULT_CATEGORIES, onToggle, onEdit, onRename, onDelete, onPostpone, onDuplicate, onPin,
  onEditReminder, onAddSubtask, onToggleSubtask, onRemoveSubtask, onEditSubtask, dragRef, dragStyle, handleProps, isDragging }) {
  const [draft, setDraft] = useState(task.text)
  const [expanded, setExpanded] = useState(false)
  const [subDraft, setSubDraft] = useState('')
  const [remOpen, setRemOpen] = useState(false)
  const [remDraft, setRemDraft] = useState(task.reminder || null)
  useEffect(() => { if (editing) setDraft(task.text) }, [editing, task.text])

  const subs = task.subtasks || []
  const doneSubs = subs.filter((s) => s.done).length
  const overdue = task.reminder && !task.done && overdueMins(task.reminder, nowTick) > 0

  const [subOpts, setSubOpts] = useState({})        // options for the step being typed
  const [subOptsOpen, setSubOptsOpen] = useState(false)
  const [subOptsKey, setSubOptsKey] = useState(0)
  const [editSubId, setEditSubId] = useState(null)  // a listed step whose options are open
  const addSub = (e) => {
    e.preventDefault()
    if (!subDraft.trim()) return
    onAddSubtask(task.id, { ...subOpts, text: subDraft })
    setSubDraft(''); setSubOpts({}); setSubOptsKey((k) => k + 1)
  }
  const saveReminder = () => { onEditReminder(task.id, remDraft); setRemOpen(false) }

  return (
    <li
      ref={dragRef}
      id={`task-${task.id}`}
      aria-label={`${task.text}. ${task.priority} priority, ${task.category}.${task.reminder ? ` Reminder ${reminderLabel(task.reminder)}.` : ''}${overdue ? ' Overdue.' : ''}${subs.length ? ` ${doneSubs} of ${subs.length} subtasks done.` : ''}${task.done ? ' Done.' : ''}`}
      style={{ ...dragStyle, animationDelay: `${Math.min(index, 8) * 40}ms`, borderLeftColor: catColor(categories, task.category) }}
      className={`glass-sm group animate-fade-up relative rounded-2xl border-l-[3px] px-3 py-2.5 transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-soft ${
      highlight ? 'ring-2 ring-sky-500/70 soft-pulse' : task.pinned ? 'ring-1 ring-sky-400/40' : ''} ${isDragging ? 'z-10 opacity-60 shadow-soft' : ''}`}>
      {/* wraps: on a narrow screen the action buttons drop under the title instead of squeezing it to nothing */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* drag handle (pending list only) */}
        {handleProps && (
          <button {...handleProps} aria-label="Drag to reorder"
            className="shrink-0 cursor-grab touch-none rounded p-0.5 text-slate-300 transition hover:text-slate-500 active:cursor-grabbing dark:text-slate-600 dark:hover:text-slate-400">
            <GripVertical size={16} />
          </button>
        )}
        {/* checkbox */}
        <button
          onClick={() => onToggle(task.id)}
          aria-label={task.done ? 'Mark incomplete' : 'Mark complete'}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${
            task.done
              ? 'border-transparent bg-lime-500 text-white'
              : 'border-slate-300 hover:border-sky-500 dark:border-slate-600'
          }`}
        >
          {task.done && <Check size={13} strokeWidth={3} className="animate-pop" />}
        </button>

        <PriorityChip p={task.priority} size={15} />

        {/* text / inline edit */}
        {editing ? (
          <input
            autoFocus maxLength={2000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onRename(task.id, draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename(task.id, draft)
              if (e.key === 'Escape') onEdit(null)
            }}
            className="min-w-[9rem] flex-1 rounded-md border border-sky-500 bg-transparent px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <ClampText text={task.text} onDoubleClick={() => onEdit(task.id)}
            className={`min-w-[9rem] text-sm ${task.done ? 'text-slate-400' : ''}`} innerClass={task.done ? 'strike' : ''} />
        )}

        {/* subtask progress chip (toggles the checklist) */}
        {subs.length > 0 && (
          <button onClick={() => setExpanded((v) => !v)}
            title="Show subtasks"
            className="flex shrink-0 items-center gap-1 rounded-full bg-slate-500/10 px-2 py-0.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-500/20 dark:text-slate-400">
            {doneSubs}/{subs.length}
            <ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}

        {/* hover actions */}
        {/* wide screens: the buttons float over the row's corner on hover, so the title keeps the whole row */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 transition group-hover:opacity-100 focus-within:opacity-100 md:absolute md:right-2 md:top-2 md:ml-0 md:rounded-full md:bg-white/85 md:px-1 md:py-0.5 md:opacity-0 md:shadow-sm md:backdrop-blur dark:md:bg-slate-900/80">
          <CardAction title="Subtasks" onClick={() => setExpanded((v) => !v)}><ListTodo size={15} /></CardAction>
          <CardAction title={task.reminder ? 'Edit reminder' : 'Add reminder'} onClick={() => { setRemDraft(task.reminder || null); setRemOpen((v) => !v) }}>
            <Bell size={15} className={task.reminder ? 'text-sky-500' : ''} />
          </CardAction>
          <CardAction title="Edit" onClick={() => onEdit(task.id)}><Pencil size={15} /></CardAction>
          <CardAction title={task.pinned ? 'Unpin' : 'Pin to top'} onClick={() => onPin(task.id)}>
            {task.pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </CardAction>
          <CardAction title="Postpone to tomorrow" onClick={() => onPostpone(task.id)}><CalendarArrowUp size={15} /></CardAction>
          <CardAction title="Duplicate" onClick={() => onDuplicate(task.id)}><Copy size={15} /></CardAction>
          <CardAction title="Delete" onClick={() => onDelete(task.id)} danger><Trash2 size={15} /></CardAction>
        </div>
      </div>

      {/* badges row — wraps under the title so it never crowds the task text */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold sm:text-[11px] ${PRIORITY_BADGE[task.priority]}`}>{task.priority}</span>
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold sm:text-[11px]" style={catBadgeStyle(categories, task.category)}>
          <CategoryIcon name={task.category} color="currentColor" size={11} />{task.category}
        </span>
        {task.recur && (
          <span className="flex items-center gap-0.5 rounded-full bg-teal-500/15 px-2 py-0.5 text-[10px] font-bold text-teal-700 sm:text-[11px] dark:text-teal-300" title={`Repeats: ${RECUR_LABEL[task.recur]}`}>
            <RotateCw size={10} /> {RECUR_LABEL[task.recur]}
          </span>
        )}
        {overdue && (
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-600 sm:text-[11px] dark:text-rose-300">
            Overdue {fmtDur(overdueMins(task.reminder, nowTick))}
          </span>
        )}
        {task.reminder && (
          <span className={`flex items-center gap-0.5 text-[11px] ${overdue ? 'text-rose-500' : 'text-slate-400'}`}
            title={`Reminds ${reminderLabel(task.reminder)}`}>
            <Bell size={11} />{reminderLabel(task.reminder)}
          </span>
        )}
      </div>

      {/* subtask checklist */}
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-slate-200/60 pt-2 pl-7 dark:border-slate-700/60">
          {subs.map((s) => (
            <div key={s.id}>
              <div className="group/sub flex items-center gap-2 text-sm">
                <button onClick={() => onToggleSubtask(task.id, s.id)}
                  aria-label={s.done ? 'Mark subtask incomplete' : 'Mark subtask complete'}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                    s.done ? 'border-transparent bg-lime-500 text-white' : 'border-slate-300 hover:border-sky-500 dark:border-slate-600'}`}>
                  {s.done && <Check size={11} strokeWidth={3} />}
                </button>
                <span className={`min-w-0 flex-1 break-words ${s.done ? 'text-slate-400' : ''}`}>
                  <span className={s.done ? 'strike' : ''}>{s.text}</span>
                </span>
                <button onClick={() => setEditSubId(editSubId === s.id ? null : s.id)} aria-label="Subtask options" aria-expanded={editSubId === s.id}
                  className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition hover:text-sky-500 focus:opacity-100 group-hover/sub:opacity-100">
                  <Pencil size={12} />
                </button>
                <button onClick={() => onRemoveSubtask(task.id, s.id)} aria-label="Delete subtask"
                  className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition hover:text-rose-500 focus:opacity-100 group-hover/sub:opacity-100">
                  <X size={13} />
                </button>
              </div>
              <div className="pl-6"><SubChips st={s} categories={categories} nowTick={nowTick} /></div>
              {editSubId === s.id && (
                <div className="mb-1 mt-1.5 pl-6">
                  <SubOptions value={s} onChange={(f) => onEditSubtask(task.id, s.id, f)} categories={categories} task={task} remKey={`e${s.id}`} />
                </div>
              )}
            </div>
          ))}
          <form onSubmit={addSub} className="space-y-2">
            <div className="flex items-center gap-2">
              <Plus size={13} className="shrink-0 text-slate-400" />
              <input value={subDraft} onChange={(e) => setSubDraft(e.target.value)}
                placeholder="Add a subtask…" maxLength={500}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400" />
              <button type="button" onClick={() => setSubOptsOpen((o) => !o)} aria-expanded={subOptsOpen} title="Priority, category, repeat and reminder for this step"
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${subOptsOpen || Object.keys(subOpts).length ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300' : 'bg-slate-500/10 text-slate-500 hover:bg-slate-500/20 dark:text-slate-400'}`}>
                Options
              </button>
            </div>
            {subOptsOpen && (
              <div className="pl-5">
                <SubOptions value={subOpts} onChange={(f) => setSubOpts((o) => ({ ...o, ...f }))} categories={categories} task={task} remKey={`n${subOptsKey}`} />
              </div>
            )}
          </form>
        </div>
      )}

      {/* inline reminder editor */}
      {remOpen && (
        <div className="mt-2 border-t border-slate-200/60 pt-2.5 pl-7 dark:border-slate-700/60">
          <ReminderEditor initial={task.reminder} onChange={setRemDraft} />
          <div className="mt-2 flex items-center gap-2">
            <button onClick={saveReminder}
              className="rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-sky-500 active:scale-95">
              Save reminder
            </button>
            {task.reminder && (
              <button onClick={() => { onEditReminder(task.id, null); setRemDraft(null); setRemOpen(false) }}
                className="rounded-full bg-slate-500/10 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-500/20 dark:text-slate-300">
                Remove
              </button>
            )}
            <button onClick={() => setRemOpen(false)}
              className="rounded-full px-3 py-1 text-xs font-semibold text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200">
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  )
})

/* ----------------------------- Reminder banner ----------------------------- */
// Per-priority banner styling — High is the most urgent, Low the calmest.
const PRI_STYLE = {
  High:   { wrap: 'border-rose-500/40 bg-rose-500/10 dark:bg-rose-500/[0.12]', text: 'text-rose-700 dark:text-rose-300', icon: 'text-rose-500', accent: '#f43f5e' },
  Medium: { wrap: 'border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/[0.12]', text: 'text-amber-700 dark:text-amber-300', icon: 'text-amber-500', accent: '#f59e0b' },
  Low:    { wrap: 'border-slate-400/40 bg-slate-500/10 dark:bg-slate-500/[0.12]', text: 'text-slate-700 dark:text-slate-300', icon: 'text-slate-500', accent: '#94a3b8' },
}

function ReminderBanner({ items, nowTick, onDone, onSnooze, onDismiss, onView, onSnoozeAll, onDismissAll, notify, muted }) {
  const top = items[0].priority             // items are sorted priority-desc
  const s = PRI_STYLE[top]
  const [collapsed, setCollapsed] = useState(false)
  // A new reminder falling due opens a collapsed banner again, so it can't go unnoticed.
  const prevCount = useRef(items.length)
  useEffect(() => {
    if (items.length > prevCount.current) setCollapsed(false)
    prevCount.current = items.length
  }, [items.length])
  const many = items.length > 1
  const ids = items.map((t) => t.id)
  const pill = 'rounded-full bg-slate-500/10 px-2.5 py-1 text-xs font-semibold text-slate-600 outline-none transition hover:bg-slate-500/20 dark:text-slate-300'
  // Pinned to the top only while it is short: a tall one would cover the page it is meant to sit above.
  const pinned = collapsed || items.length <= 3
  return (
    <div className={`animate-fade-up ${pinned ? 'sticky top-3' : ''} z-30 mb-6 rounded-2xl border p-3 shadow-soft backdrop-blur-md ${s.wrap}`}>
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1 ${collapsed ? '' : 'mb-2'}`}>
        <Bell size={16} strokeWidth={2.4} className={`animate-bell ${s.icon}`} />
        <span className={`text-sm font-bold ${s.text}`}>
          {items.length} reminder{items.length === 1 ? '' : 's'} due
        </span>
        {collapsed && <span className="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300">{items[0].text}</span>}
        {!collapsed && (!notify || muted) && (
          <span className="text-[11px] font-medium opacity-80">
            {muted ? 'Sound muted' : 'Enable notifications for desktop alerts'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {many && !collapsed && (
            <>
              <Select label="Snooze all" title="Snooze all of them" value=""
                onChange={(e) => { if (e.target.value) { onSnoozeAll(ids, +e.target.value); e.target.value = '' } }}
                className={pill}>
                <option value="" disabled>Snooze all</option>
                {SNOOZE_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              <button onClick={() => onDismissAll(ids)} title="Dismiss all of them" className={pill}>Dismiss all</button>
            </>
          )}
          <button onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}
            title={collapsed ? 'Show the reminders' : 'Collapse to one line'}
            className="flex items-center gap-1 rounded-full bg-slate-500/10 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-500/20 dark:text-slate-300">
            {collapsed ? 'Show' : 'Collapse'}
            <ChevronDown size={12} className={`transition-transform ${collapsed ? '' : 'rotate-180'}`} />
          </button>
        </div>
      </div>
      {!collapsed && <ul className="thin-scroll max-h-[max(9rem,33vh)] space-y-1.5 overflow-y-auto pr-1">
        {items.map((task) => {
          const od = overdueMins(task.reminder, nowTick)
          const ps = PRI_STYLE[task.priority]
          return (
            <li key={task.id} style={{ borderLeftColor: ps.accent }}
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border-l-[3px] bg-white/60 px-3 py-2 dark:bg-slate-900/40">
              <PriorityChip p={task.priority} size={14} />
              {/* a reminder shows the whole task, however long */}
              <span className="min-w-0 flex-1 break-words text-sm font-medium text-slate-800 dark:text-slate-100">{task.text}</span>
              {od > 0 && <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-600 dark:text-rose-300">OVERDUE {fmtDur(od)}</span>}
              <span className="hidden shrink-0 items-center gap-1 text-[11px] font-semibold text-slate-500 sm:flex dark:text-slate-400">
                <Bell size={10} /> {reminderLabel(task.reminder)}
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${PRIORITY_BADGE[task.priority]}`}>{task.priority}</span>
              <div className="flex shrink-0 items-center gap-1">
                <button onClick={() => onDone(task.id)} title="Mark completed"
                  className="rounded-full bg-lime-500 px-3 py-1 text-xs font-semibold text-white transition hover:bg-lime-600 active:scale-95">Done</button>
                <Select label="Snooze" title="Snooze" value=""
                  onChange={(e) => { if (e.target.value) { onSnooze(task.id, +e.target.value); e.target.value = '' } }}
                  className="rounded-full bg-slate-500/10 px-2 py-1 text-xs font-semibold text-slate-600 outline-none dark:text-slate-300">
                  <option value="" disabled>Snooze</option>
                  {SNOOZE_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
                </Select>
                <button onClick={() => onView(task.id)} title="View task"
                  className="rounded-full p-1.5 text-slate-500 transition hover:bg-black/5 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10"><Search size={13} /></button>
                <button onClick={() => onDismiss(task.id)} title={task.reminder.repeat ? 'Dismiss (returns next interval)' : 'Dismiss'}
                  className="rounded-full p-1.5 text-slate-400 transition hover:bg-black/5 hover:text-rose-500 dark:hover:bg-white/10"><X size={14} /></button>
              </div>
            </li>
          )
        })}
      </ul>}
    </div>
  )
}

/* --------------------------- Upcoming reminders ---------------------------- */
function UpcomingReminders({ items, nowTick, onView, onCancel }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="glass mb-5 rounded-[1.5rem] p-4">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2">
        <Bell size={15} className="text-sky-500" />
        <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Upcoming reminders</span>
        <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[11px] font-bold text-slate-500 dark:text-slate-400">{items.length}</span>
        <ChevronDown size={15} className={`ml-auto text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="pb-2 pr-3 font-semibold">Task</th>
                <th className="pb-2 pr-3 font-semibold">Priority</th>
                <th className="pb-2 pr-3 font-semibold">Due</th>
                <th className="pb-2 pr-3 font-semibold">Next</th>
                <th className="pb-2 pr-3 font-semibold">Frequency</th>
                <th className="pb-2 pr-3 font-semibold">Status</th>
                <th className="pb-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((task) => {
                const r = task.reminder
                const snoozed = isSuppressed(r, nowTick)
                const overdue = reminderEventTime(r).getTime() < nowTick
                const status = snoozed ? 'Snoozed' : overdue ? 'Overdue' : 'Pending'
                const next = new Date(nextReminderAt(r, nowTick))
                return (
                  <tr key={task.id} className="border-t border-black/5 dark:border-white/5">
                    <td className="py-2 pr-3">
                      <button onClick={() => onView(task.id)} className="max-w-[220px] break-words text-left font-medium text-slate-700 hover:text-sky-600 dark:text-slate-200">{task.text}</button>
                    </td>
                    <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${PRIORITY_BADGE[task.priority]}`}>{task.priority}</span></td>
                    <td className="py-2 pr-3 tabular-nums text-slate-500 dark:text-slate-400">{r.date === todayStr() ? '' : r.date.slice(5) + ' '}{fmtTime(r.time)}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-500 dark:text-slate-400">{fmtTime(`${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`)}</td>
                    <td className="py-2 pr-3 text-slate-500 dark:text-slate-400">{freqLabel(r)}</td>
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        status === 'Overdue' ? 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
                        : status === 'Snoozed' ? 'bg-slate-500/10 text-slate-500 dark:text-slate-400'
                        : 'bg-sky-500/10 text-sky-600 dark:text-sky-300'}`}>{status}</span>
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => onCancel(task.id)} title="Cancel reminder"
                        className="rounded-full p-1 text-slate-400 transition hover:text-rose-500"><X size={14} /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ Settings panel ----------------------------- */
function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-600'}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function SettingsPanel({ onClose, soundOn, setSoundOn, volume, setVolume, hpAlarm, setHpAlarm, remDefaults, setRemDefaults, categories, setCategories, notify, muted, onRequestNotify }) {
  const [newCat, setNewCat] = useState('')
  const [newColor, setNewColor] = useState('#0ea5e9')
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const addCat = () => {
    const name = newCat.trim()
    // a category called "All" or "Active" would collide with the status filters beside it
    if (!name || [...STATUS_FILTERS, ...categories.map((c) => c.name)].some((n) => n.toLowerCase() === name.toLowerCase())) return
    setCategories([...categories, { name, color: newColor }])
    setNewCat('')
  }
  const removeCat = (name) => setCategories(categories.filter((c) => c.name !== name))
  const recolor = (name, color) => setCategories(categories.map((c) => (c.name === name ? { ...c, color } : c)))
  const sel = 'rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-teal-500 dark:border-slate-800 dark:bg-slate-950/50'
  const notifState = notify ? (muted ? 'Muted' : 'On') : 'Off'
  // Desktop app only: keep running in the tray (and start with Windows) so reminders arrive while the window is closed.
  const [bg, setBg] = useState(null)
  useEffect(() => { window.autodeck?.getBackground?.().then(setBg).catch(() => {}) }, [])
  const changeBg = (on) => { setBg(on); window.autodeck?.setBackground?.(on) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-label="Settings"
        className="glass animate-fade-up relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[1.5rem] p-6 shadow-soft">
        <div className="mb-4 flex items-center gap-2">
          <Settings size={18} className="text-teal-500" />
          <div className="leading-tight">
            <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">Reminder & notification settings</h2>
            <p className="text-xs font-semibold text-slate-400">AutoDeck v{__APP_VERSION__}</p>
          </div>
          <button onClick={onClose} aria-label="Close settings" className="ml-auto rounded-full p-1.5 text-slate-400 transition hover:bg-black/5 hover:text-slate-700 dark:hover:bg-white/10"><X size={18} /></button>
        </div>

        <div className="space-y-4 text-sm">
          {/* Desktop notifications */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-200">Desktop notifications</div>
              <div className="text-xs text-slate-400">Currently: {notifState}</div>
            </div>
            <button onClick={onRequestNotify}
              className="rounded-full bg-slate-500/10 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-500/20 dark:text-slate-200">
              {!notify ? 'Enable' : muted ? 'Unmute' : 'Mute'}
            </button>
          </div>

          {/* Keep running when closed (desktop app) */}
          {bg !== null && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-700 dark:text-slate-200">Reminders when closed</div>
                <div className="text-xs text-slate-400">Closing the window keeps AutoDeck in the tray, and it starts with Windows, so reminders still arrive. Quit from the tray icon.</div>
              </div>
              <Switch checked={bg} onChange={changeBg} label="Reminders when closed" />
            </div>
          )}

          {/* Sound on/off */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-200">Sound effects</div>
              <div className="text-xs text-slate-400">Alarms and UI chimes</div>
            </div>
            <Switch checked={soundOn} onChange={setSoundOn} label="Sound effects" />
          </div>

          {/* Volume */}
          <div className={soundOn ? '' : 'pointer-events-none opacity-40'}>
            <div className="mb-1.5 flex items-center gap-2 font-semibold text-slate-700 dark:text-slate-200">
              <Volume2 size={15} /> Volume
              <span className="ml-auto text-xs font-normal text-slate-400">{Math.round(volume * 100)}%</span>
            </div>
            <div className="flex items-center gap-3">
              <input type="range" min="0" max="100" value={Math.round(volume * 100)}
                onChange={(e) => setVolume(+e.target.value / 100)}
                className="w-full accent-teal-500" aria-label="Volume" />
              <button onClick={() => playSfx('reminder')}
                className="shrink-0 rounded-full bg-slate-500/10 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-500/20 dark:text-slate-200">Test</button>
            </div>
          </div>

          {/* High-priority alarm */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-200">Louder alarm for high priority</div>
              <div className="text-xs text-slate-400">Off = high priority uses the standard chime</div>
            </div>
            <Switch checked={hpAlarm} onChange={setHpAlarm} label="Louder alarm for high priority" />
          </div>

          {/* Default reminder times */}
          <div className="border-t border-black/5 pt-4 dark:border-white/10">
            <div className="mb-2 font-semibold text-slate-700 dark:text-slate-200">Defaults for new reminders</div>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                Lead
                <Select label="Default lead time" className={sel} value={remDefaults.lead}
                  onChange={(e) => setRemDefaults({ ...remDefaults, lead: +e.target.value })}>
                  {LEAD_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                Repeat
                <Select label="Default repeat" className={sel} value={remDefaults.repeat}
                  onChange={(e) => setRemDefaults({ ...remDefaults, repeat: +e.target.value })}>
                  {REPEAT_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-400">Pre-fills the reminder fields when you add a task.</p>
          </div>

          {/* Categories */}
          <div className="border-t border-black/5 pt-4 dark:border-white/10">
            <div className="mb-2 font-semibold text-slate-700 dark:text-slate-200">Categories</div>
            <ul className="mb-2 space-y-1.5">
              {categories.map((c) => (
                <li key={c.name} className="flex items-center gap-2">
                  <input type="color" value={c.color} onChange={(e) => recolor(c.name, e.target.value)}
                    aria-label={`Colour for ${c.name}`} title="Change colour"
                    className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                  <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">{c.name}</span>
                  <button onClick={() => removeCat(c.name)} aria-label={`Delete ${c.name}`} title="Delete category"
                    disabled={categories.length <= 1}
                    className="rounded-full p-1 text-slate-400 transition hover:text-rose-500 disabled:opacity-30"><X size={14} /></button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} aria-label="New category colour"
                className="h-7 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
              <input value={newCat} onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCat() }} placeholder="New category…"
                className={`${sel} flex-1`} />
              <button onClick={addCat} className="rounded-full bg-teal-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-600 active:scale-95">Add</button>
            </div>
          </div>

          <p className="border-t border-black/5 pt-4 text-xs text-slate-400 dark:border-white/10">
            Manage active reminders in the <span className="font-semibold text-slate-500 dark:text-slate-300">Upcoming reminders</span> panel on the Tasks tab — view, cancel, or edit each one there.
          </p>        </div>
      </div>
    </div>
  )
}

/* -------------------------------- Primitives ------------------------------- */
function IconButton({ children, onClick, title, active, className = '' }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={`relative rounded-full p-2 transition [&_svg]:transition-transform [&_svg]:duration-300 [&_svg]:ease-[cubic-bezier(0.32,0.72,0,1)] ${
        active
          ? 'bg-sky-500/10 text-sky-600 hover:bg-sky-500/15 dark:bg-sky-400/15 dark:text-sky-300'
          : 'text-slate-500 hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/10'
      } ${className}`}>
      {children}
    </button>
  )
}

function CardAction({ children, onClick, title, danger }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className={`rounded-md p-1.5 text-slate-400 transition [&_svg]:transition-transform [&_svg]:duration-300 hover:[&_svg]:scale-125 active:[&_svg]:scale-90 hover:bg-slate-100 dark:hover:bg-slate-800 ${
        danger ? 'hover:text-rose-600' : 'hover:text-slate-700 dark:hover:text-slate-200'
      }`}>
      {children}
    </button>
  )
}

// Export/import icons — static tray + an arrow group that animates on hover.
function ExportIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 15 v3 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-3" />
      <g className="ad-arrow-dn">
        <path d="M12 3 V14.5" />
        <path d="M8 10.5 L12 14.5 L16 10.5" />
      </g>
    </svg>
  )
}
function ImportIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 15 v3 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-3" />
      <g className="ad-arrow-up">
        <path d="M12 14.5 V3" />
        <path d="M8 7 L12 3 L16 7" />
      </g>
    </svg>
  )
}

// Bell icon whose mute slash draws itself smoothly across the bell.
function BellIcon({ active, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g className={active ? 'animate-bell' : ''} style={{ transformOrigin: '12px 4px' }}>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </g>
      {/* diagonal slash — drawn when muted/off, retracts when active */}
      <line x1="3.5" y1="3.5" x2="20.5" y2="20.5"
        style={{ strokeDasharray: 26, strokeDashoffset: active ? 26 : 0, transition: 'stroke-dashoffset .4s cubic-bezier(0.32,0.72,0,1)' }} />
    </svg>
  )
}

// Theme icon: sun and moon cross-fade with a scale+rotate morph.
function ThemeIcon({ dark, size = 18 }) {
  const t = { transformBox: 'fill-box', transformOrigin: 'center', transition: 'opacity .3s ease, transform .4s cubic-bezier(0.32,0.72,0,1)' }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* sun — light mode */}
      <g style={{ ...t, opacity: dark ? 0 : 1, transform: dark ? 'scale(0.4) rotate(-90deg)' : 'scale(1) rotate(0deg)' }}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </g>
      {/* moon — dark mode */}
      <g style={{ ...t, opacity: dark ? 1 : 0, transform: dark ? 'scale(1) rotate(0deg)' : 'scale(0.4) rotate(90deg)' }}>
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
      </g>
    </svg>
  )
}

// Volume icon whose sound waves morph into an X (and back) when toggled.
function VolumeIcon({ on, size = 18 }) {
  const tween = { transformBox: 'fill-box', transformOrigin: 'center', transition: 'opacity .3s ease, transform .4s cubic-bezier(0.32,0.72,0,1)' }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {/* sound waves — visible when on */}
      <g style={{ ...tween, opacity: on ? 1 : 0, transform: on ? 'scale(1)' : 'scale(0.3)' }}>
        <path d="M15.54 8.46 a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93 a10 10 0 0 1 0 14.14" />
      </g>
      {/* mute cross — visible when off */}
      <g style={{ ...tween, opacity: on ? 0 : 1, transform: on ? 'scale(0.3) rotate(-90deg)' : 'scale(1) rotate(0deg)' }}>
        <path d="M22 9 L16 15" />
        <path d="M16 9 L22 15" />
      </g>
    </svg>
  )
}

// Greeting + live clock. Self-contained so the per-second tick only re-renders
// this line, not the whole app (which holds every task/board).
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const { text, Icon } = greeting()
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-black/5 bg-white/50 py-1 pl-2.5 pr-1 text-sm font-semibold shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-white/5">
      <Icon size={14} className={`text-sky-500 ${Icon === Sun ? 'animate-spin-slow' : ''}`} />
      <span className="bg-gradient-to-r from-sky-500 to-teal-400 bg-clip-text text-transparent">{text}</span>
      <span className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-sky-700 dark:bg-sky-400/10 dark:text-sky-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime-500 shadow-[0_0_0_2px] shadow-lime-500/25" />
        {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
      </span>
    </div>
  )
}

// Small rounded stat pill for the header summary.
function StatChip({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>
      {children}
    </span>
  )
}

// A board panel with an accent-colored header (teal = Pending, lime = Completed).
function Board({ label, count, children }) {
  const completed = label === 'Completed'
  const Icon = completed ? CheckCircle2 : ListTodo
  const accent = completed ? 'text-lime-600 dark:text-lime-400' : 'text-sky-600 dark:text-sky-400'
  const chip = completed
    ? 'bg-lime-500/15 text-lime-700 dark:text-lime-300'
    : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
  const wash = completed ? 'from-lime-500/10 dark:from-lime-400/10' : 'from-sky-500/10 dark:from-sky-400/10'
  return (
    <section className="glass relative overflow-hidden rounded-[1.75rem] p-2.5">
      {/* accent wash */}
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent ${wash}`} />
      <div className="relative">
        <div className="mb-2 flex items-center gap-2 border-b border-black/5 px-2.5 py-2 dark:border-white/10">
          <Icon size={16} strokeWidth={2} className={`animate-soft-pulse ${accent}`} />
          <h2 className="text-sm font-bold tracking-tight text-slate-700 dark:text-slate-200">{label}</h2>
          <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${chip}`}>
            {count}
          </span>
        </div>
        <div className="px-0.5 pb-0.5">{children}</div>
      </div>
    </section>
  )
}

function EmptyState({ icon: Icon, title, copy }) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-500/5 ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10">
        <Icon size={26} className="animate-float text-slate-400 dark:text-slate-500" />
      </span>
      <p className="mt-4 text-sm font-semibold text-slate-600 dark:text-slate-300">{title}</p>
      <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">{copy}</p>
    </div>
  )
}
