import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Plus, Search, Check, Pencil, Trash2, CalendarArrowUp, Copy, Pin, PinOff,
  Bell, Sun, Moon, ListTodo, PartyPopper, Inbox, Coffee, CheckCircle2,
  LayoutGrid, Circle, Flame, Briefcase, User,
  GripVertical, ChevronDown, Download, Upload, X,
  FileText, ClipboardList, Share2, Clipboard, CheckCircle, Settings, Volume2,
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
function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    const raw = safe.get(key)
    if (raw == null) return typeof initial === 'function' ? initial() : initial
    try { return JSON.parse(raw) } catch { return initial }
  })
  useEffect(() => { safe.set(key, JSON.stringify(value)) }, [key, value])
  return [value, setValue]
}

function normalizeForToday(tasks) {
  const t = todayStr()
  return tasks
    .filter((x) => x.day === t || !x.done)
    .map((x, i) => ({
      subtasks: [],                       // default for tasks saved before subtasks existed
      order: x.order ?? x.createdAt ?? i, // default manual-sort order
      ...x,
      // Migrate legacy 'HH:MM' string reminders → object; keep future-dated ones as-is.
      reminder: migrateReminder(x.reminder),
      ...(x.day === t ? {} : { day: t }),  // roll unfinished tasks forward (reminder keeps its own date)
    }))
}

/**
 * Parse natural-language shortcuts out of the task text:
 *   time     "at 5pm", "5:30pm", "@17:00"      → reminder "HH:MM"
 *   category "#work" / "#personal" / "#urgent" → category
 *   priority "!high" / "!med" / "!low"         → priority
 * Returns the cleaned text plus any detected fields (undefined if not present).
 */
