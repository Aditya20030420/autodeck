import { useEffect, useRef } from 'react'

// A city behind the app. It is built as today's progress (0-100) rises: towers grow, windows light up, traffic fills the road, and a
// crane keeps working on the last tower until the day is done. Three depth layers shift a little with the mouse.
const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
const ss = (v) => { v = v < 0 ? 0 : v > 1 ? 1 : v; return v * v * (3 - 2 * v) }  // smoothstep: eases in and out
const COLS = {
  dark: { far: '#1d3a5a', mid: '#17324f', near: '#122a45', edge: '#4f86b8', star: '#e2e8f0', haze: '#1a3856', warm: '#fde68a', road: '#0b1a2b' },
  light: { far: '#b9c8dc', mid: '#a3b4cc', near: '#8fa3be', edge: '#ffffff', star: '#94a3b8', haze: '#dce5f1', warm: '#f59e0b', road: '#7f90ab' },
}
// far to near: building width, max height (share of the screen), window size, body opacity, window opacity, mouse shift in px
const LAYERS = [
  { key: 'far', seed: 1, bw: 38, maxH: 0.24, gap: 2, ws: 7, body: 0.45, win: 0.2, par: 6 },
  { key: 'mid', seed: 4, bw: 46, maxH: 0.3, gap: 3, ws: 8, body: 0.58, win: 0.3, par: 12 },
  { key: 'near', seed: 7, bw: 54, maxH: 0.36, gap: 4, ws: 9, body: 0.72, win: 0.42, par: 22 },
]
const NEON = ['#f472b6', '#22d3ee', '#a3e635', '#fb923c']  // rooftop sign colours
const PEOPLE = ['#e2e8f0', '#f472b6', '#fbbf24', '#60a5fa', '#34d399']
const CONFETTI = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6']  // confetti and balloons
const RAINBOW = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#38bdf8', '#6366f1', '#a855f7']
// The firework shapes and their light colours (r,g,b). Each burst expands straight into one of these.
const SHAPES = ['heart', 'star', 'trophy', 'check', 'rocket']
const SHAPE_RGB = { heart: '255,105,150', star: '255,205,70', trophy: '255,170,60', check: '80,220,130', rocket: '120,225,255' }
const FW_EXP = 0.85, FW_HOLD = 1.6, FW_FALL = 1.5  // seconds: expand into the shape, hold and twinkle, fall and fade
const back = (u) => 1 + 2.1 * (u - 1) ** 3 + 1.1 * (u - 1) ** 2  // eases out with a small overshoot
// draws a shape into a unit box of size S (the light will be sampled from it)
const shapePath = (c, k, S) => {
  const m = S / 2
  c.beginPath()
  if (k === 'heart') {
    for (let i = 0; i <= 80; i++) {
      const t = (i / 80) * 6.2832, x = 16 * Math.sin(t) ** 3, y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
      const px = m + x * S * 0.027, py = m + y * S * 0.027 + S * 0.02
      i ? c.lineTo(px, py) : c.moveTo(px, py)
    }
    c.closePath()
  } else if (k === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -1.5708 + (i * Math.PI) / 5, r = (i % 2 ? 0.42 : 1) * S * 0.46
      i ? c.lineTo(m + Math.cos(a) * r, m + Math.sin(a) * r) : c.moveTo(m + Math.cos(a) * r, m + Math.sin(a) * r)
    }
    c.closePath()
  } else if (k === 'trophy') {
    c.moveTo(m - S * 0.3, m - S * 0.4); c.lineTo(m + S * 0.3, m - S * 0.4); c.lineTo(m + S * 0.24, m + S * 0.06)
    c.quadraticCurveTo(m + S * 0.18, m + S * 0.2, m + S * 0.06, m + S * 0.22); c.lineTo(m + S * 0.06, m + S * 0.32)
    c.lineTo(m + S * 0.22, m + S * 0.36); c.lineTo(m + S * 0.22, m + S * 0.44); c.lineTo(m - S * 0.22, m + S * 0.44)
    c.lineTo(m - S * 0.22, m + S * 0.36); c.lineTo(m - S * 0.06, m + S * 0.32); c.lineTo(m - S * 0.06, m + S * 0.22)
    c.quadraticCurveTo(m - S * 0.18, m + S * 0.2, m - S * 0.24, m + S * 0.06); c.closePath()
  } else if (k === 'rocket') {  // pointed nose, slim body, swept fins and a flame (drawn upright; tilted when sampled)
    c.moveTo(m, S * 0.02); c.bezierCurveTo(m + S * 0.16, S * 0.16, m + S * 0.14, S * 0.5, m + S * 0.12, S * 0.66)
    c.lineTo(m - S * 0.12, S * 0.66); c.bezierCurveTo(m - S * 0.14, S * 0.5, m - S * 0.16, S * 0.16, m, S * 0.02); c.closePath()
    c.moveTo(m + S * 0.12, S * 0.46); c.lineTo(m + S * 0.3, S * 0.76); c.lineTo(m + S * 0.12, S * 0.66); c.closePath()
    c.moveTo(m - S * 0.12, S * 0.46); c.lineTo(m - S * 0.3, S * 0.76); c.lineTo(m - S * 0.12, S * 0.66); c.closePath()
    c.moveTo(m - S * 0.08, S * 0.68); c.lineTo(m + S * 0.08, S * 0.68); c.lineTo(m, S * 0.96); c.closePath()
  }
}
const LANTERN = ['#fb923c', '#f97316', '#ef4444', '#fbbf24']
const FIREWORK = ['#fbbf24', '#f472b6', '#22d3ee', '#a3e635', '#c084fc']
const ROAD = 14  // height of the road strip along the bottom
const CAR_COLORS = ['#e11d48', '#2563eb', '#f59e0b', '#10b981', '#e2e8f0', '#7c3aed']
// The sky by the clock: hour, then top colour (r,g,b) and horizon colour (r,g,b)
const SKY = [[0, 10, 20, 50, 20, 40, 80], [5, 20, 30, 70, 80, 60, 110], [6.5, 110, 150, 210, 255, 170, 120], [9, 125, 190, 245, 180, 220, 250],
  [16, 125, 190, 245, 190, 225, 250], [18, 120, 120, 200, 255, 140, 100], [19.5, 40, 50, 110, 150, 80, 120], [21, 10, 20, 50, 20, 40, 80], [24, 10, 20, 50, 20, 40, 80]]
