// The daily rollover, with a fake clock: a COMPLETED task must never be archived, moved or reset by a new day, whatever the day,
// and a repeating task gets its next occurrence as a separate pending task (the completed original stays as it was).
import test from 'node:test'
import assert from 'node:assert/strict'

const RealDate = Date
let NOW = null
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW ?? RealDate.now()) }
  static now() { return NOW ?? RealDate.now() }
}
const { normalizeForToday, markDone } = await import('../.test-build/TodoApp.mjs')

const at = (iso) => { NOW = new RealDate(iso).getTime() }
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dow = (s) => new RealDate(`${s}T00:00`).getDay()
const mk = (text, o = {}) => ({ id: text, text, priority: 'Medium', category: 'Work', reminder: null, recur: null, done: true, pinned: false, day: '2026-11-20', createdAt: 1, order: 1, subtasks: [], ...o })
const timer = { date: '2026-11-20', time: '09:00', lead: 0, repeat: 0, lastAlert: 1, snoozeUntil: null }

// tasks completed on Friday 20 Nov 2026
const stored = () => [
  mk('plain', { completedAt: new RealDate('2026-11-20T10:00').getTime() }), mk('timer', { reminder: timer }),
  mk('dismissed timer', { reminder: { ...timer, snoozeUntil: 8640000000000000 } }),
  mk('plain with a repeating step', { subtasks: [{ id: 's', text: 'step', done: true, recur: 'daily', day: '2026-11-20' }] }),
  mk('daily', { recur: 'daily' }), mk('weekdays', { recur: 'weekdays' }), mk('weekly', { recur: 'weekly' }),
]
const run = (iso, list = stored()) => { at(iso); return normalizeForToday(list) }
const find = (out, id) => out.find((x) => x.id === id)

const OPENINGS = [
  ['the next day (Saturday)', '2026-11-21T08:00'], ['just after midnight', '2026-11-21T00:00:05'], ['Sunday', '2026-11-22T08:00'],
  ['Monday after a weekend away', '2026-11-23T08:00'], ['a week later', '2026-11-27T08:00'], ['month end to the next month', '2026-12-01T08:00'],
  ['year end to the next year', '2027-01-01T08:00'], ['a whole year later', '2027-11-20T08:00'],
]
for (const [label, iso] of OPENINGS) {
  test(`opened on ${label}: every completed task is still there, still completed, unchanged`, () => {
    const before = stored()
    const out = run(iso)
    for (const b of before) {
      const a = find(out, b.id)
      assert.ok(a, `${b.id} must not leave the list (it must not be archived)`)
      assert.equal(a.done, true, `${b.id} must stay completed`)
      assert.equal(a.day, b.day, `${b.id} keeps its own day`)
      assert.deepEqual(a.reminder, b.reminder, `${b.id} keeps its reminder as it was`)
      assert.deepEqual(a.subtasks, b.subtasks, `${b.id} keeps its steps as they were`)
    }
  })
}

test('a completed task that does not repeat comes back as the very same object (nothing was touched)', () => {
  const list = stored(); at('2026-11-23T08:00'); const out = normalizeForToday(list)
  for (const id of ['plain', 'timer', 'dismissed timer', 'plain with a repeating step']) assert.equal(find(out, id), list.find((x) => x.id === id))
})
test('nothing changes when there is nothing to do (same objects, so nothing is re-stamped)', () => {
  at('2026-11-20T21:00')
  const list = [mk('open', { done: false }), mk('done'), mk('daily done today', { recur: 'daily' })]
  const out = normalizeForToday(list)
  assert.deepEqual(out, list); out.forEach((x, i) => assert.equal(x, list[i]))
})

test('daily: the next occurrence is a separate pending task, the completed one is left exactly as it was', () => {
  const out = run('2026-11-21T08:00')
  const orig = find(out, 'daily'), next = find(out, 'daily@2026-11-21')
  assert.equal(orig.done, true); assert.equal(orig.day, '2026-11-20'); assert.equal(orig.spawned, true)
  assert.ok(next); assert.equal(next.done, false); assert.equal(next.day, '2026-11-21'); assert.equal(next.series, 'daily'); assert.equal(next.text, 'daily')
  assert.equal(next.completedAt, undefined); assert.equal(next.spawned, undefined)
})
test('weekdays: completed on Friday, the next occurrence is Monday (nothing on Saturday or Sunday)', () => {
  assert.equal(find(run('2026-11-21T08:00'), 'weekdays@2026-11-23').day, '2026-11-23')
  assert.equal(find(run('2026-11-22T08:00'), 'weekdays@2026-11-23').done, false)
  const mon = find(run('2026-11-23T08:00'), 'weekdays@2026-11-23')
  assert.equal(mon.day, '2026-11-23'); assert.equal(mon.done, false)
})
test('weekly: completed on Friday, the next occurrence is the Friday a week later', () => {
  const out = run('2026-11-22T08:00')
  assert.equal(find(out, 'weekly@2026-11-27').day, '2026-11-27'); assert.equal(find(out, 'weekly').done, true)
})
test('the next occurrence is created once, however often the rollover runs (restarts, two windows)', () => {
  at('2026-11-21T08:00')
  const once = normalizeForToday(stored()); const twice = normalizeForToday(once); const thrice = normalizeForToday(twice)
  for (const out of [once, twice, thrice]) assert.equal(out.filter((x) => x.series === 'daily').length, 1)
  assert.equal(thrice.length, once.length)
  // two windows each run it from the same starting point: the same id, so merging them can't make two
  const a = normalizeForToday(stored()), b = normalizeForToday(stored())
  assert.equal(find(a, 'daily@2026-11-21').id, find(b, 'daily@2026-11-21').id)
})
test('a repeating task with a reminder and steps: the next occurrence carries them, fresh', () => {
  at('2026-11-21T08:00')
  const t = mk('gym', { recur: 'daily', reminder: { ...timer, snoozeUntil: 5 }, subtasks: [{ id: 'st1', text: 'warm up', done: true, reminder: { ...timer } }] })
  const out = normalizeForToday([t]); const n = find(out, 'gym@2026-11-21')
  assert.deepEqual(n.reminder, { date: '2026-11-21', time: '09:00', lead: 0, repeat: 0, lastAlert: null, snoozeUntil: null })
  assert.equal(n.subtasks[0].done, false); assert.notEqual(n.subtasks[0].id, 'st1'); assert.equal(n.subtasks[0].reminder.date, '2026-11-21')
  const o = find(out, 'gym'); assert.equal(o.done, true); assert.equal(o.subtasks[0].done, true); assert.equal(o.reminder.snoozeUntil, 5)
})