function parseQuickAdd(raw) {
  let text = ` ${raw} `
  let category, priority, reminder

  const catMap = { work: 'Work', personal: 'Personal', urgent: 'Urgent' }
  text = text.replace(/#(\w+)/g, (m, tag) => {
    const c = catMap[tag.toLowerCase()]
    if (c) { category = c; return ' ' }
    return m
  })

  text = text.replace(/!(high|medium|med|low)\b/i, (m, p) => {
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

  return { text: text.replace(/\s{2,}/g, ' ').trim(), category, priority, reminder }
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
  if (typeof r === 'string') return { date: todayStr(), time: r, lead: 0, repeat: 0, lastAlert: null }
  return { date: r.date || todayStr(), time: r.time, lead: r.lead || 0, repeat: r.repeat || 0, lastAlert: r.lastAlert ?? null }
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
/** Pick the alert sound for a priority level. */
const prioritySfx = (priority) => (priority === 'High' ? 'alarm' : priority === 'Medium' ? 'reminder' : 'soft')

// --- static config ---
const PRIORITIES = ['Low', 'Medium', 'High']
const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2 }
const CATEGORIES = ['Work', 'Personal', 'Urgent']
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
const PRIORITY_DOT = { Low: 'bg-slate-400', Medium: 'bg-amber-500', High: 'bg-rose-500' }
const CATEGORY_BADGE = {
  Work: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  Personal: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  Urgent: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
}
// Left-border colour per category (inline style — beats the card's border-color utility).
const CATEGORY_BORDER = { Work: '#0ea5e9', Personal: '#8b5cf6', Urgent: '#f43f5e' }

const FILTERS = ['All', 'Active', 'Completed', 'High Priority', 'Work', 'Personal']

const FILTER_ICON = {
  All: LayoutGrid, Active: Circle, Completed: CheckCircle2,
  'High Priority': Flame, Work: Briefcase, Personal: User,
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
  Work: ['bg-sky-600 text-white shadow-lg shadow-sky-600/30 ring-1 ring-inset ring-white/20',
        'bg-sky-500/10 text-sky-700 ring-1 ring-inset ring-sky-500/15 hover:bg-sky-500/15 dark:text-sky-300'],
  Personal: ['bg-violet-600 text-white shadow-lg shadow-violet-600/30 ring-1 ring-inset ring-white/20',
        'bg-violet-500/10 text-violet-700 ring-1 ring-inset ring-violet-500/15 hover:bg-violet-500/15 dark:text-violet-300'],
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
  const [tasks, setTasks] = useLocalStorage('todo.tasks', [])
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [celebrate, setCelebrate] = useState(false)
  const [undo, setUndo] = useState(null)  // last deleted task, for the undo toast
  const [notice, setNotice] = useState(null)  // transient status message toast
  const prevAllDone = useRef(false)
  const fileRef = useRef(null)  // hidden import file input
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

  // One-time normalization for the new day.
  useEffect(() => { setTasks((prev) => normalizeForToday(prev)) }, [setTasks])

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
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  useEffect(() => {
    const check = () => {
      setNowTick(Date.now())  // keep the due-banner fresh even when muted
      if (mutedRef.current) return
      const now = Date.now()
      const due = tasksRef.current.filter((x) =>
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
      ;[...toAlert]
        .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority])
        .forEach((x) => {
          if (canNotify) new Notification(`${x.priority === 'High' ? '🔴 ' : ''}Reminder · ${x.priority} priority`, {
            body: `${x.text}${overdueMins(x.reminder, now) ? ` (overdue ${overdueMins(x.reminder, now)}m)` : ''}`,
            requireInteraction: x.priority === 'High',
          })
        })
      // One sound per tick, matched to the highest priority alerting now.
      const topRank = Math.max(...toAlert.map((x) => PRIORITY_RANK[x.priority]))
      const level = topRank === 2 ? 'High' : topRank === 1 ? 'Medium' : 'Low'
      playSfx(level === 'High' && !hpAlarmOn ? 'reminder' : prioritySfx(level))

      const ids = new Set(toAlert.map((x) => x.id))
      setTasks((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, reminder: { ...x.reminder, lastAlert: now } } : x)))
    }
    check()
    const id = setInterval(check, 20000)
    return () => clearInterval(id)
  }, [setTasks])

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
        if (filter === 'Work' && x.category !== 'Work') return false
        if (filter === 'Personal' && x.category !== 'Personal') return false
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
  // Next upcoming reminder (across all pending tasks, any date) for the header chip.
  const nextReminder = useMemo(() => {
    const up = tasks
      .filter((x) => !x.done && x.reminder && reminderEventTime(x.reminder).getTime() >= Date.now())
      .sort((a, b) => reminderEventTime(a.reminder) - reminderEventTime(b.reminder))[0]
    return up ? reminderLabel(up.reminder) : null
  }, [tasks, nowTick])
  // Reminders currently due (past trigger, not done, not snoozed) — powers the
  // always-visible banner, ordered by priority then event time.
  const dueReminders = useMemo(() =>
    tasks
      .filter((x) => !x.done && x.reminder && reminderTrigger(x.reminder).getTime() <= nowTick && !isSuppressed(x.reminder, nowTick))
      .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        reminderEventTime(a.reminder) - reminderEventTime(b.reminder)),
    [tasks, nowTick])
  // Reminders scheduled but not yet firing (future trigger, or snoozed) — the
  // "Upcoming reminders" table, ordered by when they'll next surface.
  const upcoming = useMemo(() =>
    tasks
      .filter((x) => !x.done && x.reminder && x.reminder.snoozeUntil !== DISMISSED &&
        (reminderTrigger(x.reminder).getTime() > nowTick || isSuppressed(x.reminder, nowTick)))
      .sort((a, b) => nextReminderAt(a.reminder, nowTick) - nextReminderAt(b.reminder, nowTick)),
    [tasks, nowTick])

  // --- mutations (memoized; used across many cards) ---
  const patch = useCallback((id, fn) =>
    setTasks((prev) => prev.map((x) => (x.id === id ? fn(x) : x))), [setTasks])
  const toggle = useCallback((id) => patch(id, (x) => {
    playSfx(x.done ? 'toggleOff' : 'complete')  // different sound for check vs un-check
    return { ...x, done: !x.done }
  }), [patch])
  // Delete keeps the removed task around briefly so it can be undone from the toast.
  const remove = useCallback((id) => {
    playSfx('delete')
    setTasks((prev) => {
      const victim = prev.find((x) => x.id === id)
      if (victim) setUndo(victim)
      return prev.filter((x) => x.id !== id)
    })
  }, [setTasks])
  const undoDelete = useCallback(() => {
    setUndo((v) => { if (v) setTasks((prev) => [...prev, v]); return null })
  }, [setTasks])
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
  // Set/replace/clear a task's reminder (re-arms alerts).
  const editReminder = useCallback((id, reminder) => patch(id, (x) =>
    ({ ...x, reminder: reminder ? { ...reminder, lastAlert: null, snoozeUntil: null } : null })), [patch])
  const viewTask = useCallback((id) => {
    setView('tasks'); setHighlightId(id)
    setTimeout(() => document.getElementById(`task-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
    setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2400)
  }, [])
  const postpone = useCallback((id) => {
    const d = new Date(); d.setDate(d.getDate() + 1)
    patch(id, (x) => ({
      ...x, day: dateStr(d), done: false,
      // Shift a same-day reminder to tomorrow too, and re-arm it.
      reminder: x.reminder ? { ...x.reminder, date: dateStr(d), lastAlert: null } : null,
    }))
  }, [patch])
  const duplicate = useCallback((id) => setTasks((prev) => {
    const src = prev.find((x) => x.id === id)
    if (!src) return prev
    return [...prev, { ...src, id: crypto.randomUUID(), done: false, pinned: false, order: Date.now(), createdAt: Date.now(),
      reminder: src.reminder ? { ...src.reminder, lastAlert: null } : null }]
  }), [setTasks])

  const addTask = useCallback((data) => {
    playSfx('add')
    setTasks((prev) => [...prev, {
      id: crypto.randomUUID(),
      text: data.text, priority: data.priority, category: data.category,
      reminder: data.reminder || null,
      done: false, pinned: false, day: todayStr(), createdAt: Date.now(),
      order: Date.now(), subtasks: [],
    }])
  }, [setTasks])

  // --- subtasks ---
  const addSubtask = useCallback((id, text) => {
    const v = text.trim()
    if (!v) return
    patch(id, (x) => ({ ...x, subtasks: [...(x.subtasks || []), { id: crypto.randomUUID(), text: v, done: false }] }))
  }, [patch])
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
    Subtasks: (t.subtasks || []).map((s) => `${s.done ? '[x]' : '[ ]'} ${s.text}`).join('; '),
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
    const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
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
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result)
        if (!Array.isArray(data)) throw new Error('not an array')
        setTasks(normalizeForToday(data))
        setNotice({ text: `Imported ${data.length} task${data.length === 1 ? '' : 's'}.` })
      } catch {
        setNotice({ text: 'Import failed: not a valid backup file.' })
      }
    }
    reader.readAsText(file)
  }, [setTasks])

  // Bell click: request permission if needed, otherwise mute/unmute in-app.
  const requestNotify = useCallback(async () => {
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
  }, [setMuted])

  return (
    <div className="min-h-screen text-slate-900 dark:text-slate-100 transition-colors">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:py-16">

        {/* Brand */}
        <div className="animate-fade-in mb-8 flex items-center gap-3">
          <AutoDeckIcon size={46} background={false} />
          <div className="leading-none">
            <div className="text-xl font-bold tracking-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
              <span className="text-slate-900 dark:text-white">Auto</span><span className="text-teal-500">Deck</span>
            </div>
            <div className="mt-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Your workflow, on autopilot.
            </div>
          </div>
        </div>

        {/* Header */}
        <header className="mb-8 flex items-start justify-between">
          <div className="animate-fade-in">
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
          <div className="glass flex items-center gap-0.5 rounded-full p-1 shadow-sm">
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
            notify={notify} muted={muted} onRequestNotify={requestNotify} />
        )}

        {/* Always-visible reminder banner — sticks to the top until every due task
            is marked done. Ordered by priority, styled by the top priority present. */}
        {dueReminders.length > 0 && (
          <ReminderBanner items={dueReminders} nowTick={nowTick}
            onDone={toggle} onSnooze={snoozeReminder} onDismiss={dismissReminder} onView={viewTask}
            notify={notify} muted={muted} />
        )}

        {/* View tabs: Tasks board vs Daily Report */}
        <div className="glass mb-6 inline-flex gap-0.5 rounded-full p-1 shadow-sm">
          {[['tasks', 'Tasks', ListTodo], ['report', 'Daily Report', ClipboardList]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setView(id)}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-300 active:scale-[0.97] ${
                view === id ? 'bg-teal-500 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
              }`}>
              <Icon size={13} strokeWidth={2.2} /> {label}
            </button>
          ))}
        </div>

        {view === 'report' ? (
          <DailyReport tasks={tasks} onAddGoal={addTask} onToggleGoal={toggle} />
        ) : (
        <>
        <ProgressDashboard pct={pct} done={doneCount} total={total} celebrate={celebrate} />

        <AddTaskForm onAdd={addTask} onFirstReminder={requestNotify} notifyOn={notify && !muted} remDefaults={remDefaults} />

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

        {/* Filter tabs */}
        <div className="mb-5 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const Icon = FILTER_ICON[f]
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] [&_svg]:transition-transform hover:[&_svg]:scale-110 ${
                  FILTER_STYLE[f][filter === f ? 0 : 1]
                }`}
              >
                <Icon size={13} strokeWidth={2.2} />
                {f}
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
                        highlight={highlightId === task.id} nowTick={nowTick}
                        onToggle={toggle} onEdit={setEditingId} onRename={rename}
                        onDelete={remove} onPostpone={postpone} onDuplicate={duplicate} onPin={togglePin}
                        onEditReminder={editReminder}
                        onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask} onRemoveSubtask={removeSubtask} />
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
                    highlight={highlightId === task.id} nowTick={nowTick}
                    onToggle={toggle} onEdit={setEditingId} onRename={rename}
                    onDelete={remove} onPostpone={postpone} onDuplicate={duplicate} onPin={togglePin}
                    onEditReminder={editReminder}
                    onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask} onRemoveSubtask={removeSubtask} />
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
          <input type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)}
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
    onChange(on && time ? { date: date || todayStr(), time, lead: +lead || 0, repeat: +repeat || 0 } : null)
    // onChange is a stable setter; re-emitting only when inputs change is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, date, time, lead, repeat])

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300"
        title="Alert (in-app banner + sound, plus desktop when allowed) on a date/time">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="accent-sky-600" /> Remind me
      </label>
      {on && (
        <>
          <input type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value)} aria-label="Reminder date" className={REM_CLS} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Reminder time" className={REM_CLS} />
          <select aria-label="Lead time" title="Alert this long before the time" className={REM_CLS}
            value={leadCustom ? 'custom' : lead}
            onChange={(e) => { if (e.target.value === 'custom') setLeadCustom(true); else { setLeadCustom(false); setLead(+e.target.value) } }}>
            {LEAD_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
            <option value="custom">Custom…</option>
          </select>
          {leadCustom && <input type="number" min="1" value={lead} onChange={(e) => setLead(e.target.value)} aria-label="Custom minutes before" title="Minutes before" className={`${REM_CLS} w-24`} placeholder="min" />}
          <select aria-label="Repeat interval" title="Repeat until the task is done" className={REM_CLS}
            value={repeatCustom ? 'custom' : repeat}
            onChange={(e) => { if (e.target.value === 'custom') setRepeatCustom(true); else { setRepeatCustom(false); setRepeat(+e.target.value) } }}>
            {REPEAT_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
            <option value="custom">Custom…</option>
          </select>
          {repeatCustom && <input type="number" min="1" value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Custom repeat minutes" title="Repeat every N minutes" className={`${REM_CLS} w-24`} placeholder="min" />}
        </>
      )}
    </div>
  )
}

/* --------------------------------- Add form -------------------------------- */
function AddTaskForm({ onAdd, onFirstReminder, notifyOn, remDefaults }) {
  const [text, setText] = useState('')
  const [priority, setPriority] = useState('Medium')
  const [category, setCategory] = useState('Work')
  const [rem, setRem] = useState(null)     // reminder object from ReminderEditor
  const [remKey, setRemKey] = useState(0)  // bump to remount/reset the editor after add

  // Live parse of what's typed, so we can preview and use natural-language shortcuts.
  const parsed = text.trim() ? parseQuickAdd(text) : null
  const detected = parsed && (parsed.category || parsed.priority || parsed.reminder)

  const submit = (e) => {
    e.preventDefault()
    const p = parseQuickAdd(text)
    if (!p.text) return
    // Manual editor wins; otherwise fall back to a natural-language time (today, once).
    const reminder = rem
      ? { ...rem, lastAlert: null, snoozeUntil: null }
      : (p.reminder ? { date: todayStr(), time: p.reminder, lead: 0, repeat: 0, lastAlert: null, snoozeUntil: null } : null)
    onAdd({
      text: p.text,
      priority: p.priority || priority,
      category: p.category || category,
      reminder,
    })
    setText(''); setRem(null); setRemKey((k) => k + 1)
    if (reminder) onFirstReminder()  // ask for desktop-notification permission (optional bonus)
  }

  const selectCls = REM_CLS

  return (
    <form onSubmit={submit}
      className="glass mb-5 rounded-[1.75rem] p-5">
      <div className="flex items-center gap-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Try: Email Sam at 5pm #work !high"
          aria-label="New task"
          autoFocus
          className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-base outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950/50"
        />
        <button type="submit"
          className="group flex shrink-0 items-center gap-2 rounded-full bg-sky-600 py-2 pl-5 pr-2 text-sm font-semibold text-white transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-sky-500 active:scale-[0.98]">
          Add
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105">
            <Plus size={15} strokeWidth={2} />
          </span>
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority" title="Priority" className={selectCls}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p} priority</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" title="Category" className={selectCls}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <ReminderEditor key={`${remKey}-${remDefaults.lead}-${remDefaults.repeat}`} initial={null} onChange={setRem} defaults={remDefaults} />
        {rem && !notifyOn && (
          <span className="text-xs text-slate-400">Alerts in-app. Enable notifications for desktop alerts too.</span>
        )}
      </div>

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
              <Bell size={11} />{fmtTime(parsed.reminder)}
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
  const dragStyle = { transform: CSS.Transform.toString(transform), transition }
  return <TaskCard {...props} dragRef={setNodeRef} dragStyle={dragStyle} isDragging={isDragging}
    handleProps={{ ...attributes, ...listeners }} />
}

function TaskCard({ task, index = 0, editing, highlight, nowTick = Date.now(), onToggle, onEdit, onRename, onDelete, onPostpone, onDuplicate, onPin,
  onEditReminder, onAddSubtask, onToggleSubtask, onRemoveSubtask, dragRef, dragStyle, handleProps, isDragging }) {
  const [draft, setDraft] = useState(task.text)
  const [expanded, setExpanded] = useState(false)
  const [subDraft, setSubDraft] = useState('')
  const [remOpen, setRemOpen] = useState(false)
  const [remDraft, setRemDraft] = useState(task.reminder || null)
  useEffect(() => { if (editing) setDraft(task.text) }, [editing, task.text])

  const subs = task.subtasks || []
  const doneSubs = subs.filter((s) => s.done).length
  const overdue = task.reminder && !task.done && overdueMins(task.reminder, nowTick) > 0

  const addSub = (e) => { e.preventDefault(); onAddSubtask(task.id, subDraft); setSubDraft('') }
  const saveReminder = () => { onEditReminder(task.id, remDraft); setRemOpen(false) }

  return (
    <li
      ref={dragRef}
      id={`task-${task.id}`}
      aria-label={`${task.text}. ${task.priority} priority, ${task.category}.${task.reminder ? ` Reminder ${reminderLabel(task.reminder)}.` : ''}${overdue ? ' Overdue.' : ''}${subs.length ? ` ${doneSubs} of ${subs.length} subtasks done.` : ''}${task.done ? ' Done.' : ''}`}
      style={{ ...dragStyle, animationDelay: `${Math.min(index, 8) * 40}ms`, borderLeftColor: CATEGORY_BORDER[task.category] }}
      className={`glass-sm group animate-fade-up rounded-2xl border-l-[3px] px-3 py-2.5 transition-shadow ${
      highlight ? 'ring-2 ring-sky-500/70 soft-pulse' : task.pinned ? 'ring-1 ring-sky-400/40' : ''} ${isDragging ? 'z-10 opacity-60 shadow-soft' : ''}`}>
      <div className="flex items-center gap-2">
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

        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`} title={`${task.priority} priority`} />

        {/* text / inline edit */}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onRename(task.id, draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename(task.id, draft)
              if (e.key === 'Escape') onEdit(null)
            }}
            className="flex-1 rounded-md border border-sky-500 bg-transparent px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => onEdit(task.id)}
            className={`min-w-0 flex-1 truncate text-sm ${task.done ? 'text-slate-400' : ''}`}
          >
            <span className={task.done ? 'strike' : ''}>{task.text}</span>
          </span>
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
        <div className="ml-auto flex shrink-0 items-center gap-0.5 transition group-hover:opacity-100 focus-within:opacity-100 md:opacity-0">
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
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold sm:text-[11px] ${CATEGORY_BADGE[task.category]}`}>{task.category}</span>
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
            <div key={s.id} className="group/sub flex items-center gap-2 text-sm">
              <button onClick={() => onToggleSubtask(task.id, s.id)}
                aria-label={s.done ? 'Mark subtask incomplete' : 'Mark subtask complete'}
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                  s.done ? 'border-transparent bg-lime-500 text-white' : 'border-slate-300 hover:border-sky-500 dark:border-slate-600'}`}>
                {s.done && <Check size={11} strokeWidth={3} />}
              </button>
              <span className={`flex-1 truncate ${s.done ? 'text-slate-400' : ''}`}>
                <span className={s.done ? 'strike' : ''}>{s.text}</span>
              </span>
              <button onClick={() => onRemoveSubtask(task.id, s.id)} aria-label="Delete subtask"
                className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition hover:text-rose-500 group-hover/sub:opacity-100">
                <X size={13} />
              </button>
            </div>
          ))}
          <form onSubmit={addSub} className="flex items-center gap-2">
            <Plus size={13} className="shrink-0 text-slate-400" />
            <input value={subDraft} onChange={(e) => setSubDraft(e.target.value)}
              placeholder="Add a subtask…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400" />
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
}

