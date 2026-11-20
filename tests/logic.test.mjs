// Automated checks of AutoDeck's logic (run with `npm test`). Dates are always built relative to "today", so the checks
// give the same answer on any day and in any time zone.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQuickAdd, nextOccurrence, normalizeForToday, sanitizeImported, migrateReminder, reminderItems, patchItems,
  nextAlertAt, reminderTrigger, revivedTask,
} from '../.test-build/TodoApp.mjs'
import { alertTimes } from '../.test-build/androidReminders.mjs'

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const day = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return ymd(d) }
const hm = (min) => { const d = new Date(Date.now() + min * 60000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const rem = (o = {}) => ({ date: day(0), time: '10:00', lead: 0, repeat: 0, lastAlert: null, snoozeUntil: null, ...o })
const task = (o = {}) => ({ id: crypto.randomUUID(), text: 'T', priority: 'Medium', category: 'Work', reminder: null, recur: null, done: false, pinned: false,
  day: day(0), createdAt: 1, order: 1, subtasks: [], ...o })
const CATS = [{ name: 'Work', color: '#000' }, { name: 'Personal', color: '#000' }, { name: 'Urgent', color: '#000' }]

test('quick add: times, tags, priorities', () => {
  const p = (s) => parseQuickAdd(s, CATS)
  assert.deepEqual(p('Email Sam at 5pm #work !high'), { text: 'Email Sam', category: 'Work', priority: 'High', reminder: '17:00', tomorrow: false })
  assert.equal(p('Call mom @17:30 #personal !low').reminder, '17:30')
  assert.equal(p('Lunch at 12pm').reminder, '12:00')
  assert.equal(p('Midnight at 12am').reminder, '00:00')
  assert.equal(p('Meeting at 25:99').reminder, undefined)
  assert.equal(p('pay 20 dollars').text, 'pay 20 dollars')
  assert.equal(p('Hello at 5:30 pm #URGENT !HIGH').category, 'Urgent')
  assert.equal(p('Fix #nonexistent thing').text, 'Fix #nonexistent thing')
})

test('quick add: "tomorrow" and tags only at the start of a word', () => {
  const p = (s) => parseQuickAdd(s, CATS)
  const t = p('Pick up at 5pm tomorrow')
  assert.equal(t.tomorrow, true); assert.equal(t.text, 'Pick up'); assert.equal(t.reminder, '17:00')
  assert.equal(p('see it tomorrow').tomorrow, false)  // no time, so nothing to move
  assert.equal(p('wow!high thing').priority, undefined)
  assert.equal(p('link http://x.com/#work page').category, undefined)
  assert.equal(p('#work first !high').category, 'Work')
})

test('repeat rules find the next matching day', () => {
  const sat = new Date(2026, 10, 21)  // a Saturday
  assert.equal(nextOccurrence('daily', sat, 1), '2026-11-21')
  assert.equal(nextOccurrence('weekdays', sat, 1), '2026-11-23')  // Monday
  assert.equal(nextOccurrence('weekly', sat, 3), '2026-11-25')    // the next Wednesday
})

test('legacy reminders are upgraded, unusable ones dropped', () => {
  assert.equal(migrateReminder(null), null)
  assert.equal(migrateReminder('17:00').time, '17:00')
  assert.equal(migrateReminder('99:99'), null)
  assert.equal(migrateReminder({ date: day(0) }), null)
  assert.equal(migrateReminder(rem({ snoozeUntil: 123 })).snoozeUntil, 123)  // a snooze survives a restart
})

test('day rollover: old finished tasks leave, unfinished roll to today, repeating ones start over', () => {
  const out = normalizeForToday([
    task({ text: 'old done', done: true, day: day(-3) }),
    task({ text: 'old open', day: day(-3) }),
    task({ text: 'daily', recur: 'daily', done: true, day: day(-1), reminder: rem({ date: day(-1), lastAlert: 5, snoozeUntil: 9 }) }),
    task({ text: 'future', day: day(3) }),
  ])
  const by = (t) => out.find((x) => x.text === t)
  assert.equal(by('old done'), undefined)
  assert.equal(by('old open').day, day(0))
  assert.equal(by('daily').done, false); assert.equal(by('daily').day, day(0))
  assert.equal(by('daily').reminder.date, day(0)); assert.equal(by('daily').reminder.lastAlert, null)
  assert.equal(by('future').day, day(3))
})

test('day rollover: repeating subtasks start over', () => {
  const [t] = normalizeForToday([task({ day: day(-2), subtasks: [
    { id: 'a', text: 'daily step', done: true, recur: 'daily', day: day(-1), reminder: rem({ date: day(-1), lastAlert: 5 }) },
    { id: 'b', text: 'plain done', done: true },
  ] })])
  const a = t.subtasks[0]
  assert.equal(a.done, false); assert.equal(a.day, day(0)); assert.equal(a.reminder.date, day(0)); assert.equal(a.reminder.lastAlert, null)
  assert.equal(t.subtasks[1].done, true)
})

test('imports are cleaned: bad values fixed, junk removed, subtask options kept', () => {
  const [t] = sanitizeImported([
    { id: 't', text: 'x'.repeat(5000), priority: 'Zzz', reminder: { time: '99:99' }, subtasks: [
      { id: 's1', text: 'ok', priority: 'High', category: 'Work', recur: 'daily', day: '2026-01-01', reminder: { date: '2026-01-01', time: '09:30', lead: -50, repeat: 'x' } },
      { id: 's2', text: 'bad', priority: 'Nope', recur: 'yearly', day: 'nope', reminder: { time: '99:99' } },
      5, null, { text: 'no id' },
    ] },
    null, 5, { nope: 1 },
  ])
  assert.equal(t.text.length, 2000); assert.equal(t.priority, 'Medium'); assert.equal(t.reminder.time, '09:00')
  assert.equal(t.subtasks.length, 3)
  const [s1, s2, s3] = t.subtasks
  assert.deepEqual([s1.priority, s1.category, s1.recur, s1.reminder.time, s1.reminder.lead, s1.reminder.repeat], ['High', 'Work', 'daily', '09:30', 0, 0])
  assert.equal(s2.priority, undefined); assert.equal(s2.recur, undefined); assert.equal(s2.day, undefined); assert.equal(s2.reminder.time, '09:00')
  assert.ok(s3.id)
})

test('subtask reminders become reminder items of their own', () => {
  const t = task({ text: 'Close month', priority: 'Low', subtasks: [
    { id: 's1', text: 'Send invoice', done: false, priority: 'High', reminder: rem() }, { id: 's2', text: 'plain', done: false } ] })
  const items = reminderItems([t])
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 's1'); assert.equal(items[0].text, 'Send invoice (in Close month)'); assert.equal(items[0].priority, 'High')
  assert.equal(reminderItems([{ ...t, done: true }])[0].done, true)  // a finished task silences its steps
})

test('patching an item changes the step, not the task', () => {
  const t = task({ subtasks: [{ id: 's1', text: 'step', done: false, reminder: rem() }] })
  const [done] = patchItems([t], new Set(['s1']), (x) => ({ ...x, done: true }))
  assert.equal(done.subtasks[0].done, true); assert.equal(done.done, false)
  const [snoozed] = patchItems([t], new Set(['s1']), (x) => ({ ...x, reminder: { ...x.reminder, snoozeUntil: 99 } }))
  assert.equal(snoozed.subtasks[0].reminder.snoozeUntil, 99)
  const [same] = patchItems([t], new Set(['nobody']), (x) => ({ ...x, done: true }))
  assert.equal(same.subtasks[0].done, false)
})

test('the next alert moment: its time, a snooze ending, a repeat; never a dismissed or finished one', () => {
  const now = Date.now()
  const future = rem({ time: hm(30) })
  assert.equal(nextAlertAt([task({ reminder: future })], now), reminderTrigger(future).getTime())
  assert.equal(nextAlertAt([task({ reminder: rem({ time: hm(-10), snoozeUntil: now + 60000 }) })], now), now + 60000)
  assert.equal(nextAlertAt([task({ reminder: rem({ time: hm(-10), repeat: 5, lastAlert: now - 60000 }) })], now), now - 60000 + 5 * 60000)
  assert.equal(nextAlertAt([task({ reminder: rem({ time: hm(-10), snoozeUntil: 8640000000000000 }) })], now), null)
  assert.equal(nextAlertAt([task({ done: true, reminder: future })], now), null)
  assert.equal(nextAlertAt([task({ reminder: rem({ time: hm(-10), lastAlert: now - 1000 }) })], now), null)  // due and already alerted
  const soon = rem({ time: hm(5) }), later = rem({ time: hm(50) })
  assert.equal(nextAlertAt([task({ reminder: later }), task({ reminder: soon })], now), reminderTrigger(soon).getTime())
})

test('a restored task keeps a future reminder, drops a passed one, keeps a repeating one', () => {
  const a = { ...task({ reminder: rem({ time: hm(60), lastAlert: 7 }) }), archivedAt: 1, reason: 'deleted' }
  assert.equal(revivedTask(a, 5).reminder.lastAlert, null)
  assert.equal(revivedTask({ ...a, reminder: rem({ time: hm(-30) }) }, 5).reminder, null)
  assert.equal(revivedTask({ ...a, recur: 'daily', reminder: rem({ time: hm(-30) }) }, 5).reminder.date, day(0))
  const r = revivedTask({ ...a, done: true, subtasks: [{ id: 's', text: 'x', done: true, reminder: rem({ time: hm(-30) }) }] }, 5)
  assert.equal(r.done, false); assert.equal(r.subtasks[0].reminder, undefined); assert.equal('archivedAt' in r, false)
})

test('Android alarms: one-off, repeating, finished, snoozed', () => {
  const now = Date.now()
  const at = (t) => alertTimes(t, now)
  assert.equal(at(task({ reminder: rem({ time: hm(30) }) })).length, 1)
  assert.equal(at(task({ done: true, reminder: rem({ time: hm(30) }) })).length, 0)
  assert.ok(at(task({ reminder: rem({ time: hm(30), repeat: 10 }) })).length > 1)
  assert.deepEqual(at(task({ reminder: rem({ time: hm(-30), snoozeUntil: now + 120000 }) })), [now + 120000])
  assert.equal(at(task({ reminder: rem({ time: hm(-30), snoozeUntil: 8640000000000000 }) })).length, 0)
  const daily = at(task({ recur: 'daily', done: true, reminder: rem({ time: '10:00' }) }))
  assert.ok(daily.length >= 5 && daily.every((t) => t > now), 'a finished repeating task still rings on the coming days')
})