test('completing a new occurrence does not touch the earlier ones, and the series carries on day after day', () => {
  // Fri 20: completed. Sat 21: next created. Mon 23 (weekdays): that one is completed. Tue 24: the next one appears.
  at('2026-11-21T08:00'); let list = normalizeForToday([mk('exercise', { recur: 'weekdays' })])
  const friday = find(list, 'exercise')
  at('2026-11-23T08:00'); list = normalizeForToday(list)
  list = list.map((x) => (x.id === 'exercise@2026-11-23' ? markDone(x, new RealDate('2026-11-23T18:00').getTime()) : x))
  assert.equal(find(list, 'exercise'), find(list, 'exercise'))
  assert.deepEqual(find(list, 'exercise'), { ...friday }); assert.equal(find(list, 'exercise').done, true)
  at('2026-11-24T08:00'); list = normalizeForToday(list)
  assert.equal(find(list, 'exercise@2026-11-24').done, false)
  assert.equal(list.filter((x) => x.series === 'exercise' || x.id === 'exercise').filter((x) => x.done).length, 2)
  assert.equal(find(list, 'exercise@2026-11-23').done, true)
})
test('a long absence creates one next occurrence (no backlog) and keeps every completed task', () => {
  const out = run('2027-02-01T08:00', [mk('daily', { recur: 'daily' }), mk('plain')])
  assert.equal(out.length, 3); assert.equal(find(out, 'daily@2027-02-01').day, '2027-02-01'); assert.equal(find(out, 'plain').done, true)
})
test('weekday arithmetic across a month end and a year end', () => {
  assert.equal(find(run('2026-12-31T08:00', [mk('w', { recur: 'weekdays', day: '2026-12-30' })]), 'w@2026-12-31').day, '2026-12-31')  // Thursday
  const ny = find(run('2027-01-01T08:00', [mk('w', { recur: 'weekdays', day: '2026-12-31' })]), 'w@2027-01-01'); assert.equal(ny.day, '2027-01-01')  // Friday
  const wk = find(run('2027-01-02T08:00', [mk('w', { recur: 'weekdays', day: '2027-01-01' })]), 'w@2027-01-04'); assert.equal(dow(wk.day), 1)  // Monday
  assert.equal(find(run('2027-03-01T08:00', [mk('d', { recur: 'daily', day: '2027-02-28' })]), 'd@2027-03-01').day, '2027-03-01')  // not a leap year
})

test('unfinished tasks still roll forward exactly as before', () => {
  const out = run('2026-11-23T08:00', [mk('open', { done: false, day: '2026-11-20' }), mk('future', { done: false, day: '2026-11-30' }),
    mk('open repeating', { done: false, recur: 'weekly', day: '2026-11-20' }), mk('legacy', { done: false, day: '2026-11-23', reminder: '17:00' })])
  assert.equal(find(out, 'open').day, '2026-11-23'); assert.equal(find(out, 'future').day, '2026-11-30')
  assert.equal(find(out, 'open repeating').day, '2026-11-27'); assert.equal(find(out, 'open repeating').done, false)
  assert.equal(find(out, 'legacy').reminder.time, '17:00')
})
test('a repeating step of an UNFINISHED task starts over; the steps of a completed task never do', () => {
  const out = run('2026-11-21T08:00', [mk('open', { done: false, subtasks: [{ id: 's', text: 'x', done: true, recur: 'daily', day: '2026-11-20' }] }),
    mk('finished', { subtasks: [{ id: 'f', text: 'y', done: true, recur: 'daily', day: '2026-11-20' }] })])
  assert.equal(find(out, 'open').subtasks[0].done, false); assert.equal(find(out, 'finished').subtasks[0].done, true)
})
test('a task completed today stays completed today', () => {
  at('2026-11-20T21:00'); const [t] = normalizeForToday([mk('today')]); assert.equal(t.done, true); assert.equal(t.day, '2026-11-20')
})
