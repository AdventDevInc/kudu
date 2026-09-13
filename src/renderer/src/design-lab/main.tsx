import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DashboardConcepts } from './DashboardConcepts'
import './concepts.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DashboardConcepts />
  </StrictMode>
)
