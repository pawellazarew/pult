// Сборка argv для `zcode` (маршрут A спайка docs/17-SPIKE-zcode.md: процесс на ход).
// Флаги — РОВНО те, что измерены спайком (CLI 0.17.0) и живой записью фикстур 02.11.2026
// (CLI 0.17.1): `-p` + `--output-format stream-json` (скрытый флаг: NDJSON-события по ходу и
// одна итоговая строка `{"type":"result",…}` — та же форма потока, что у claude).
//
// ОТЛИЧИЯ ОТ CLAUDE, КОТОРЫЕ НЕЛЬЗЯ «ПОЧИНИТЬ» ЗДЕСЬ:
//   1. Промпт идёт АРГУМЕНТОМ `-p`, не в stdin: у zcode нет входного формата stream-json. Он виден
//      в `ps` машины — известное ограничение маршрута A, задокументировано в DEV.md.
//   2. `--model` НЕ СУЩЕСТВУЕТ (парсер parseArgs strict:true падает на незнакомом флаге): модель
//      задаёт аккаунт Z.AI, выбора модели у сессии нет.
//   3. Режим подтверждений — `--mode` из пяти значений CLI; «спрашивать» ложится на `guarded`:
//      канала вопросов в Пульт у маршрута A нет, опасное CLI отклоняет сам.

import type { ApprovalMode } from '../types.js'

/**
 * M8d → `--mode` CLI. `ask` → `guarded`: безопасное выполняется, опасное отклоняется сам (замер спайка).
 * `full` → `yolo` — только когда демон его пропустил (согласие на полный доступ или `--yes`, src/daemon/server.ts
 * `accessGate`): без разрешения снимок хода приходит без уровня, и CLI получает `guarded`.
 * `inherit` у ZCode нет (`approvalFits` отказывает на входе); строка — на случай кривой записи: тише, а не шире.
 */
export const ZCODE_MODE: Readonly<Record<ApprovalMode, string>> = {
  'read-only': 'plan',
  ask: 'guarded',
  workspace: 'edit',
  full: 'yolo',
  inherit: 'guarded',
}

export interface ZcodeArgvOptions {
  /** Реплика (уже с контекстом режима `approvalContext`): у `-p` нет stdin-режима. */
  prompt: string
  /** Рабочая папка: дублирует cwd спавна — CLI кладёт разговор по `--cwd` (замер спайка). */
  cwd: string
  /** `sess_…` со второго хода: разговор переживает границу процесса (замер спайка: 4711 → 420). */
  resumeSessionId?: string
  /** M8d: нет или `ask` — `guarded`. */
  approval?: ApprovalMode
}

export function buildZcodeArgv(opts: ZcodeArgvOptions): string[] {
  const a: string[] = [
    '-p', opts.prompt,
    '--cwd', opts.cwd,
    '--surface', 'terminal',
    '--mode', ZCODE_MODE[opts.approval ?? 'ask'],
    '--output-format', 'stream-json',
  ]
  if (opts.resumeSessionId) a.push('--resume', opts.resumeSessionId)
  return a
}
