// Точка входа интерфейса Пульта (Ф2, О1): агенты, разговор, Inbox, шапка, doctor (docs/12 §3).

import { createRoot } from 'react-dom/client'
import { initializeLanguage } from './lib/language.js'
import './styles.css'
import './projects.css'
import './media.css'
import './files.css'
import './pdf.css'
import './resize.css'
import './attachments.css'

async function start(): Promise<void> {
  await initializeLanguage()
  const { App } = await import('./App.js')
  const root = document.getElementById('root')
  if (root) createRoot(root).render(<App />)
}
void start()
