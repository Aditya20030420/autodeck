import { useEffect, useRef } from 'react'

// A night city behind the app. Towers rise and their windows light up as today's progress (0-100) goes up.
const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
const COLS = {
  dark: { far: '#1d3a5a', near: '#122a45', win: '#5eead4', warm: '#fde68a', star: '#e2e8f0' },
  light: { far: '#b4c3d8', near: '#8fa3be', win: '#14b8a6', warm: '#f59e0b', star: '#94a3b8' },
}

export default function Skyline({ pct, dark }) {
  const ref = useRef(null)
  const redraw = useRef(null)
  const live = useRef({ pct, dark })
  live.current = { pct, dark }

  useEffect(() => {
    const cv = ref.current, g = cv.getContext('2d')
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    let W = 0, H = 0, raf = 0, shown = live.current.pct / 100, last = 0

    const size = () => {
      const r = Math.min(devicePixelRatio || 1, 2)
      W = innerWidth; H = innerHeight
      cv.width = W * r; cv.height = H * r
      g.setTransform(r, 0, 0, r, 0, 0)
    }

    // one layer of towers: x, width, full height, own growth delay
    const layer = (seed, near, p, t, c) => {
      const base = H, gap = near ? 4 : 2
      const bw = near ? 54 : 40, maxH = H * (near ? 0.34 : 0.26)
      for (let i = 0, x = -10; x < W; i++) {
        const w = bw * (0.6 + rnd(seed + i) * 0.9)
        const full = maxH * (0.3 + rnd(seed + i + 50) * 0.7)
        const grow = 0.3 + 0.7 * Math.min(1, Math.max(0, p * 1.3 - rnd(seed + i + 90) * 0.3))
        const h = full * grow
        g.globalAlpha = near ? 0.7 : 0.45
        g.fillStyle = near ? c.near : c.far
        g.fillRect(x, base - h, w, h)
        // windows: lit when this window's random rank is under the progress
        const ws = near ? 9 : 8
        for (let wy = base - h + 8; wy < base - 6; wy += ws + 5) {
          for (let wx = x + 6; wx < x + w - 8; wx += ws + 3) {
            const k = rnd(seed + wx * 3.1 + wy * 7.7)
            if (k > p) continue
            const flick = !still && k > p - 0.04 ? 0.5 + 0.5 * Math.sin(t / 400 + k * 40) : 1  // the newest ones flicker
            g.globalAlpha = (near ? 0.4 : 0.22) * flick
            g.fillStyle = k < 0.3 ? c.warm : c.win
            g.fillRect(wx, wy, ws - 2, ws)
          }
        }
        // red beacon on the tall roofs
        if (near && full > maxH * 0.8 && !still && Math.sin(t / 700 + i) > 0.6) {
          g.globalAlpha = 0.9; g.fillStyle = '#f43f5e'
          g.beginPath(); g.arc(x + w / 2, base - h - 3, 2, 0, 7); g.fill()
        }
        x += w + gap
      }
    }

    // night: 0 = day, 1 = night. It glides, so switching themes fades the colours and swaps the sun for the moon.
    let night = live.current.dark ? 1 : 0
    const mix = (x, y, k) => {
      const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
      const [a, b] = [p(x), p(y)]
      return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`
    }
    const draw = (t) => {
      const { pct: target, dark } = live.current
      shown += (target / 100 - shown) * (still ? 1 : 0.04)  // glide to the new value
      night += ((dark ? 1 : 0) - night) * (still ? 1 : 0.07)
      if (Math.abs(night - (dark ? 1 : 0)) < 0.002) night = dark ? 1 : 0
      const c = {}
      for (const k in COLS.dark) c[k] = mix(COLS.light[k], COLS.dark[k], night)
      g.clearRect(0, 0, W, H)
      if (night < 0.99) {  // day sky: a blue wash from the top
        const sky = g.createLinearGradient(0, 0, 0, H * 0.8)
        sky.addColorStop(0, 'rgba(125,190,245,.55)'); sky.addColorStop(1, 'rgba(125,190,245,0)')
        g.globalAlpha = 1 - night; g.fillStyle = sky; g.fillRect(0, 0, W, H)
      }
      // clouds drift all the time: white by day, a dim blue-grey at night
      g.fillStyle = mix('#ffffff', '#7f9cc4', night)
      for (let i = 0; i < 7; i++) {
        const cw = 90 + rnd(i + 300) * 110, cy = H * (0.06 + rnd(i + 400) * 0.36)
        const cx = ((rnd(i + 500) * (W + 400) + (still ? 0 : t / 1000) * (8 + rnd(i + 600) * 10)) % (W + 400)) - 200
        g.globalAlpha = (0.35 + rnd(i + 700) * 0.25) * (1 - 0.5 * night)
        for (const [dx, dy, r] of [[0, 0, 0.32], [-0.3, 0.06, 0.22], [0.3, 0.05, 0.25], [0.08, -0.12, 0.24]]) {
          g.beginPath(); g.ellipse(cx + dx * cw, cy + dy * cw, r * cw, r * cw * 0.6, 0, 0, 7); g.fill()
        }
      }
      if (night > 0.01) {  // stars fade in at night
        g.fillStyle = c.star
        for (let i = 0; i < 60; i++) {
          g.globalAlpha = night * (0.25 + 0.5 * (still ? 0.6 : 0.5 + 0.5 * Math.sin(t / 900 + i * 2.3)))
          g.fillRect(rnd(i) * W, rnd(i + 200) * H * 0.5, 1.5, 1.5)
        }
      }
      // a glow on the horizon that grows with progress
      const gr = g.createLinearGradient(0, H, 0, H * 0.45)
      gr.addColorStop(0, `rgba(45,212,191,${0.03 + 0.1 * shown})`); gr.addColorStop(1, 'rgba(45,212,191,0)')
      g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, H * 0.45, W, H * 0.55)
      layer(1, false, shown, t, c)
      layer(7, true, shown, t, c)
      g.globalAlpha = 1
    }

    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden || t - last < 33) return  // ~30fps; nothing while the window is hidden
      last = t; draw(t)
    }
    redraw.current = () => draw(0)
    size(); draw(0)
    if (!still) raf = requestAnimationFrame(frame)
    const onSize = () => { size(); draw(last) }
    addEventListener('resize', onSize)
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', onSize) }
  }, [])

  // reduced motion draws one still frame, so redraw it when the values change
  useEffect(() => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) redraw.current?.() }, [pct, dark])

  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 h-full w-full" />
}
