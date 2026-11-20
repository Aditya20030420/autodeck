// `npm test`: bundles the app's logic (src/TodoApp.jsx, src/androidReminders.js) for Node, then runs every tests/*.test.mjs.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

mkdirSync('.test-build', { recursive: true })
const common = { bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'error',
  define: { __APP_VERSION__: '"test"', 'import.meta.env.BASE_URL': '"/"' } }
await build({ ...common, entryPoints: ['src/TodoApp.jsx'], outfile: '.test-build/TodoApp.mjs' })
await build({ ...common, entryPoints: ['src/androidReminders.js'], outfile: '.test-build/androidReminders.mjs' })
const r = spawnSync(process.execPath, ['--test', 'tests/logic.test.mjs'], { stdio: 'inherit' })
process.exit(r.status ?? 1)
