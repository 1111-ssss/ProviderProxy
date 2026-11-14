# Инструкция по разработке Provider Proxy

Этот файл — памятка для человека и агента, который продолжит работу. Читается вместе
с `PLAN.md` (что делаем) и `README.md` (как пользоваться приложением).

## Что это за проект

`provider_proxy` — локальный OpenAI-совместимый прокси с автоматическим переключением
upstream-провайдеров. Одна «модель» в клиенте = цепочка провайдеров по приоритету.
Если провайдер отдал 429, 5xx или не ответил — прокси сам берёт следующего.

Один бэкенд: **Rust + Tauri 2** (`rust-desktop/`). Он же поднимает HTTP-сервер и отдаёт
интерфейс, поэтому окно приложения (WebView) и обычный браузер на
`http://127.0.0.1:8787/` показывают один и тот же GUI из одного бэкенда.
Node-версия (`server.mjs`, `public/`) удалена — история осталась в git.

Интерфейс — один одностраничный документ: вкладки лежат в DOM и переключаются без
переходов. Собственной сборки и npm нет; скрипты подключаются обычными `<script src>`
по порядку и делят одну область видимости.

## Структура

| Путь | Что |
| --- | --- |
| `rust-desktop/frontend/index.html` | каркас интерфейса: `<head>`, разметка вкладок, `<link>`/`<script src>` |
| `rust-desktop/frontend/css/*.css` | стили: `tokens` (тема), `layout`, `components`, `pages` |
| `rust-desktop/frontend/js/*.js` | логика: `core`, `providers`, `dialogs-provider`, `dialogs-chain`, `models`, `connections`, `shared`, `images`, `tabs`, `logs`, `usage` |
| `rust-desktop/src/proxy/` | HTTP-бэкенд (не зависит от Tauri) |
| `rust-desktop/src/proxy/assets.rs` | отдача `frontend/*` через `include_str!` |
| `rust-desktop/src/proxy/handlers/` | HTTP-обработчики: `config`, `images`, `observe` |
| `rust-desktop/src/main.rs` | запуск Tauri, окно, трей, регистрация команд |
| `rust-desktop/src/platform.rs` | autostart и ярлыки ОС |
| `rust-desktop/src/updater.rs` | проверка/установка обновления, откат |

## Правила работы

1. **Не менять поведение**. Все текущие фичи остаются с тем же видом. Если правишь
   внешний вид ради бага — не переделывай остальное.
2. **Ветка на задачу**. Одна задача — одна ветка `feat/…`, `fix/…`, `refactor/…`,
   `docs/…`, `test/…`, `chore/…`. Не коммитить в `master` напрямую.
3. **Релиз — только по явной команде владельца.** Тег `app-vX.Y.Z` запускает
   публикацию через `.github/workflows/release.yml`.
4. Комментарии — только там, где причина не очевидна из кода, и **на английском**.
5. Работа через provider proxy: **не выключать и не закрывать прокси**, иначе
   разработка остановится.

## Перед каждым коммитом (все должны быть зелёными)

```bash
cd rust-desktop
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked          # с фичей desktop
cargo test --no-default-features --locked   # только библиотека, без WebView
```

Интеграционные тесты Rust: `rust-desktop/tests/http_api.rs` (публичный HTTP API).
GUI-смоук в реальном WebView: `rust-desktop/tests/checkin_smoke.py` (нужны
`WebKitWebDriver`, `xvfb-run`, `dbus-run-session`).

## Как править бэкенды

Общий контракт — HTTP API. Меняя маршрут или форму JSON, правь бэкенд и
`tests/http_api.rs`.

## Как править фронтенд

Фронтенд живёт в `rust-desktop/frontend/` и отдаётся Rust-бэкендом по маршрутам из
`proxy/assets.rs`. Нет шага сборки: правь `frontend/index.html`, `frontend/css/*.css` или
`frontend/js/*.js`. Порядок `<link>`/`<script src>` в `index.html` задаёт порядок загрузки —
скрипты делят одну область видимости, поэтому модуль использует то, что объявлено выше.
Добавляя файл, зарегистрируй его и в `assets.rs`, и в `index.html` (тест `frontend.test.mjs`
это проверяет).

## Окружение и переменные

- `PP_CONFIG_FILE` — путь к конфигу (или argv[1] у десктопа; argv важнее env).
- `PP_DB_FILE` — путь к SQLite (по умолчанию рядом с конфигом, `*.db`).
- `PP_CONFIG_KEY` / `PP_CONFIG_KEY_FILE` — ключ шифрования секретов.
- `PP_DISABLE_UPDATES` — выключить проверку обновлений (тесты/оффлайн).
- `PP_STATS_FILE`, `PP_LOG_LINES`, `PP_OPENCODE_SKILLS_DIR` — устаревшая статистика,
  размер кольцевого лога, папка skill.

## Полезное

- План работ и статусы: `PLAN.md`.
- Структура Rust-бэкенда: `rust-desktop/README.md`.
- База для отката до этой работы: ветка `master`, коммит `e639157`.
