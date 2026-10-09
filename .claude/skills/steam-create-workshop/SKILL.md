---
name: steam-create-workshop
description: Готовит Loom-мод к загрузке в Steam Workshop — собирает папку <кит>/Workshop/<Мод> с content (pak и .uplugin из установленного мода), шаблонным <Мод>.vdf, заглушкой preview.png, sync.bat и upload.bat. Повторный запуск обновляет content и сохраняет .vdf с publishedfileid. Используй, когда пользователь просит подготовить мод к Workshop / Стиму или обновить Workshop-папку мода.
user-invocable: true
argument-hint: <мод>
---

# Папка Workshop для Loom-мода

```
<кит>/Workshop/<Мод>/
  content/<Мод>.pak         из <saved>/mods/<Мод>/ — то, что поставил ww_loom_install
  content/<Мод>.uplugin
  preview.png               заглушка 512×512, если превью ещё нет
  <Мод>.vdf                 шаблон: title из .uplugin, description и changenote с TODO
  sync.bat                  повторно копирует установленный мод в content
  upload.bat                steamcmd +workshop_build_item <Мод>.vdf
```

Тексты карточки, превью и загрузку человек делает сам: кроме имени мода ничего не спрашивай,
описаний не сочиняй, steamcmd и `upload.bat` не запускай.

## Шаги

1. Мод: `$ARGUMENTS` — имя папки в `<кит>/Content/Mods`. Если пусто и из разговора мод не
   ясен — не угадывай: перечисли папки `<кит>/Content/Mods` и спроси через AskUserQuestion,
   какой из них (самые свежие по правкам — первыми).
2. `ww_loom_install action=status mod_name=<Мод>`:
   - `installed` — дальше;
   - `ready_to_install` — `ww_loom_install action=install mod_name=<Мод>`, потом дальше;
   - пака нет — сначала сборка (`ww_loom_validate` → `ww_loom_build` → `ww_loom_install`).
3. `bun run --silent workshop:create <Мод>`

Скрипт сам: пересоздаёт `content/`, существующий `.vdf` сохраняет как есть (меняются только
пути), существующие превью и `.bat` не трогает, путь к steamcmd для нового `upload.bat`
берёт из соседних папок Workshop. Ключи нужны редко: `--preview <файл>` — своя картинка
вместо заглушки, `--steamcmd <путь>`, `--rewrite-scripts`, `--dry-run`.

## Ответ

Скрипт напечатал только `Готово: <папка>` — ответь одной строкой «Готово» с путём к папке.
Если были строки `внимание:` или ошибка — перескажи их коротко и что с ними сделать.
