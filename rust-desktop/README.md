# Provider Proxy Rust Desktop

Это отдельная desktop-версия `provider_proxy` на Rust + Tauri 2.

- интерфейс — тот же `frontend/index.html`, что и в web-версии;
- backend, failover, `/v1/chat/completions`, `/v1/models`, логи, usage и сохранение конфига — Rust;
- окно работает на Linux и Windows через системный WebView;
- API прокси слушает только `127.0.0.1` и доступен для OpenCode по `http://127.0.0.1:<port>/v1`.

## Структура Rust-кода

Backend разделён по ответственности, чтобы HTTP-слой не смешивался с конфигурацией и логикой
провайдеров:

- `src/main.rs` — запуск Tauri и создание единственного окна;
- `src/proxy/server.rs` — запуск Tokio/axum-сервера и таблица маршрутов;
- `src/proxy/handlers.rs` — HTTP handlers для GUI, настройки и списки моделей;
- `src/proxy/chat.rs` — обработка chat completions, failover и cooldown;
- `src/proxy/stream.rs` — передача JSON/SSE-ответов провайдера и сбор usage;
- `src/proxy/types.rs` — состояние приложения, upstream-модели и usage-типы;
- `src/proxy/routing.rs` — построение цепочек failover и нормализация upstream-конфига;
- `src/proxy/config.rs` — загрузка, сохранение, redaction и merge конфигурации;
- `src/proxy/crypto.rs` — AES-256-GCM шифрование секретов конфигурации;
- `src/proxy/opencode.rs` — синхронизация моделей с конфигурацией OpenCode;
- `src/proxy/auth.rs` — проверка proxy token и определение секретных заголовков;
- `src/proxy/metrics.rs` — логи, cooldown snapshot и usage-статистика.

`src/proxy/mod.rs` оставляет публичными только `default_config_path`, `start_server` и
`ServerHandle`. Desktop использует эту библиотеку через `src/lib.rs`; backend не зависит от
Tauri и тестируется без WebView. HTTP-маршруты, JSON-ответы и формат конфигурации сохранены.

Путь запроса: `server` → `handlers`/`chat` → `routing`/`stream`. Конфигурация хранится через
`config` → `crypto`, а интеграция с OpenCode вынесена в `opencode`. Общие данные находятся в
`types`, наблюдаемость — в `metrics`. `frontend/index.html` и отдельный Node.js backend этим
рефакторингом не изменяются.

## Проверки

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo test --no-default-features --locked
```

`src/proxy/tests.rs` содержит unit-тесты, включая запуск без внешнего Tokio runtime.
`tests/http_api.rs` проверяет публичный HTTP API: авторизацию, скрытие секретов, обновление
конфигурации, синхронизацию OpenCode, failover/cooldown и JSON/SSE-ответы. Тестовые провайдеры
слушают localhost; конфигурации и файл OpenCode создаются во временных каталогах. Реальные
API-ключи и настройки пользователя для тестов не нужны.

Проверка кнопок «Чекин» и «Открыть все чекины» в настоящем Linux WebView после сборки:

```bash
python3 tests/checkin_smoke.py
python3 tests/checkin_smoke.py "target/release/bundle/appimage/Provider Proxy Rust_0.1.0_amd64.AppImage"
```

Нужны `WebKitWebDriver`, `xvfb-run` и `dbus-run-session`. Тест использует временный конфиг,
нажимает обе кнопки и перехватывает вызов системного браузера, не открывая внешних сайтов.
Ссылки открываются через native opener только для HTTP/HTTPS; окно прокси остаётся на месте.

## Запуск из исходников

```bash
cargo install tauri-cli --locked
cargo tauri dev
```

Первый аргумент запуска можно использовать как путь к конфигу:

```bash
cargo tauri dev -- ./config.json
```

Также поддерживается `PP_CONFIG_FILE`. Без него приложение использует `config.json` из текущего каталога,
а затем файл в системном каталоге конфигурации `provider-proxy`.

## Ярлык и автоматическая пересборка

Установить два пользовательских ярлыка — `Provider Proxy Rust` и `Provider Proxy npm`:

```bash
./install-shortcuts.sh
```

Ярлык вызывает `launch.sh`. Перед запуском он сравнивает время изменения исходников Rust/Tauri и AppImage.
Если AppImage отсутствует или устарел, выполняется `cargo tauri build -- --locked`, после чего запускается свежая
сборка. Лог сборки находится в `~/.local/state/provider-proxy/rust-desktop-build.log`, лог запуска — в
`~/.local/state/provider-proxy/rust-desktop.log`.

Если старый зашифрованный `config.json` остался без `~/.config/provider-proxy/master.key`, desktop-приложение
теперь всё равно открывает GUI и пишет предупреждение в лог. Расшифровать старые ключи без master key невозможно,
поэтому их нужно заново ввести в настройках провайдеров и сохранить конфигурацию.

## Сборка

```bash
cargo tauri build
```

Для Windows сборку нужно выполнять на Windows или в настроенном cross-compilation окружении. Linux использует
WebKitGTK, Windows — WebView2.

## Конфиг и миграция

Формат конфига совместим с текущей версией проекта: `providers`, `models`, `opencodeModels`, `opencodeConfig`,
`opencodeProvider`, `authToken`, кулдауны и таймауты. Секреты сохраняются в зашифрованном виде AES-256-GCM,
ключ хранится отдельно в системном config-каталоге. Уже существующий `config.json` можно передать первым
аргументом или через `PP_CONFIG_FILE`.
