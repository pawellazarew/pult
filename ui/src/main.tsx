// Точка входа интерфейса Пульта (Ф2, О1): агенты, разговор, Inbox, шапка, doctor (docs/12 §3).

import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
import './media.css'
import './files.css'
import './pdf.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
