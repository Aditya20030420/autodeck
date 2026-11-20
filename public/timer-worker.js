// Reminder timer for the web version. A browser slows (and after a few minutes nearly stops) the timers of a tab that is
// hidden, so a reminder set with a normal setTimeout could be 40-60 seconds late. A worker's timers are not slowed that way:
// the page tells this worker when the next reminder is due, and the worker wakes the page at that moment.
let timer = null
onmessage = (e) => {
  clearTimeout(timer)
  const at = e.data && e.data.at
  if (typeof at === 'number') timer = setTimeout(() => postMessage('due'), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1))
}
// a heartbeat as well, in case the page missed a message (a sleeping PC, for example)
setInterval(() => postMessage('beat'), 15000)