const DAY = [125, 190, 245, 190, 225, 250]
const skyAt = (h) => {
  let i = 0
  while (i < SKY.length - 2 && h >= SKY[i + 1][0]) i++
  const a = SKY[i], b = SKY[i + 1], k = (h - a[0]) / (b[0] - a[0] || 1)
  return a.slice(1).map((v, j) => v + (b[j + 1] - v) * k)
}
const WEATHER_PICKS = ['clear', 'rain', 'snow', 'fog', 'clear', 'rain']  // "random" weather changes every 20 minutes
// a soft round glow, drawn behind lit windows at night
const glowSprite = (rgb) => {
  const s = document.createElement('canvas'); s.width = s.height = 32
  const x = s.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16)
  gr.addColorStop(0, `rgba(${rgb},.9)`); gr.addColorStop(1, `rgba(${rgb},0)`)
  x.fillStyle = gr; x.fillRect(0, 0, 32, 32)
  return s
}
const clear = (rgb) => rgb.replace('rgb(', 'rgba(').replace(')', ',0)')  // the same colour, fully transparent (fading from black would go grey)
const mix = (x, y, k) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [a, b] = [p(x), p(y)]
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`
}

// Every building is decided once (size, roof style, and a fixed random rank for each window), so nothing re-rolls while it animates.
const build = (W, H, river) => LAYERS.map((L) => {
  const list = []
  for (let i = 0, x = -70; x < W + 70; i++) {
    const sd = L.seed * 1000 + i
    const w = L.bw * (0.6 + rnd(sd) * 0.9)
    const full = H * L.maxH * (0.3 + rnd(sd + 50) * 0.7)
    const v = rnd(sd + 200)
    const style = v < 0.45 ? 0 : v < 0.65 ? 1 : v < 0.8 ? 2 : v < 0.92 ? 3 : 4  // box, stepped, slanted roof, spire, rooftop tank
    const cols = Math.max(1, Math.floor((w - 8) / (L.ws + 3)))
    const rows = Math.max(0, Math.floor((full - 12) / (L.ws + 5)))
    const ks = new Float32Array(rows * cols), ph = new Float32Array(rows * cols)
    for (let n = 0; n < ks.length; n++) { ks[n] = rnd(sd * 7 + n * 3.7); ph[n] = rnd(sd * 13 + n * 5.1) }
    const inRiver = river && L.key !== 'far' && x + w > river.x0 - 4 && x < river.x1 + 4  // the near and middle towers leave room for the river
    const sign = L.key === 'near' && style < 3 && rnd(sd + 300) > 0.62 ? { col: NEON[Math.floor(rnd(sd + 310) * 4)], w: Math.min(26, w * 0.7) } : null
    if (!inRiver) list.push({ x, w, full, delay: rnd(sd + 90) * 0.3, style, cols, rows, ks, ph, pad: (w - (cols * (L.ws + 3) - 3)) / 2, h: 0, gr: 0, sign })
    x += w + L.gap
  }
  list.crane = -1  // the near tower that finishes last gets the crane
  if (L.key === 'near') {
    let best = -1
    list.forEach((b, i) => { const s = b.delay * 2 + b.full / H + (b.x > W * 0.1 && b.x < W * 0.9 ? 1 : 0); if (s > best) { best = s; list.crane = i } })
    if (list[list.crane]) list[list.crane].sign = null
  }
  return list
})

export default function Skyline({ pct, dark, accent, show = true, tod = true, weather = 'clear' }) {
  const ref = useRef(null)
  const redraw = useRef(null)
  const live = useRef({ pct, dark, show, tod, weather })
  live.current = { pct, dark, show, tod, weather }
  const glow = useRef({ warm: null, acc: null })
  const ac = useRef('45,212,191')  // the accent colour as r,g,b, read from the page's --ac1
  useEffect(() => { ac.current = getComputedStyle(document.documentElement).getPropertyValue('--ac1').trim().replace(/ +/g, ',') || '45,212,191'; glow.current.acc = glowSprite(ac.current); redraw.current?.() }, [accent])

  useEffect(() => {
    const cv = ref.current, g = cv.getContext('2d')
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    let W = 0, H = 0, raf = 0, last = 0, offAt = 0, bld = [], mx = 0, tx = 0
    let shown = still ? live.current.pct / 100 : 0  // the city builds itself up when the app opens
    let night = live.current.dark ? 1 : 0           // 0 = day, 1 = night; glides when the theme changes
    let todAmt = live.current.tod ? 1 : 0           // how much the sky follows the clock; glides when switched
    let wr = 0, wsn = 0, wf = 0                     // how much rain, snow and fog there is right now (each eases in and out)
    const drops = Array.from({ length: 170 }, (_, i) => ({ x: rnd(i), y: rnd(i + 50), v: 0.7 + rnd(i + 90) * 0.6, l: 9 + rnd(i + 130) * 9 }))
    const flakes = Array.from({ length: 110 }, (_, i) => ({ x: rnd(i + 300), y: rnd(i + 350), v: 0.5 + rnd(i + 390) * 0.8, r: 1 + rnd(i + 430) * 1.8, ph: rnd(i + 470) * 6.3 }))
    // the street: a river, lamps, traffic lights, cars that stop at red, people, and a firework show at 100%
    const world = { river: null, lamps: [], lights: [] }
    const cars = Array.from({ length: 17 }, (_, i) => {
      const bus = i % 7 === 3, suv = !bus && i % 3 === 1, base = 20 + rnd(i + 900) * 45
      return { i, dir: i % 2 ? -1 : 1, bus, suv, len: bus ? 26 : suv ? 17 : 15, base, v: base, x: 0 }
    })
    const people = Array.from({ length: 16 }, (_, i) => ({ i, dir: i % 3 ? 1 : -1, spd: 6 + rnd(i + 1900) * 8, x: 0, ph: rnd(i + 1950) * 6.3 }))
    const fw = { rockets: [], bursts: [], flashes: [], lanterns: [], bag: [], until: 0, next: 0, nextL: 0 }
    // the light points of each shape, sampled once from its outline
    const shapeCache = {}
    const shapePts = (kind) => shapeCache[kind] ||= (() => {
      const S = 96, o = document.createElement('canvas'); o.width = o.height = S
      const c = o.getContext('2d'); c.fillStyle = c.strokeStyle = '#fff'
      if (kind === 'check') { c.lineWidth = 13; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); c.moveTo(S * 0.2, S * 0.54); c.lineTo(S * 0.42, S * 0.76); c.lineTo(S * 0.8, S * 0.26); c.stroke() }
      else {
        if (kind === 'rocket') { c.save(); c.translate(S / 2, S / 2); c.rotate(Math.PI / 4); c.translate(-S / 2, -S / 2) }  // tilted, like the rocket emoji
        shapePath(c, kind, S); c.fill()
      }
      if (kind === 'trophy') { c.lineWidth = 6; c.beginPath(); c.arc(S * 0.2, S * 0.3, S * 0.1, 0.5 * Math.PI, 1.5 * Math.PI); c.stroke(); c.beginPath(); c.arc(S * 0.8, S * 0.3, S * 0.1, 1.5 * Math.PI, 0.5 * Math.PI); c.stroke() }
      if (kind === 'rocket') { c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(S * 0.5, S * 0.32, S * 0.06, 0, 6.3); c.fill(); c.restore() }  // the window
      const d = c.getImageData(0, 0, S, S).data, a = []
      for (let y = 0; y < S; y += 4) for (let x = 0; x < S; x += 4) if (d[(y * S + x) * 4 + 3] > 128) a.push([(x / S - 0.5) * 2, (y / S - 0.5) * 2])
      return a
    })()
    // where one light of a burst is at a given age: it flies straight out from the burst point to its place in the shape, holds, then falls
    const posOf = (b, p, age, o) => {
      const e = back(Math.min(1, Math.max(0, (age - p.dl) / FW_EXP)))
      o[0] = b.x + p.tx * b.R * e; o[1] = b.y + p.ty * b.R * e; o[2] = 1
      if (age > FW_EXP + FW_HOLD) { const f = (age - FW_EXP - FW_HOLD) / FW_FALL; o[1] += f * f * 90; o[0] += Math.sin(p.ph) * f * 12; o[2] = Math.max(0, 1 - f) }
    }
    const pa = [0, 0, 0], pb = [0, 0, 0]
    const spr = {}  // glow sprites by colour
    const sp = (rgb) => (spr[rgb] ||= glowSprite(rgb))
    const fest = { start: 0, until: 0, conf: [], balloons: [], acc: 0, nextB: 0 }  // the daytime celebration: rainbow, balloons, confetti
    let prevTarget = live.current.pct
    glow.current.warm = glowSprite('253,230,138')
    if (!glow.current.acc) glow.current.acc = glowSprite(ac.current)

    const size = () => {
      const r = Math.min(devicePixelRatio || 1, 2)
      W = innerWidth; H = innerHeight
      cv.width = W * r; cv.height = H * r
      g.setTransform(r, 0, 0, r, 0, 0)
      const rw = Math.max(150, Math.min(300, W * 0.2))
      world.river = W >= 640 ? { x0: W * 0.6, x1: W * 0.6 + rw } : null
      world.lamps = []
      for (let x = 50, i = 0; x < W; x += 110 + rnd(i + 500) * 60, i++) world.lamps.push(x)
      world.lights = [W * 0.16, W * 0.44, W * 0.9].map((x) => (world.river && x > world.river.x0 - 20 && x < world.river.x1 + 20 ? world.river.x0 - 40 : x))
      bld = build(W, H, world.river)
    }
    const initWorld = () => {
      cars.forEach((c) => { c.x = rnd(c.i + 950) * (W + 120) - 60 })
      people.forEach((q) => { q.x = rnd(q.i + 1920) * W })
    }
    // the light cycle: green, amber, then red (cars brake for amber and red)
    const lightAt = (t) => { const m = (t % 20000) / 1000; return m < 12 ? 'g' : m < 14 ? 'a' : 'r' }
    // cars brake for a red light and keep a gap behind the car in front, then pull away when it turns green
    const step = (t, sec) => {
      const stop = lightAt(t) !== 'g'
      for (const c of cars) {
        let target = c.base
        const front = c.x + c.dir * c.len
        if (stop) for (const xl of world.lights) {
          const d = c.dir * (xl - front)
          if (d > -1 && d < 34) target = Math.min(target, c.base * Math.max(0, (d - 3) / 30))
        }
        for (const o of cars) {
          if (o === c || o.dir !== c.dir) continue
          const gap = c.dir * (o.x - front)
          if (gap > 0 && gap < 40) target = Math.min(target, o.v, c.base * Math.max(0, (gap - 5) / 35))
        }
        c.v += (target - c.v) * (1 - Math.exp(-sec / 0.35))
        c.x += c.dir * c.v * sec
        if (c.dir > 0 && c.x > W + 60) c.x = -60 - rnd(c.i + t) * 80
        if (c.dir < 0 && c.x < -60) c.x = W + 60 + rnd(c.i + t) * 80
      }
      for (const q of people) { q.x += q.dir * q.spd * sec; if (q.x > W + 10) q.x = -10; if (q.x < -10) q.x = W + 10 }
    }

    const drawLayer = (li, p, t, c, ox, boost) => {
      const L = LAYERS[li], list = bld[li], base = H - ROAD, ws = L.ws
      // bodies and roofs
      for (const b of list) {
        const gr = ss(p * 1.3 - b.delay), h = b.full * (0.3 + 0.7 * gr), top = base - h, x = b.x + ox
        b.h = h; b.gr = gr
        g.globalAlpha = L.body; g.fillStyle = c[L.key]
        if (b.style === 1) {  // stepped: a wide base and a narrower top tier
          g.fillRect(x, base - h * 0.72, b.w, h * 0.72 + 10)
          g.fillRect(x + b.w * 0.19, top, b.w * 0.62, h * 0.28 + 1)
        } else if (b.style === 2) {  // slanted roof
          g.beginPath(); g.moveTo(x, base + 10); g.lineTo(x, top); g.lineTo(x + b.w, top + h * 0.14); g.lineTo(x + b.w, base + 10); g.fill()
        } else g.fillRect(x, top, b.w, h + 10)
        if (b.style === 3) {  // spire with a light at the tip
          const len = (10 + ws * 1.6) * gr
          g.fillRect(x + b.w / 2 - 0.5, top - len, 1, len)
          if (li === 2 && gr > 0.9) {
            const pulse = still ? 0 : Math.max(0, Math.sin(t / 900 + x)) ** 3
            if (pulse > 0.02) { g.globalAlpha = 0.9 * pulse; g.fillStyle = boost > 0.5 ? '#fbbf24' : '#f43f5e'; g.beginPath(); g.arc(x + b.w / 2, top - len - 2, 2, 0, 7); g.fill() }
          }
        } else if (b.style === 4 && gr > 0.9) {  // rooftop water tank
          g.fillRect(x + b.w * 0.25, top - 8, b.w * 0.3, 5)
          g.fillRect(x + b.w * 0.27, top - 3, 1.5, 3); g.fillRect(x + b.w * 0.5, top - 3, 1.5, 3)
        }
        if (b.sign && gr > 0.92) {  // rooftop billboard: a dim panel by day, glowing and flickering neon at night
          const sx = x + b.w / 2 - b.sign.w / 2, sy = top - 15, fl = still ? 1 : (t / (900 + b.x * 3)) % 1 < 0.04 ? 0.25 : 1
          g.globalAlpha = L.body; g.fillStyle = c[L.key]; g.fillRect(sx + 2, sy + 9, 1, 6); g.fillRect(sx + b.sign.w - 3, sy + 9, 1, 6)
          g.globalAlpha = 0.16 * night * fl; g.fillStyle = b.sign.col; g.fillRect(sx - 3, sy - 3, b.sign.w + 6, 15)
          g.globalAlpha = (0.4 + 0.55 * night * fl) * L.body / 0.72; g.fillRect(sx, sy, b.sign.w, 9)
          g.globalAlpha = 0.55; g.fillStyle = '#ffffff'; g.fillRect(sx + 3, sy + 2.5, b.sign.w - 6, 1); g.fillRect(sx + 3, sy + 5.2, (b.sign.w - 6) * 0.55, 1)
        }
        g.globalAlpha = L.body * 0.35; g.fillStyle = c.edge; g.fillRect(x, top, 1, h)  // a thin highlight on the lit edge
      }
      // windows: each is lit once progress passes its own fixed rank, fading in smoothly
      const sweep = (t / 7000) % 1.4 - 0.2
      for (const b of list) {
        const x = b.x + ox, top = base - b.h, stepH = b.style === 1 ? b.h * 0.72 : b.h
        for (let r = 0; r < b.rows; r++) {
          const wy = base - 6 - ws - r * (ws + 5)
          if (wy < top + 6) break
          const upper = b.style === 1 && base - wy > stepH
          for (let cc = 0; cc < b.cols; cc++) {
            const wx = x + b.pad + cc * (ws + 3)
            if (upper && (wx < x + b.w * 0.19 + 2 || wx + ws > x + b.w * 0.81 - 2)) continue
            if (b.style === 2 && wy < top + b.h * 0.14 * ((wx - x) / b.w) + 6) continue
            const n = r * b.cols + cc, k = b.ks[n], u = ss((p - k) / 0.1)
            if (u <= 0.01) continue
            let a = L.win * u
            if (!still && b.ph[n] > 0.85) {  // a few rooms dim now and then, like someone switching a light off
              const q = Math.sin(t / (1500 + b.ph[n] * 3000) + b.ph[n] * 90)
              if (q > 0.6) a *= 1 - 0.8 * ss((q - 0.6) / 0.25)
            }
            if (boost > 0) a += boost * 0.5 * Math.max(0, 1 - Math.abs(wx / W - sweep) * 7)  // when the day is done, a wave of light runs across
            if (night > 0.05 && li > 0 && a > 0.1) {  // soft halo around lit windows at night
              const sz = ws * 3.4
              g.globalAlpha = Math.min(1, a * night * (li === 2 ? 0.55 : 0.4))
              g.drawImage(k < 0.3 ? glow.current.warm : glow.current.acc, wx + (ws - 2) / 2 - sz / 2, wy + ws / 2 - sz / 2, sz, sz)
            }
            g.globalAlpha = a > 1 ? 1 : a
            g.fillStyle = k < 0.3 ? c.warm : c.win
            g.fillRect(wx, wy, ws - 2, ws)
          }
        }
      }
    }

    const draw = (t, dt = 0) => {
      const { pct: target, dark } = live.current
      // eased by elapsed time, so it feels the same at any frame rate
      shown += (target / 100 - shown) * (still ? 1 : 1 - Math.exp(-dt / 600))
      night += ((dark ? 1 : 0) - night) * (still ? 1 : 1 - Math.exp(-dt / 250))
      if (Math.abs(night - (dark ? 1 : 0)) < 0.002) night = dark ? 1 : 0
      mx += (tx - mx) * (still ? 0 : 1 - Math.exp(-dt / 300))
      if (!still && dt > 0) step(t, Math.min(dt, 100) / 1000)
      if (!still && target >= 100 && prevTarget < 100) { fw.until = t + 9000; fw.next = t + 200; fest.start = t; fest.until = t + 9000 }  // all done: fireworks at night, a rainbow with balloons and confetti by day
      prevTarget = target
      const c = {}
      for (const k in COLS.dark) c[k] = mix(COLS.light[k], COLS.dark[k], night)
      c.win = `rgb(${ac.current})`
      const boost = still ? 0 : ss((shown - 0.97) / 0.03)
      g.globalCompositeOperation = 'source-over'
      g.clearRect(0, 0, W, H)

      // weather: ease each kind toward its target
      const wk = still ? 'clear' : live.current.weather === 'random' ? WEATHER_PICKS[Math.floor(rnd(Math.floor(Date.now() / 1200000) + 77) * 6)] : live.current.weather
      const wEase = 1 - Math.exp(-dt / 1500)
      wr += ((wk === 'rain' ? 1 : 0) - wr) * wEase; wsn += ((wk === 'snow' ? 1 : 0) - wsn) * wEase; wf += ((wk === 'fog' ? 1 : 0) - wf) * wEase
      const gloom = Math.min(1, wr * 0.75 + wsn * 0.4 + wf * 0.5)

      // --- sky, following the real clock (dawn and dusk glow, dim at night) ---
      todAmt += ((live.current.tod ? 1 : 0) - todAmt) * (still ? 1 : 1 - Math.exp(-dt / 700))
      const now = new Date(), hrs = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
      const sk = skyAt(hrs).map((v, j) => DAY[j] + (v - DAY[j]) * todAmt).map(Math.round)
      const cn = Math.max(0, Math.min(1, (150 - (sk[0] + sk[1] + sk[2]) / 3) / 110))  // 0 in daylight, 1 in the middle of the night
      const dusk = Math.max(0, Math.min(1, (sk[3] - sk[5] - 30) / 150))                  // how orange the horizon is
      if (night < 0.99) {
        const sky = g.createLinearGradient(0, 0, 0, H * 0.8)
        sky.addColorStop(0, `rgba(${sk[0]},${sk[1]},${sk[2]},${0.55 * (1 - 0.55 * cn)})`)
        sky.addColorStop(0.7, `rgba(${sk[3]},${sk[4]},${sk[5]},${0.32 * (1 - 0.5 * cn)})`); sky.addColorStop(1, `rgba(${sk[3]},${sk[4]},${sk[5]},0)`)
        g.globalAlpha = (1 - night) * (1 - 0.45 * gloom); g.fillStyle = sky; g.fillRect(0, 0, W, H)
      }
      if (night > 0.01 && dusk > 0.02) {  // the dusk or dawn glow also shows with the dark theme
        const hz = g.createLinearGradient(0, H * 0.3, 0, H)
        hz.addColorStop(0, `rgba(${sk[3]},${sk[4]},${sk[5]},0)`); hz.addColorStop(1, `rgba(${sk[3]},${sk[4]},${sk[5]},.4)`)
        g.globalAlpha = night * dusk * 0.8; g.fillStyle = hz; g.fillRect(0, H * 0.3, W, H * 0.7)
      }
      if (gloom > 0.02) {  // overcast: a grey veil over the sky
        g.globalAlpha = 0.17 * gloom; g.fillStyle = mix('#7b8da3', '#0b1a2b', night); g.fillRect(0, 0, W, H * 0.8)
      }
      g.fillStyle = mix('#ffffff', '#7f9cc4', night)  // clouds drift all the time: white by day, dim blue-grey at night
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
      if (!still) {
        // a shooting star now and then, at night
        const s1 = t / 14000, f = s1 - Math.floor(s1)
        if (night > 0.4 && f < 0.05) {
          const u = f / 0.05, cyc = Math.floor(s1)
          const hx = W * (0.25 + 0.6 * rnd(cyc + 1000)) - u * 260, hy = H * (0.04 + 0.12 * rnd(cyc + 1100)) + u * 130
          const tail = g.createLinearGradient(hx + 70, hy - 35, hx, hy)
          tail.addColorStop(0, 'rgba(226,232,240,0)'); tail.addColorStop(1, 'rgba(255,255,255,1)')
          g.globalAlpha = night * ss(u * 5) * (1 - u * u); g.strokeStyle = tail; g.lineWidth = 1.5
          g.beginPath(); g.moveTo(hx + 70, hy - 35); g.lineTo(hx, hy); g.stroke()
        }
        // a plane crossing every so often, with a trail (and blinking lights at night)
        const pc = t / 50000, pf = pc - Math.floor(pc)
        if (pf < 0.4) {
          const u = pf / 0.4, dir = Math.floor(pc) % 2 ? -1 : 1
          const px = dir > 0 ? -40 + u * (W + 80) : W + 40 - u * (W + 80), py = H * 0.13 + u * 14 + (Math.floor(pc) % 3) * 22
          const fa = ss(u * 8) * ss((1 - u) * 8)
          const tr = g.createLinearGradient(px - dir * 90, 0, px, 0)
          tr.addColorStop(0, 'rgba(255,255,255,0)'); tr.addColorStop(1, 'rgba(255,255,255,.7)')
          g.globalAlpha = fa * 0.4; g.fillStyle = tr; g.fillRect(Math.min(px, px - dir * 90), py - 0.5, 90, 1)
          g.globalAlpha = fa; g.fillStyle = mix('#64748b', '#e2e8f0', night); g.fillRect(px - 2, py - 1, 5, 2)
          if (night > 0.3 && t % 1100 < 140) { g.globalAlpha = fa * night; g.fillStyle = '#f43f5e'; g.fillRect(px - 2, py - 2, 2, 2) }
        }
        // a small flock of birds by day
        const bc = t / 75000, bf = bc - Math.floor(bc)
        if (night < 0.98 && bf < 0.5) {
          const u = bf / 0.5
          g.strokeStyle = '#475569'; g.lineWidth = 1.3
          for (let i = 0; i < 5; i++) {
            const bx = -30 + u * (W + 60) - i * 26, by = H * 0.2 + Math.sin(u * 6 + i) * 10 + i * 8, fl = Math.sin(t / 180 + i * 1.7) * 3
            g.globalAlpha = 0.6 * (1 - night) * ss(u * 8) * ss((1 - u) * 8)
            g.beginPath(); g.moveTo(bx - 5, by - fl); g.lineTo(bx, by); g.lineTo(bx + 5, by - fl); g.stroke()
          }
        }
      }

      // rainbow (behind the buildings), part of the daytime celebration
      if (!still && fest.start && t >= fest.start) {
        const ra = ss((t - fest.start) / 1200) * (1 - ss((t - fest.until) / 2500)) * (1 - night)
        if (ra > 0.01) {
          const R = Math.min(W * 0.46, H * 0.78), bw = R * 0.028
          g.lineWidth = bw + 0.6
          for (let i = 0; i < 7; i++) { g.strokeStyle = RAINBOW[i]; g.globalAlpha = 0.42 * ra; g.beginPath(); g.arc(W * 0.5, H - ROAD, R - i * bw, Math.PI, 0); g.stroke() }
        }
      }
      // fireworks (behind the buildings): each burst expands straight into a shape (heart, star, trophy, check, rocket)
      if (!still && (t < fw.until || fw.rockets.length || fw.bursts.length || fw.flashes.length)) {
        const sec = Math.min(dt, 100) / 1000, nf = night
        if (t < fw.until && t >= fw.next && night > 0.35) {
          fw.rockets.push({ x: W * (0.15 + 0.7 * Math.random()), y: H - ROAD, ty: H * (0.2 + 0.22 * Math.random()), hist: [] })
          fw.next = t + 700 + Math.random() * 600
        }
        g.globalCompositeOperation = 'lighter'
        g.lineCap = 'round'
        for (let i = fw.rockets.length - 1; i >= 0; i--) {
          const r = fw.rockets[i]
          r.hist.push(r.x, r.y); if (r.hist.length > 20) r.hist.splice(0, 2)
          r.y -= Math.max(70, (r.y - r.ty) * 3.4) * sec  // it slows down smoothly as it nears the top
          r.x += Math.sin(t / 90 + i) * 0.25
          g.strokeStyle = '#fde68a'; g.lineWidth = 1.5
          for (let k = 2; k < r.hist.length; k += 2) { g.globalAlpha = 0.7 * nf * (k / r.hist.length); g.beginPath(); g.moveTo(r.hist[k - 2], r.hist[k - 1]); g.lineTo(r.hist[k], r.hist[k + 1]); g.stroke() }
          g.globalAlpha = nf; g.drawImage(sp('253,230,138'), r.x - 4, r.y - 4, 8, 8)
          if (r.y <= r.ty + 2) {  // burst: the lights start expanding into the next shape at once
            if (!fw.bag.length) fw.bag = [...SHAPES].sort(() => Math.random() - 0.5)
            const kind = fw.bag.pop()
            fw.bursts.push({ x: r.x, y: r.y, age: 0, rgb: SHAPE_RGB[kind], R: Math.max(70, Math.min(130, Math.min(W, H) * 0.16)), held: 0,
              pts: shapePts(kind).map((q) => ({ tx: q[0], ty: q[1], ph: Math.random() * 6.3, sz: 0.7 + Math.random() * 0.6, dl: Math.random() * 0.06 })) })
            fw.flashes.push({ x: r.x, y: r.y, age: 0, rgb: SHAPE_RGB[kind] })
            fw.rockets.splice(i, 1)
          }
        }
        for (let i = fw.flashes.length - 1; i >= 0; i--) {
          const f = fw.flashes[i]; f.age += sec
          if (f.age > 0.35) { fw.flashes.splice(i, 1); continue }
          const sz = 120 + f.age * 260; g.globalAlpha = 0.5 * (1 - f.age / 0.35) * nf
          g.drawImage(sp(f.rgb), f.x - sz / 2, f.y - sz / 2, sz, sz)
        }
        for (let i = fw.bursts.length - 1; i >= 0; i--) {
          const b = fw.bursts[i]; b.age += sec
          if (b.age > FW_EXP + FW_HOLD + FW_FALL) { fw.bursts.splice(i, 1); continue }
          const held = b.age > FW_EXP && b.age < FW_EXP + FW_HOLD + 0.3
          if (b.age > 0.5 && held) { const sz = b.R * 2.9; g.globalAlpha = 0.12 * nf; g.drawImage(sp(b.rgb), b.x - sz / 2, b.y - sz / 2, sz, sz) }  // a faint glow behind the shape
          g.strokeStyle = `rgb(${b.rgb})`; g.lineWidth = 1.1
          for (const p of b.pts) {
            posOf(b, p, b.age, pa)
            if (pa[2] <= 0.01) continue
            posOf(b, p, Math.max(0, b.age - 0.05), pb)
            g.globalAlpha = 0.55 * pa[2] * nf; g.beginPath(); g.moveTo(pb[0], pb[1]); g.lineTo(pa[0], pa[1]); g.stroke()  // a short trail
            const tw = held ? 0.75 + 0.25 * Math.sin(t / 180 + p.ph * 3) : 1, sz = 7 + 4 * p.sz
            g.globalAlpha = pa[2] * tw * nf; g.drawImage(sp(b.rgb), pa[0] - sz / 2, pa[1] - sz / 2, sz, sz)
            g.globalAlpha = pa[2] * tw * 0.9 * nf; g.fillStyle = '#fff'; g.fillRect(pa[0] - 0.8, pa[1] - 0.8, 1.6, 1.6)
          }
        }
        g.globalCompositeOperation = 'source-over'
      }

      // --- city ---
      const gl = g.createLinearGradient(0, H, 0, H * 0.45)
      gl.addColorStop(0, `rgba(${ac.current},${0.03 + 0.1 * shown})`); gl.addColorStop(1, `rgba(${ac.current},0)`)
      g.globalAlpha = 1; g.fillStyle = gl; g.fillRect(0, H * 0.45, W, H * 0.55)
      const haze = g.createLinearGradient(0, H * 0.5, 0, H)  // distance haze: the far towers fade into the air
      haze.addColorStop(0, clear(c.haze)); haze.addColorStop(1, c.haze)
      for (let li = 0; li < 3; li++) {
        drawLayer(li, shown, t, c, -mx * LAYERS[li].par, boost)
        if (li < 2) { g.globalAlpha = 0.3; g.fillStyle = haze; g.fillRect(0, H * 0.5, W, H * 0.5) }
      }

      // crane on the last tower, until it is finished
      const nb = bld[2], cb = nb[nb.crane]
      if (cb) {
        const ca = 1 - ss((cb.gr - 0.88) / 0.12)
        if (ca > 0.02) {
          const cx = cb.x - mx * LAYERS[2].par + cb.w * 0.3, top = H - ROAD - cb.h, mh = 44
          const jx = cx + 58 * Math.cos(still ? 1 : t / 5200 + 1), cable = 14 + (still ? 0 : 8 * Math.sin(t / 2300))
          g.globalAlpha = ca * 0.85; g.fillStyle = g.strokeStyle = '#f59e0b'; g.lineWidth = 2
          g.fillRect(cx - 1, top - mh, 2, mh)
          g.beginPath(); g.moveTo(cx - (jx - cx) * 0.3, top - mh); g.lineTo(jx, top - mh); g.stroke()
          g.lineWidth = 1; g.globalAlpha = ca * 0.6
          g.beginPath(); g.moveTo(jx, top - mh); g.lineTo(jx, top - mh + cable); g.stroke()
          g.fillRect(jx - 2, top - mh + cable, 4, 3)
          if (!still) { g.globalAlpha = ca * Math.max(0, Math.sin(t / 700)) ** 3; g.fillStyle = '#f43f5e'; g.beginPath(); g.arc(cx, top - mh - 3, 2, 0, 7); g.fill() }
        }
      }

      // river with boats and reflections of the lit windows
      const rv = world.river
      if (rv) {
        const wy = H - ROAD - 22, ww = rv.x1 - rv.x0
        g.save(); g.beginPath(); g.rect(rv.x0, wy, ww, 22); g.clip()
        const wg = g.createLinearGradient(0, wy, 0, H - ROAD)
        wg.addColorStop(0, mix('#8fb8e0', '#1d3f66', night)); wg.addColorStop(1, mix('#6e9bc8', '#0f2a47', night))
        g.globalAlpha = 0.9; g.fillStyle = wg; g.fillRect(rv.x0, wy, ww, 22)
        for (let k = 0, n = Math.round(26 * shown); k < n; k++) {  // window lights reflected as shimmering streaks
          const fl = still ? 1 : 0.6 + 0.4 * Math.sin(t / 500 + k * 2.1)
          g.globalAlpha = 0.5 * fl * (0.25 + 0.75 * night); g.fillStyle = k % 3 === 0 ? c.warm : c.win
          g.fillRect(rv.x0 + 6 + rnd(k + 1200) * (ww - 12), wy + 2 + rnd(k + 1300) * 14, 1.6, 2 + rnd(k + 1400) * 5)
        }
        g.fillStyle = '#ffffff'; g.globalAlpha = 0.22
        for (let k = 0; k < 10; k++) g.fillRect(rv.x0 + ((rnd(k + 1500) * ww + (still ? 0 : t / 1000) * (6 + rnd(k + 1600) * 8)) % ww), wy + 3 + rnd(k + 1700) * 16, 6, 1)
        for (let i = 0; i < 2; i++) {  // a sailboat and a small ferry
          const dir = i ? -1 : 1, pos = ((i * 0.5 * ww + (still ? 0 : t / 1000) * (9 + i * 5)) % (ww + 60)) - 30
          const bx = dir > 0 ? rv.x0 + pos : rv.x1 - pos, by = wy + 15 + i * 3
          g.globalAlpha = 0.3; g.fillStyle = '#ffffff'; g.fillRect(bx - dir * 18, by, 12, 0.8)  // wake
          g.globalAlpha = 0.95; g.fillStyle = mix('#e8eef6', '#8aa0bb', night)
          g.beginPath(); g.moveTo(bx - 7, by - 3); g.lineTo(bx + 7, by - 3); g.lineTo(bx + 5, by); g.lineTo(bx - 5, by); g.closePath(); g.fill()
          if (i === 0) { g.beginPath(); g.moveTo(bx, by - 3); g.lineTo(bx, by - 14); g.lineTo(bx + dir * 7, by - 3); g.closePath(); g.fill() } else g.fillRect(bx - 2, by - 6.5, 5, 3.5)
          g.globalAlpha = 0.2; g.fillRect(bx - 5, by + 1.5, 10, 1.5)  // reflection
          if (night > 0.05) { g.globalAlpha = night * 0.9; g.drawImage(glow.current.warm, bx + dir * 7 - 7, by - 10, 14, 14) }
        }
        g.restore()
        g.globalAlpha = 0.55; g.fillStyle = c.near; g.fillRect(rv.x0 - 3, wy + 4, 3, 18); g.fillRect(rv.x1, wy + 4, 3, 18)  // banks
      }
      // an elevated track with a train now and then
      const ty = H - ROAD - 56
      g.globalAlpha = 0.28 + 0.22 * night; g.fillStyle = mix('#7f90ab', '#0b1a2b', night); g.fillRect(0, ty, W, 2)
      g.globalAlpha = 0.14 + 0.16 * night; for (let x = 30; x < W; x += 110) g.fillRect(x, ty + 2, 1.6, 54)
      const tc = t / 40000, tf = tc - Math.floor(tc)
      if (!still && tf < 0.45) {
        const u = tf / 0.45, dir = Math.floor(tc) % 2 ? -1 : 1, cl = 24, tl = 5 * (cl + 2)
        const x0 = dir > 0 ? -tl + u * (W + tl) : W - u * (W + tl)
        for (let i = 0; i < 5; i++) {
          const cx = x0 + i * (cl + 2)
          g.globalAlpha = 0.95; g.fillStyle = mix('#b9c8dc', '#2b4566', night); g.fillRect(cx, ty - 10, cl, 9)
          g.globalAlpha = 0.9; g.fillStyle = `rgb(${ac.current})`; g.fillRect(cx, ty - 4.5, cl, 1.2)
          g.fillStyle = c.warm; g.globalAlpha = 0.55 + 0.4 * night
          for (let j = 0; j < 4; j++) g.fillRect(cx + 2.5 + j * 5.2, ty - 8.5, 3, 3)
        }
        if (night > 0.05) { g.globalAlpha = night * 0.8; g.drawImage(glow.current.warm, (dir > 0 ? x0 + tl : x0) - 12, ty - 14, 24, 16) }  // headlight
      }
      // pavement and street lamps (they switch on at dusk)
      g.globalAlpha = 0.5; g.fillStyle = mix('#c4d0e0', '#1a3a5c', night); g.fillRect(0, H - ROAD - 2, W, 2)
      const lampAmt = Math.max(night, cn, dusk * 0.7)
      for (const lx of world.lamps) {
        g.globalAlpha = 0.7; g.fillStyle = mix('#64748b', '#0b1a2b', night * 0.5); g.fillRect(lx, H - ROAD - 17, 1.2, 17); g.fillRect(lx, H - ROAD - 17, 5, 1.2)
        g.globalAlpha = 0.9; g.fillStyle = lampAmt > 0.3 ? '#fff4c2' : '#94a3b8'; g.fillRect(lx + 3, H - ROAD - 16, 3, 1.5)
        if (lampAmt > 0.05) {
          g.globalAlpha = lampAmt * 0.9; g.drawImage(glow.current.warm, lx + 4.5 - 15, H - ROAD - 15 - 15, 30, 30)
          g.globalAlpha = lampAmt * 0.12; g.fillStyle = '#fde68a'; g.beginPath(); g.ellipse(lx + 4.5, H - ROAD, 16, 3, 0, 0, 7); g.fill()
        }
      }
      if (!still) {  // people walking on the pavement
        for (const q of people) {
          const al = ss(2 + 12 * shown - q.i)
          if (al < 0.02) continue
          const fy = H - ROAD + 0.5, sw = Math.sin(t / 150 + q.ph) * 1.3
          g.globalAlpha = al * 0.9; g.fillStyle = g.strokeStyle = mix(PEOPLE[q.i % PEOPLE.length], '#0b1a2b', night * 0.4); g.lineWidth = 1
          g.fillRect(q.x - 1.2, fy - 5, 2.4, 3.4)
          g.beginPath(); g.arc(q.x, fy - 6.4, 1.3, 0, 7); g.fill()
          g.beginPath(); g.moveTo(q.x - 0.5, fy - 1.6); g.lineTo(q.x - 0.5 + sw, fy); g.moveTo(q.x + 0.5, fy - 1.6); g.lineTo(q.x + 0.5 - sw, fy); g.stroke()
        }
      }
      const ls = still ? 'g' : lightAt(t)  // traffic lights
      for (const lx of world.lights) {
        g.globalAlpha = 0.8; g.fillStyle = '#334155'; g.fillRect(lx, H - ROAD - 22, 1.5, 22); g.fillRect(lx - 2, H - ROAD - 31, 5.5, 11)
        ;[['r', '#ef4444'], ['a', '#f59e0b'], ['g', '#22c55e']].forEach(([k, col], j) => {
          g.fillStyle = col; g.globalAlpha = ls === k ? 1 : 0.18
          g.beginPath(); g.arc(lx + 0.75, H - ROAD - 28.3 + j * 2.8, 1.2, 0, 7); g.fill()
          if (ls === k && night > 0.05) { g.globalAlpha = night * 0.7; g.beginPath(); g.arc(lx + 0.75, H - ROAD - 28.3 + j * 2.8, 4, 0, 7); g.fill() }
        })
      }
      if (wf > 0.01) {  // fog banks drifting slowly
        for (let i = 0; i < 5; i++) {
          const rx = 280 + rnd(i + 810) * 220, ry = 50 + rnd(i + 820) * 40
          const cx = ((rnd(i + 800) * (W + 700) + (still ? 0 : t / 1000) * (5 + i * 2.5)) % (W + 700)) - 350, cy = H * (0.5 + 0.1 * i)
          g.save(); g.translate(cx, cy); g.scale(1, ry / rx)
          const fg = g.createRadialGradient(0, 0, 0, 0, 0, rx)
          const fc = night > 0.5 ? '120,140,170' : '255,255,255'
          fg.addColorStop(0, `rgba(${fc},1)`); fg.addColorStop(1, `rgba(${fc},0)`)
          g.globalAlpha = 0.5 * wf; g.fillStyle = fg; g.beginPath(); g.arc(0, 0, rx, 0, 7); g.fill()
          g.restore()
        }
      }
      // ground fog, the road, and traffic that grows with progress
      const fog = g.createLinearGradient(0, H - 90, 0, H)
      fog.addColorStop(0, clear(c.haze)); fog.addColorStop(1, c.haze)
      g.globalAlpha = 0.45; g.fillStyle = fog; g.fillRect(0, H - 90, W, 90)
      g.globalAlpha = 0.6; g.fillStyle = c.road; g.fillRect(0, H - ROAD, W, ROAD)
      if (!still) {
        for (const c2 of cars) {
          const i = c2.i, al = ss(3 + 14 * shown - i)
          if (al < 0.02) continue
          const { dir, bus, suv, len } = c2, yb = H - (dir > 0 ? 2 : 7)  // two lanes, one each way
          g.save(); g.translate(c2.x, yb); g.scale(dir, 1)  // drawn facing right, flipped for the other lane
          g.globalAlpha = al
          // headlight beam, stronger at night
          g.fillStyle = '#fff4c2'; g.globalAlpha = al * (0.1 + 0.25 * night)
          g.beginPath(); g.moveTo(len, -2.6); g.lineTo(len + 16, -4.2); g.lineTo(len + 16, -0.4); g.closePath(); g.fill()
          g.globalAlpha = al * 0.95
          g.fillStyle = mix(CAR_COLORS[i % CAR_COLORS.length], '#0b1a2b', night * 0.45)
          if (bus) {
            g.fillRect(0, -7, len, 6.4)
            g.fillStyle = mix('#cfe3f7', '#27415f', night); g.fillRect(2, -6, len - 4, 2.2)  // window strip
          } else {
            g.fillRect(0, -3.8, len, 2.8)  // body
            g.beginPath(); g.moveTo(len * 0.2, -3.8); g.lineTo(len * (suv ? 0.28 : 0.32), -6.4); g.lineTo(len * (suv ? 0.82 : 0.7), -6.4); g.lineTo(len * (suv ? 0.9 : 0.8), -3.8); g.closePath(); g.fill()  // cabin
            g.fillStyle = mix('#cfe3f7', '#27415f', night); g.globalAlpha = al * 0.75
            g.beginPath(); g.moveTo(len * 0.27, -4.1); g.lineTo(len * (suv ? 0.32 : 0.36), -5.9); g.lineTo(len * (suv ? 0.8 : 0.67), -5.9); g.lineTo(len * (suv ? 0.86 : 0.76), -4.1); g.closePath(); g.fill()  // glass
          }
          g.globalAlpha = al; g.fillStyle = '#0f172a'  // wheels
          g.beginPath(); g.arc(len * 0.22, -0.9, 1.5, 0, 7); g.arc(len * 0.78, -0.9, 1.5, 0, 7); g.fill()
          g.fillStyle = '#fff4c2'; g.fillRect(len - 1.2, -3, 1.2, 1.3)  // headlight
          g.fillStyle = '#f87171'; g.globalAlpha = al * (c2.v < c2.base * 0.5 ? 1 : 0.8); g.fillRect(0, -3, 1.2, 1.3)  // tail light (brighter when braking)
          g.restore()
        }
      }
      if (wr > 0.01) {  // rain: streaks, ripples on the road, and now and then lightning at night
        const sec = dt / 1000
        g.strokeStyle = mix('#8fb3d9', '#b6d2f0', night); g.lineWidth = 1; g.globalAlpha = 0.4 * wr
        g.beginPath()
        for (const d of drops) {
          d.y += (0.75 + d.v * 0.5) * sec * 1.1; d.x -= d.v * sec * 0.07
          if (d.y > 1) { d.y -= 1.05; d.x = rnd(d.x * 999 + t) }
          if (d.x < 0) d.x += 1
          const px = d.x * W, py = d.y * H
          g.moveTo(px, py); g.lineTo(px - 2.5, py - d.l)
        }
        g.stroke()
        g.lineWidth = 0.8; g.strokeStyle = '#cfe3f7'
        for (let i = 0; i < 14; i++) {
          const cyc = t / 1000 / (1.2 + rnd(i + 600) * 0.8) + rnd(i + 610), f = cyc - Math.floor(cyc)
          const rxp = 2 + f * 7
          g.globalAlpha = (1 - f) * 0.5 * wr
          g.beginPath(); g.ellipse(rnd(i + 300 + Math.floor(cyc) * 7) * W, H - 2 - rnd(i + 310 + Math.floor(cyc) * 3) * 8, rxp, rxp * 0.3, 0, 0, 7); g.stroke()
        }
        const lf = (t / 1000 / 17) % 1, lc = Math.floor(t / 17000)
        if (night > 0.3 && wr > 0.5 && lf < 0.012 && rnd(lc + 55) > 0.4) {
          g.globalAlpha = 0.3 * (1 - lf / 0.012) * night * wr; g.fillStyle = '#e8f0ff'; g.fillRect(0, 0, W, H)
        }
      }
      if (wsn > 0.01) {  // snow: flakes drifting down with a gentle sway
        const sec = dt / 1000
        g.fillStyle = mix('#ffffff', '#e2e8f0', night); g.globalAlpha = 0.75 * wsn
        for (const f of flakes) {
          f.y += (0.03 + f.v * 0.04) * sec; f.x += Math.sin(t / 1500 + f.ph) * 0.012 * sec
          if (f.y > 1) { f.y -= 1.02; f.x = rnd(f.x * 777 + t) }
          f.x = (f.x + 1) % 1
          g.beginPath(); g.arc(f.x * W, f.y * H, f.r, 0, 7); g.fill()
        }
      }
      // paper lanterns, lit, rising from the street while the fireworks go off (night)
      if (!still && (fw.lanterns.length || (t < fw.until && night > 0.35))) {
        const sec = Math.min(dt, 100) / 1000
        if (t < fw.until && night > 0.35 && t >= fw.nextL) {
          fw.lanterns.push({ x: W * (0.04 + 0.92 * Math.random()), y: H - ROAD - 4, vy: -(24 + Math.random() * 16), ph: Math.random() * 6.3, col: LANTERN[Math.floor(Math.random() * 4)], s: 0.85 + Math.random() * 0.5 })
          fw.nextL = t + 380 + Math.random() * 420
        }
        for (let i = fw.lanterns.length - 1; i >= 0; i--) {
          const l = fw.lanterns[i]
          l.y += l.vy * sec
          if (l.y < -40) { fw.lanterns.splice(i, 1); continue }
          const lx = l.x + Math.sin(t / 1300 + l.ph) * 14, fl = 0.85 + 0.15 * Math.sin(t / 130 + l.ph * 3)
          const al = night * ss((H - ROAD - l.y) / 60) * ss((l.y + 30) / (H * 0.2)), s = l.s
          g.globalCompositeOperation = 'lighter'
          g.globalAlpha = 0.6 * fl * al; g.drawImage(sp('253,186,116'), lx - 34 * s, l.y - 34 * s, 68 * s, 68 * s)
          g.globalCompositeOperation = 'source-over'
          g.globalAlpha = 0.95 * al; g.fillStyle = l.col
          g.beginPath(); g.moveTo(lx - 4.5 * s, l.y - 6.5 * s); g.lineTo(lx + 4.5 * s, l.y - 6.5 * s); g.lineTo(lx + 3.5 * s, l.y + 6.5 * s); g.lineTo(lx - 3.5 * s, l.y + 6.5 * s); g.closePath(); g.fill()
          g.globalAlpha = 0.75 * fl * al; g.fillStyle = '#fff2c2'; g.fillRect(lx - 2.5 * s, l.y - 4 * s, 5 * s, 8 * s)  // the lit inside
          g.globalAlpha = 0.9 * al; g.fillStyle = '#7c2d12'; g.fillRect(lx - 4.8 * s, l.y - 7.5 * s, 9.6 * s, 1.2 * s); g.fillRect(lx - 3.8 * s, l.y + 6.3 * s, 7.6 * s, 1.2 * s)  // top and bottom rims
        }
      }
      // daytime celebration in front: balloons rise from the roofs and confetti tumbles down
      const dayFest = 1 - night
      if (!still && dayFest > 0.02 && (t < fest.until || fest.conf.length || fest.balloons.length)) {
        const sec = Math.min(dt, 100) / 1000, on = t < fest.until
        if (on) {
          fest.acc += 90 * sec
          while (fest.acc >= 1) {
            fest.acc -= 1
            fest.conf.push({ x: Math.random() * W, y: -12, vy: 70 + Math.random() * 110, ph: Math.random() * 6.3, w: 4 + Math.random() * 4, h: 2 + Math.random() * 3, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 8, col: Math.floor(Math.random() * 7) })
          }
          if (t >= fest.nextB && t < fest.until - 1200) {
            fest.balloons.push({ x: W * (0.05 + 0.9 * Math.random()), y: H - ROAD - 8, vy: -(45 + Math.random() * 35), ph: Math.random() * 6.3, r: 7 + Math.random() * 3.5, col: Math.floor(Math.random() * 7) })
            fest.nextB = t + 350 + Math.random() * 350
          }
        }
        for (let i = fest.balloons.length - 1; i >= 0; i--) {
          const b = fest.balloons[i]
          b.y += b.vy * sec
          if (b.y < -50) { fest.balloons.splice(i, 1); continue }
          const bx = b.x + Math.sin(t / 900 + b.ph) * 10, ky = b.y + b.r * 1.2
          g.globalAlpha = 0.45 * dayFest; g.strokeStyle = '#64748b'; g.lineWidth = 0.8
          g.beginPath(); g.moveTo(bx, ky); g.quadraticCurveTo(bx + Math.sin(t / 600 + b.ph) * 4, ky + 14, bx + Math.sin(t / 700 + b.ph) * 3, ky + 26); g.stroke()
          g.globalAlpha = 0.92 * dayFest; g.fillStyle = CONFETTI[b.col]
          g.beginPath(); g.ellipse(bx, b.y, b.r, b.r * 1.2, 0, 0, 7); g.fill()
          g.beginPath(); g.moveTo(bx, ky - 1); g.lineTo(bx - 2, ky + 2); g.lineTo(bx + 2, ky + 2); g.closePath(); g.fill()
          g.globalAlpha = 0.5 * dayFest; g.fillStyle = '#ffffff'
          g.beginPath(); g.ellipse(bx - b.r * 0.35, b.y - b.r * 0.45, b.r * 0.2, b.r * 0.34, -0.5, 0, 7); g.fill()
        }
        for (let i = fest.conf.length - 1; i >= 0; i--) {
          const q = fest.conf[i]
          q.y += q.vy * sec; q.x += Math.sin(t / 700 + q.ph) * 30 * sec; q.rot += q.vr * sec
          if (q.y > H + 20) { fest.conf.splice(i, 1); continue }
          g.save(); g.translate(q.x, q.y); g.rotate(q.rot); g.scale(1, Math.cos(t / 250 + q.ph))  // tumbling
          g.globalAlpha = 0.95 * dayFest; g.fillStyle = CONFETTI[q.col]; g.fillRect(-q.w / 2, -q.h / 2, q.w, q.h)
          g.restore()
        }
      }
      g.globalAlpha = 1
    }

    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) { last = 0; return }  // nothing while the window is hidden
      // once faded out, stop drawing; it picks up again when shown
      if (!live.current.show) { offAt ||= t; if (t - offAt > 1000) { last = 0; return } } else offAt = 0
      const dt = last ? Math.min(t - last, 100) : 16
      last = t; draw(t, dt)
    }
    redraw.current = () => draw(0)
    size(); initWorld(); draw(0)
    if (!still) raf = requestAnimationFrame(frame)
    const onSize = () => { size(); draw(last, 0) }
    const onMove = (e) => { tx = (e.clientX / (innerWidth || 1) - 0.5) * 2 }
    addEventListener('resize', onSize)
    if (!still) addEventListener('pointermove', onMove, { passive: true })
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', onSize); removeEventListener('pointermove', onMove) }
  }, [])

  // reduced motion draws one still frame, so redraw it when the values change
  useEffect(() => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) redraw.current?.() }, [pct, dark])

  return <canvas ref={ref} aria-hidden="true" className={`pointer-events-none fixed inset-0 -z-10 h-full w-full transition-opacity duration-700 ease-out ${show ? 'opacity-100' : 'opacity-0'}`} />
}
