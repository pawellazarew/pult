# Пульт на Exact — проверка нативного окна

Экспериментальная интеграция с [expo/exact](https://github.com/expo/exact),
анонсированным [Charlie Cheever](https://x.com/ccheever/status/2119764253242695754).
Проверяем: может ли AppKit-окно на Contract читать нынешний демон Пульта через его RPC.

## Запуск на macOS

Нужны Bun >= 1.4.2, rustup и Xcode со Swift >= 6.4. Exact не публикует релизы;
ревизия закреплена в `upstream-revision`.

```sh
git clone https://github.com/expo/exact.git /tmp/pult-exact-upstream
git -C /tmp/pult-exact-upstream checkout "$(cat spike/exact/upstream-revision)"
cd /tmp/pult-exact-upstream
bun install --frozen-lockfile
PATH="$HOME/.cargo/bin:$PATH" cargo fetch --locked
# Вернитесь в checkout Пульта:
cd /path/to/pult
bun spike/exact/run.ts
```

`EXACT_CHECKOUT=/other/path` меняет расположение SDK. Запустите обычный Пульт заранее:
этот эксперимент сам не запускает и не заменяет демон. Первая сборка SDK может занять
10–15 минут; нужны несколько ГиБ свободного места. Окно называется Pult Exact Preview.

## Что подключено

- Список неархивных разговоров (`agent.list`), выбор разговора, текст истории (`agent.read`).
- Обновление по кнопке; ошибки и пустые состояния. История пока в текстовом виде,
  первая RPC-страница; это не полная замена renderer Markdown и подписок.
- Нативные HTTP sources в Contract, без app.ts/Hermes в приложении.
- Временный Bun-мост на случайном loopback-порту. Штатный клиент Пульта выполняет
  hello/version/token handshake; owner token не попадает в приложение. Мост принимает
  только GET двух маршрутов с отдельным случайным bearer, отклоняет browser Origin.
  Временные исходники и сборки с bearer находятся в игнорируемой `.runtime/` (0700).
  Закройте launcher через Ctrl+C для остановки моста. Не распространяйте эту сборку.

Проверка моста: `bun test spike/exact/bridge.test.ts`.

## Следующая приёмка

До выбора Exact для выпуска проверить настоящий AppKit-экран, большой чат и прокрутку,
подписки/reconnect, отправку/остановку, Inbox и вопросы Codex, RU/EN и accessibility.
Потом — вложения, диктовку, tray, deep links, обновление и подпись.

Главная архитектурная зависимость: Browser Preview сейчас использует Chromium Electron.
Ему потребуется отдельный процесс и сохранение pult_runtime/control lease. Exact не переносит
React-компоненты; интерфейс придётся переносить в Contract. Перенос демона на Rust от этого
эксперимента не зависит. Стабильный Пульт продолжает использовать Electron.
