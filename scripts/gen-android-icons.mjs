// AutoDeck's launcher icons for the Android app, from the same SVG as the desktop icon.
// Run: node scripts/gen-android-icons.mjs   (writes into android/app/src/main/res)
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'fs'

const svg = readFileSync('public/favicon.svg')
const res = 'android/app/src/main/res'
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const BG = '#16304A'

for (const [d, k] of Object.entries(dens)) {
  const legacy = Math.round(48 * k)   // pre-Android 8 square and round icons
  const adaptive = Math.round(108 * k) // Android 8+: 108 dp canvas, only the middle 66% is guaranteed visible
  const art = Math.round(adaptive * 0.58)
  const icon = await sharp(svg, { density: 512 }).resize(legacy, legacy).png().toBuffer()
  const round = await sharp(icon).composite([{ input: Buffer.from(`<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`), blend: 'dest-in' }]).png().toBuffer()
  const fg = await sharp({ create: { width: adaptive, height: adaptive, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(svg, { density: 512 }).resize(art, art).png().toBuffer(), gravity: 'centre' }]).png().toBuffer()
  writeFileSync(`${res}/mipmap-${d}/ic_launcher.png`, icon)
  writeFileSync(`${res}/mipmap-${d}/ic_launcher_round.png`, round)
  writeFileSync(`${res}/mipmap-${d}/ic_launcher_foreground.png`, fg)
}
writeFileSync(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`)
console.log('android icons written')
