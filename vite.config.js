import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Inject a Content-Security-Policy into the built HTML only (kept out of dev so
// Vite's HMR, which needs eval + websockets, keeps working).
const csp = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'"
const cspPlugin = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace('</head>', `  <meta http-equiv="Content-Security-Policy" content="${csp}" />\n</head>`)
  },
}

export default defineConfig({
  // Relative base so the build works from any path (e.g. GitHub Pages /autodeck/).
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin],
})
