import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './storageShim.js'
import OpenLine from './OpenLine.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <OpenLine />
  </StrictMode>,
)
