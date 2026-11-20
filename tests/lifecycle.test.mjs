// Completion lifecycle: only the user checks or unchecks a task; moving, duplicating, restoring, importing and merging windows
// never change a completed task's status.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  markDone, markUndone, rescheduleTask, pendingCopy, completionDay, revivedTask, sanitizeImported, normalizeForToday, stampChanged,
  tombstones, mergeTasks, mergeArchive, reminderItems, patchItems, withFreshAlarms,
} from '../.test-build/TodoApp.mjs'
import { alertTimes } from '../.test-build/androidReminders.mjs'

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const day = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return ymd(d) }
// hm(min) is the clock time `min` minutes from now; it remembers that moment's date, so rem({ time: hm(60) }) is right even when
// the hour crosses midnight (a test run at 23:30 must not turn "in an hour" into "already passed").
let lastHm = { time: null, date: null }
const hm = (min) => { const d = new Date(Date.now() + min * 60000); const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; lastHm = { time, date: ymd(d) }; return time }
const rem = (o = {}) => ({ date: o.time && o.time === lastHm.time ? lastHm.date : day(0), time: '10:00', lead: 0, repeat: 0, lastAlert: null, snoozeUntil: null, ...o })
const task = (o = {}) => ({ id: crypto.randomUUID(), text: 'T', priority: 'Medium', category: 'Work', reminder: null, recur: null, done: false, pinned: false,
  day: day(0), createdAt: 1, order: 1, subtasks: [], ...o })

test('checking a task records when; unchecking removes it', () => {
  const t = task(); const d = markDone(t, 123)
  assert.equal(d.done, true); assert.equal(d.completedAt, 123); assert.equal(t.done, false)
  const u = markUndone(d); assert.equal(u.done, false); assert.equal('completedAt' in u, false)
})
test('unchecking a task completed today leaves it where it is, with its reminder', () => {
  const u = markUndone(markDone(task({ reminder: rem({ time: hm(60) }) })))
  assert.equal(u.day, day(0)); assert.equal(u.reminder.time, hm(60))
})
test('unchecking an older completed task brings it back to Pending for today; a passed reminder is dropped', () => {
  const old = markDone(task({ day: day(-5), reminder: rem({ date: day(-5), time: '09:00' }), subtasks: [{ id: 's', text: 'x', done: true, reminder: rem({ date: day(-5) }) }] }), 1)
  const u = markUndone(old)
  assert.equal(u.done, false); assert.equal(u.day, day(0)); assert.equal(u.reminder, null); assert.equal(u.subtasks[0].reminder, undefined)
  const rep = markUndone(markDone(task({ day: day(-5), recur: 'daily', reminder: rem({ date: day(-5), lastAlert: 9 }) }), 1))
  assert.equal(rep.reminder.date, day(0)); assert.equal(rep.reminder.lastAlert, null)
})
test('which day a completed task counts for: the day it was checked, else its own day', () => {
  assert.equal(completionDay(task({ day: '2026-01-05', completedAt: new Date(2026, 0, 9, 12).getTime() })), '2026-01-09')
  assert.equal(completionDay(task({ day: '2026-01-05' })), '2026-01-05')
})

test('moving a completed task to another day keeps it completed (and its history)', () => {
  const t = markDone(task({ reminder: rem({ lastAlert: 5 }) }), new Date(2026, 5, 1, 12).getTime())
  const m = rescheduleTask(t, day(3))
  assert.equal(m.done, true); assert.equal(m.day, day(3)); assert.equal(m.completedAt, t.completedAt); assert.deepEqual(m.reminder, t.reminder)
  const legacy = rescheduleTask(task({ done: true, day: '2026-06-01' }), day(3))  // an old save without completedAt
  assert.equal(completionDay(legacy), '2026-06-01')
})
test('moving an open task takes its reminder and its steps\' reminders along', () => {
  const m = rescheduleTask(task({ reminder: rem({ lastAlert: 5 }), subtasks: [{ id: 's', text: 'x', done: false, reminder: rem({ lastAlert: 5 }) }] }), day(2))
  assert.equal(m.done, false); assert.equal(m.reminder.date, day(2)); assert.equal(m.reminder.lastAlert, null); assert.equal(m.subtasks[0].reminder.date, day(2))
})

