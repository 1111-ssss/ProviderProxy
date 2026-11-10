# HANDOFF — работа начата на другом ПК

> Этот файл нужен, чтобы не потерять точку отката. Если что-то пошло не так —
> откатывайся на `master` (коммит ниже) и удаляй ветки из списка.

## Базовая точка

```
ветка:  master
коммит: ea35f7691511544cbe484d86335dcb3bd84dc7f6
версия: app-v0.1.5
```

Состояние на этой точке — чистый клон с GitHub, без локальных правок.
Всё, что ниже, сделано поверх неё отдельными ветками: одна фича — одна ветка.

## Ветки

| Ветка | Что меняет |
| --- | --- |
| `fix/stream-tool-calls` | паника на кириллице (ответ обрывался без ошибки) и дубли `tool_call` |
| `fix/usage-stats` | «пропущено из-за кулдауна» отделено от ошибок провайдера |
| `feat/usage-lifetime-tokens` | токены за всё время — отдельный счётчик, не сумма 7 дней |
| `fix/ui-layout-adaptive` | переполнение карточек настроек, длинные имена провайдеров, `dvh`, схлопывание формы изображений и карточек цепочек |
| `feat/split-shortcuts` | две кнопки: ярлык в меню приложений и на рабочем столе |
| `feat/tray-autostart` | тумблер «стартовать свёрнутым в трей» (`--tray`) для Windows и Linux |
| `fix/autostart-tray-permission` | тумблер трея блокировался ACL, автозапуск брал пустую базу, второй запуск не вытеснял первый |
| `integration/all-fixes` | все ветки вместе; конфликтов по смыслу нет |

Конфликт при слиянии был один и только в CSS: строка `.legend-name`
(статистика) и строка `.legend-dot.skipped`. Обе сохранены.

## Откат

```bash
git checkout master
git branch -D fix/stream-tool-calls fix/usage-stats feat/usage-lifetime-tokens \
  fix/ui-layout-adaptive feat/split-shortcuts feat/tray-autostart \
  fix/autostart-tray-permission integration/all-fixes
```

## Проверки перед коммитом

```bash
cd rust-desktop && cargo check --no-default-features --lib
cd rust-desktop && cargo test --no-default-features --lib
node --test frontend.test.mjs
node test.mjs          # smoke-тест Node-версии прокси
```

## Запущенное приложение

`~/workspace/projects/pet/provider_proxy_binary/provider-proxy-desktop` — сборка
от 2026-11-04. Она **старше** этих правок и падает с

```
panicked at src/proxy/stream.rs:341:36:
start byte index 269 is not a char boundary; it is inside 'о'
```

на каждом длинном русском ответе: поток умирает, клиент видит конец ответа,
нейросеть останавливается на середине. Именно это чинит `fix/stream-tool-calls`.

Пересобранный бинарник лежит в
`rust-desktop/target/release/provider-proxy-desktop` (ветка
`integration/all-fixes`) и проверен запуском на отдельном порту:

- 400 чанков кириллицы (105 КБ) пришли целиком, с `[DONE]`, без `proxy_stream_error`;
- два tool call получили индексы 0 и 1, аргументы не склеились;
- `skipped` отделён от `failed` (2 провала, из них 1 — кулдаун);
- `lifetimeTokens` считается и отдаётся в `/api/usage`;
- живые `8787` и новый `8799` работали одновременно, твой процесс не задет.

Бинарник **не подменял**. Замена — одна команда, когда решишь:

```bash
cp rust-desktop/target/release/provider-proxy-desktop \
   ~/workspace/projects/pet/provider_proxy_binary/provider-proxy-desktop
```

## Что было сломано в тестах и починено

`serves_the_desktop_api_from_a_local_port` вызывал `/api/config/import`, а тот
делает `sync_opencode` и при отсутствии `opencodeConfig` пишет в **настоящий**
`~/.config/opencode/opencode.jsonc`. Прогон тестов подменял список моделей
тестовой моделью `one`. Теперь тест указывает временный файл, а неизменность
настоящего конфига проверена замером mtime и размера до/после.

## Ограничение окружения

Полная GUI-сборка теперь проходит: `webkit2gtk4.1-devel` установлен, `cargo check`
и `cargo build --release --locked` собираются за ~4 минуты. `cargo test
--no-default-features --lib` — 15 тестов, все зелёные.
