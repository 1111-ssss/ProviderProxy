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
| `fix/ui-layout-adaptive` | вёрстка: переполнение в настройках, адаптивность, dvh, широкие таблицы |
| `feat/tray-autostart` | автозапуск сразу в трее (`--tray`) + переключатель в настройках |
| `feat/split-shortcuts` | отдельные кнопки «ярлык на рабочем столе» и «ярлык в меню приложений» |
| `fix/usage-stats` | статистика: успешные/ошибки считаются согласованно |
| `feat/usage-lifetime-tokens` | плитка «токенов за всё время» в статистике |
| `fix/stream-tool-calls` | дублирование tool_call в SSE и обрыв потока посреди ответа |

## Откат

```bash
git checkout master
git branch -D fix/ui-layout-adaptive feat/tray-autostart feat/split-shortcuts \
  fix/usage-stats feat/usage-lifetime-tokens fix/stream-tool-calls
```

## Проверки перед коммитом

```bash
cd rust-desktop && cargo check --no-default-features --lib
cd rust-desktop && cargo test --no-default-features --lib
node --test frontend.test.mjs
node test.mjs          # smoke-тест Node-версии прокси
```
