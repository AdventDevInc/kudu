import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import { App } from './App'
import './globals.css'

if (import.meta.env.DEV) {
  import('@axe-core/react').then((axe) => {
    axe.default(React, ReactDOM, 1000)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
