// Поток-исполнитель пунктов `pult doctor` про службу для демона (см. serviceDoctorItemsAsync).
// Здесь spawnSync launchctl/systemctl/loginctl/`node -v` блокирует только этот поток, а не
// событийный цикл демона.

import { parentPort, workerData } from 'node:worker_threads'
import type { PultPaths } from '../core/paths.js'
import { serviceDoctorItems } from './doctor.js'
import { setLanguage } from '../i18n/core.js'
import type { Language } from '../i18n/core.js'

const { paths, env, language } = workerData as { paths: PultPaths; env: NodeJS.ProcessEnv; language?: Language }
if (language) setLanguage(language)
parentPort?.postMessage(serviceDoctorItems(paths, env))
