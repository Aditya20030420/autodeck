import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Relative base so the build works from any path (e.g. GitHub Pages /autodeck/).
  base: './',
  plugins: [react(), tailwindcss()],
})
