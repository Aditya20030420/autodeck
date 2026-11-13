// Replace Capacitor's stock splash images with AutoDeck's: the app's navy with the icon in the middle.
// Run: node scripts/gen-android-splash.mjs
import sharp from 'sharp'
import { readFileSync, writeFileSync, readdirSync } from 'fs'

const svg = readFileSync('public/favicon.svg')
const res = 'android/app/src/main/res'
for (const d of readdirSync(res).filter((n) => n.startsWith('drawable') && !n.endsWith('v24'))) {
  const file = `${res}/${d}/splash.png`
  let meta
  try { meta = await sharp(file).metadata() } catch { continue }
  const { width, height } = meta
  const s = Math.round(Math.min(width, height) * 0.28)
  const icon = await sharp(svg, { density: 512 }).resize(s, s).png().toBuffer()
  writeFileSync(file, await sharp({ create: { width, height, channels: 4, background: '#16304A' } }).composite([{ input: icon, gravity: 'centre' }]).png().toBuffer())
  console.log(d, width + 'x' + height)
}