/* ----------------------------- Reminder banner ----------------------------- */
// Per-priority banner styling — High is the most urgent, Low the calmest.
const PRI_STYLE = {
  High:   { wrap: 'border-rose-500/40 bg-rose-500/10 dark:bg-rose-500/[0.12]', text: 'text-rose-700 dark:text-rose-300', icon: 'text-rose-500', accent: '#f43f5e' },
  Medium: { wrap: 'border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/[0.12]', text: 'text-amber-700 dark:text-amber-300', icon: 'text-amber-500', accent: '#f59e0b' },
  Low:    { wrap: 'border-slate-400/40 bg-slate-500/10 dark:bg-slate-500/[0.12]', text: 'text-slate-700 dark:text-slate-300', icon: 'text-slate-500', accent: '#94a3b8' },
}

function ReminderBanner({ items, nowTick, onDone, onSnooze, onDismiss, onView, notify, muted }) {
  const top = items[0].priority             // items are sorted priority-desc
  const s = PRI_STYLE[top]
  return (
    <div className={`animate-fade-up sticky top-3 z-30 mb-6 rounded-2xl border p-3 shadow-soft backdrop-blur-md ${s.wrap}`}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <Bell size={16} strokeWidth={2.4} className={`animate-bell ${s.icon}`} />
        <span className={`text-sm font-bold ${s.text}`}>
          {items.length} reminder{items.length === 1 ? '' : 's'} due
        </span>
        {(!notify || muted) && (
          <span className="ml-auto text-[11px] font-medium opacity-80">
            {muted ? 'Sound muted' : 'Enable notifications for desktop alerts'}
          </span>
        )}
      </div>
      <ul className="space-y-1.5">
        {items.map((task) => {
          const od = overdueMins(task.reminder, nowTick)
          const ps = PRI_STYLE[task.priority]
          return (
            <li key={task.id} style={{ borderLeftColor: ps.accent }}
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border-l-[3px] bg-white/60 px-3 py-2 dark:bg-slate-900/40">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">{task.text}</span>
              {od > 0 && <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-600 dark:text-rose-300">OVERDUE {fmtDur(od)}</span>}
              <span className="hidden shrink-0 items-center gap-1 text-[11px] font-semibold text-slate-500 sm:flex dark:text-slate-400">
                <Bell size={10} /> {reminderLabel(task.reminder)}
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${PRIORITY_BADGE[task.priority]}`}>{task.priority}</span>
              <div className="flex shrink-0 items-center gap-1">
                <button onClick={() => onDone(task.id)} title="Mark completed"
                  className="rounded-full bg-lime-500 px-3 py-1 text-xs font-semibold text-white transition hover:bg-lime-600 active:scale-95">Done</button>
                <select aria-label="Snooze" title="Snooze" defaultValue=""
                  onChange={(e) => { if (e.target.value) { onSnooze(task.id, +e.target.value); e.target.value = '' } }}
                  className="rounded-full bg-slate-500/10 px-2 py-1 text-xs font-semibold text-slate-600 outline-none dark:text-slate-300">
                  <option value="" disabled>Snooze</option>
                  {SNOOZE_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button onClick={() => onView(task.id)} title="View task"
                  className="rounded-full p-1.5 text-slate-500 transition hover:bg-black/5 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10"><Search size={13} /></button>
                <button onClick={() => onDismiss(task.id)} title={task.reminder.repeat ? 'Dismiss (returns next interval)' : 'Dismiss'}
                  className="rounded-full p-1.5 text-slate-400 transition hover:bg-black/5 hover:text-rose-500 dark:hover:bg-white/10"><X size={14} /></button>
              </div>
            </li>
          )
        })}
      </ul>
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
                      <button onClick={() => onView(task.id)} className="max-w-[160px] truncate text-left font-medium text-slate-700 hover:text-sky-600 dark:text-slate-200">{task.text}</button>
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

function SettingsPanel({ onClose, soundOn, setSoundOn, volume, setVolume, hpAlarm, setHpAlarm, remDefaults, setRemDefaults, notify, muted, onRequestNotify }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const sel = 'rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm outline-none focus:border-teal-500 dark:border-slate-800 dark:bg-slate-950/50'
  const notifState = notify ? (muted ? 'Muted' : 'On') : 'Off'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-label="Settings"
        className="glass animate-fade-up relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[1.5rem] p-6 shadow-soft">
        <div className="mb-4 flex items-center gap-2">
          <Settings size={18} className="text-teal-500" />
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">Reminder & notification settings</h2>
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
                <select className={sel} value={remDefaults.lead}
                  onChange={(e) => setRemDefaults({ ...remDefaults, lead: +e.target.value })}>
                  {LEAD_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                Repeat
                <select className={sel} value={remDefaults.repeat}
                  onChange={(e) => setRemDefaults({ ...remDefaults, repeat: +e.target.value })}>
                  {REPEAT_OPTIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-400">Pre-fills the reminder fields when you add a task.</p>
          </div>

          <p className="border-t border-black/5 pt-4 text-xs text-slate-400 dark:border-white/10">
            Manage active reminders in the <span className="font-semibold text-slate-500 dark:text-slate-300">Upcoming reminders</span> panel on the Tasks tab — view, cancel, or edit each one there.
          </p>
        </div>
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
