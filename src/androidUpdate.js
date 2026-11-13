// Self-update for the Android app. The desktop build gets window.autodeck from electron/preload.cjs; here the same
// shape is provided by the native ApkUpdate plugin, so the existing update banner works unchanged.
import { Capacitor, registerPlugin } from '@capacitor/core'

export function startAndroidUpdates() {
  if (Capacitor.getPlatform() !== 'android' || window.autodeck) return
  const Apk = registerPlugin('ApkUpdate')
  let state = { state: 'idle' }
  let info = null
  let busy = false
  const subs = new Set()
  const set = (s) => { state = s; subs.forEach((f) => f(s)) }

  const check = async () => {
    if (busy || state.state === 'ready') return // a downloaded update waits for the user's tap
    busy = true
    try {
      set({ state: 'checking' })
      const r = await Apk.check()
      if (!r.available) { set({ state: 'latest' }); return }
      info = r
      set({ state: 'downloading', version: r.version, percent: 0 })
      await Apk.download({ url: r.url, sha256: r.sha256 })
      set({ state: 'ready', version: r.version, manual: true })
    } catch (e) {
      set({ state: 'error', message: String(e?.message || e).slice(0, 120) }) // offline or rate-limited: try again later
    } finally {
      busy = false
    }
  }

  Apk.addListener('progress', (p) => set({ state: 'downloading', version: info?.version, percent: p.percent }))
  window.autodeck = {
    getUpdate: async () => state,
    onUpdate: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    installUpdate: () => Apk.install(),
  }
  check()
  setInterval(check, 6 * 3600 * 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
}