test('duplicating a completed task gives an independent pending copy for today; the original is untouched', () => {
  const orig = markDone(task({ day: day(-3), recur: 'daily', pinned: true, series: 'abc', spawned: true, reminder: rem({ date: day(-3), snoozeUntil: 8640000000000000 }),
    subtasks: [{ id: 's1', text: 'a', done: true }] }), 5)
  const snapshot = JSON.stringify(orig)
  const c = pendingCopy(orig)
  assert.equal(JSON.stringify(orig), snapshot)
  assert.notEqual(c.id, orig.id); assert.equal(c.done, false); assert.equal(c.pinned, false); assert.equal(c.day, day(0))
  assert.equal(c.series, undefined); assert.equal(c.spawned, undefined); assert.equal(c.completedAt, undefined); assert.equal(c.updatedAt, undefined)
  assert.equal(c.reminder.snoozeUntil, null); assert.equal(c.reminder.date, day(0))   // a dismissed reminder is not inherited
  assert.equal(c.subtasks[0].done, false); assert.notEqual(c.subtasks[0].id, 's1')
})
test('a copy of a task with a reminder that already passed does not ring at once', () => {
  assert.equal(pendingCopy(task({ reminder: rem({ time: hm(-30) }) })).reminder, null)
  assert.ok(pendingCopy(task({ reminder: rem({ time: hm(40) }) })).reminder)
})

test('restoring from the Archive keeps the completion status', () => {
  const done = { ...markDone(task({ day: day(-9), reminder: rem({ date: day(-9), lastAlert: 3 }), pinned: true }), 777), archivedAt: 1, reason: 'deleted' }
  const r = revivedTask(done, 42)
  assert.equal(r.done, true); assert.equal(r.day, day(-9)); assert.equal(r.completedAt, 777); assert.equal(r.order, 42); assert.equal(r.pinned, false)
  assert.deepEqual(r.reminder, done.reminder); assert.equal('archivedAt' in r, false); assert.equal('reason' in r, false)
  const open = revivedTask({ ...task({ day: day(-9), reminder: rem({ time: hm(-30) }) }), archivedAt: 1, reason: 'deleted' }, 43)
  assert.equal(open.done, false); assert.equal(open.day, day(0)); assert.equal(open.reminder, null)
})

test('an import keeps completion status, completion time and series; old completed tasks are not dropped', () => {
  const clean = sanitizeImported([{ id: 'a', text: 'old done', done: true, day: day(-40), completedAt: 1234567890, series: 'abc', spawned: true, updatedAt: 99 },
    { id: 'b', text: 'bad', done: true, completedAt: 'x', series: 5, updatedAt: 'y' }])
  assert.deepEqual([clean[0].done, clean[0].completedAt, clean[0].series, clean[0].spawned, clean[0].updatedAt], [true, 1234567890, 'abc', true, 99])
  assert.equal('completedAt' in clean[1], false); assert.equal('series' in clean[1], false); assert.equal('updatedAt' in clean[1], false)
  const out = normalizeForToday(clean)
  assert.equal(out.length, 2); assert.equal(out[0].done, true); assert.equal(out[0].day, day(-40))
})
test('more than 5000 tasks survive loading (completed tasks are kept for ever)', () => {
  const many = Array.from({ length: 6000 }, (_, i) => ({ id: `t${i}`, text: 'x', done: true, day: day(-1) }))
  assert.equal(sanitizeImported(many).length, 6000)
})

test('a reminder being snoozed, dismissed or alerted never touches a completed task', () => {
  const t = markDone(task({ reminder: rem({ time: hm(-30) }), subtasks: [{ id: 's', text: 'x', done: true, reminder: rem({ time: hm(-30) }) }] }), 1)
  for (const f of [(x) => ({ ...x, reminder: { ...x.reminder, snoozeUntil: Date.now() + 60000, lastAlert: null } }),
    (x) => ({ ...x, reminder: { ...x.reminder, snoozeUntil: 8640000000000000 } }), (x) => ({ ...x, reminder: { ...x.reminder, lastAlert: Date.now() } })]) {
    const [out] = patchItems([t], new Set([t.id]), f); assert.equal(out.done, true)
    const [o2] = patchItems([t], new Set(['s']), f); assert.equal(o2.done, true); assert.equal(o2.subtasks[0].done, true)
  }
  assert.ok(reminderItems([t]).every((i) => i.done))  // a completed task's reminders are done items: they never alert
})
test('ticking a step never changes its task\'s completion', () => {
  const t = task({ subtasks: [{ id: 's', text: 'x', done: false }] })
  const [a] = patchItems([t], new Set(['s']), (x) => ({ ...x, done: true })); assert.equal(a.subtasks[0].done, true); assert.equal(a.done, false)
  const c = markDone(task({ subtasks: [{ id: 's', text: 'x', done: false }] })); assert.equal(c.subtasks[0].done, false)
})

