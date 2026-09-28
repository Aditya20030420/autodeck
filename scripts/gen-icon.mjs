// Rasterize the AutoDeck SVG icon into a PNG (for the window) and a multi-size
// .ico (for the Windows .exe). Run: node scripts/gen-icon.mjs
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const svg = readFileSync('public/favicon.svg')
mkdirSync('build', { recursive: true })

// high-res base PNG for the window icon
const png256 = await sharp(svg, { density: 512 }).resize(256, 256).png().toBuffer()
writeFileSync('electron/icon.png', png256)

// .ico with the sizes Windows uses (taskbar, explorer, alt-tab)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = await Promise.all(
  sizes.map((s) => sharp(svg, { density: 512 }).resize(s, s).png().toBuffer()),
)
writeFileSync('build/icon.ico', await pngToIco(pngs))

console.log('icon written: electron/icon.png, build/icon.ico')
