import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import TodoApp from './TodoApp.jsx'
import { Capacitor } from '@capacitor/core'
import { startAndroidUpdates } from './androidUpdate.js'

if (Capacitor.isNativePlatform()) document.documentElement.classList.add('native') // app-only feel, see index.css
startAndroidUpdates() // does nothing except in the Android app

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TodoApp />
  </StrictMode>,
)
