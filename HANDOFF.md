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
| `fix/ui-layout-adaptive` | переполнение карточек настроек, длинные имена провайдеров, `dvh` |
| `feat/split-shortcuts` | две кнопки: ярлык в меню приложений и на рабочем столе |
| `feat/tray-autostart` | тумблер «стартовать свёрнутым в трей» (`--tray`) для Windows и Linux |
| `integration/all-fixes` | все ветки вместе; конфликтов по смыслу нет |

Конфликт при слиянии был один и только в CSS: строка `.legend-name`
(статистика) и строка `.legend-dot.skipped`. Обе сохранены.

## Откат

```bash
git checkout master
git branch -D fix/stream-tool-calls fix/usage-stats feat/usage-lifetime-tokens \
  fix/ui-layout-adaptive feat/split-shortcuts feat/tray-autostart integration/all-fixes
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
Чтобы правка заработала, бинарник нужно пересобрать из `integration/all-fixes`.

## Ограничение окружения

Полная GUI-сборка (`cargo build`, `cargo check` с фичей `desktop`) здесь не
проходит: нет `webkit2gtk4.1-devel` (нужен sudo). Поэтому `main.rs` проверен
изолированными тестами логики (команда автозапуска, генерация `.desktop` с
`--tray`, sidecar-файл выбора трея) для обеих ОС. Библиотечная часть
(`cargo test --no-default-features --lib`, 14 тестов) собирается и проходит.