test('changed tasks are stamped with the time, untouched ones keep theirs', () => {
  const a = task({ updatedAt: 5 }), b = task({ updatedAt: 6 })
  const next = stampChanged([a, b], [a, markDone(b, 1)], 100)
  assert.equal(next[0], a); assert.equal(next[1].updatedAt, 100); assert.equal(next[1].done, true)
  const same = [a, b]; assert.equal(stampChanged(same, same, 100), same)
  assert.equal(stampChanged([a, b], [a, b], 100).length, 2)
  assert.equal(stampChanged([a], [a, b], 100)[1].updatedAt, 100)
})

test('merging windows: a stale window can never undo a newer completion', () => {
  const base = task({ id: 'x', updatedAt: 10 })
  const stale = base                                   // a window that missed the update
  const stored = markDone(base, 50); stored.updatedAt = 60   // saved by the other window
  const m = mergeTasks([stale], [stored], tombstones([], []))
  assert.equal(m[0].done, true)
  const mine = [stored]; assert.equal(mergeTasks(mine, [stale], tombstones([], [])), mine)   // the other direction: nothing to adopt
})
test('merging windows: the newer change wins either way; equal or older leaves ours as it is', () => {
  const mine = [task({ id: 'x', done: true, updatedAt: 60 })]
  assert.equal(mergeTasks(mine, [task({ id: 'x', done: false, updatedAt: 10 })], new Map()), mine)
  assert.equal(mergeTasks(mine, [{ ...mine[0] }], new Map()), mine)
  const merged = mergeTasks([task({ id: 'x', done: false, updatedAt: 10 })], [task({ id: 'x', done: true, updatedAt: 60 })], new Map())
  assert.equal(merged[0].done, true)
})
test('merging windows: tasks only the other window has are added; tasks only we have are kept', () => {
  const merged = mergeTasks([task({ id: 'a', updatedAt: 1 })], [task({ id: 'b', updatedAt: 2 })], new Map())
  assert.deepEqual(merged.map((x) => x.id), ['a', 'b'])
})
test('merging windows: a task deleted (archived) after its last change is not brought back; one restored after is', () => {
  const t = task({ id: 'd', updatedAt: 10 })
  assert.deepEqual(mergeTasks([], [t], tombstones([{ id: 'd', archivedAt: 50 }], [])), [])            // deleted here, stale copy over there
  assert.deepEqual(mergeTasks([t], [], tombstones([], [{ id: 'd', archivedAt: 50 }])), [])             // deleted over there
  assert.equal(mergeTasks([], [{ ...t, updatedAt: 90 }], tombstones([{ id: 'd', archivedAt: 50 }], [])).length, 1)  // restored later
})
test('merging the Archive: union, later archiving wins, entries for restored tasks drop out', () => {
  const m = mergeArchive([{ id: 'a', archivedAt: 5 }], [{ id: 'b', archivedAt: 9 }, { id: 'a', archivedAt: 3 }], [])
  assert.deepEqual(m.map((x) => x.id), ['b', 'a'])
  const mine = [{ id: 'a', archivedAt: 5 }]; assert.equal(mergeArchive(mine, [{ id: 'a', archivedAt: 4 }], []), mine)
  assert.deepEqual(mergeArchive([], [{ id: 'r', archivedAt: 5 }], [task({ id: 'r', updatedAt: 99 })]), [])
  assert.deepEqual(mergeArchive([], [{ id: 'p', archivedAt: 5 }], [], new Set(['p'])), [])  // deleted for good: the saved copy can't bring it back
})

test('Android: a completed repeating task keeps the coming days\' alarms until its next occurrence exists; after that the new task carries them', () => {
  const now = Date.now()
  const done = task({ recur: 'daily', done: true, reminder: rem({ time: '10:00' }) })
  assert.ok(alertTimes(done, now).length >= 5)
  assert.equal(alertTimes({ ...done, spawned: true }, now).length, 0)
})
test('alarms of a task that comes back fresh', () => {
  const t = task({ reminder: rem({ time: hm(-30), lastAlert: 4, snoozeUntil: 9 }), recur: 'daily' })
  assert.equal(withFreshAlarms(t).reminder.lastAlert, null); assert.equal(withFreshAlarms({ ...t, recur: null }).reminder, null)
})
