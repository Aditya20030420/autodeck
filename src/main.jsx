import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import TodoApp from './TodoApp.jsx'
import { startAndroidUpdates } from './androidUpdate.js'

startAndroidUpdates() // does nothing except in the Android app

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TodoApp />
  </StrictMode>,
)
