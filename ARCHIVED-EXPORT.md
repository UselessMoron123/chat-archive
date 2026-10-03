# Экспорт архивных чатов Arena.ai — версия 2.3.2

| Файл | Что умеет |
|---|---|
| `Arena.ai - LMSYS Arena Chat Exporter-2.3.1.user.js` | базовая версия (архив не видит) |
| `Arena.ai - LMSYS Arena Chat Exporter-2.3.2.user.js` | **текущая**: экспорт архива — Scope, пометки, `archivedAt`, список в JSON |

## Почему архивные чаты не попадали в экспорт

В версии 2.3.1 список истории запрашивался так (жёстко зашито в коде):

```
GET /api/history/unified?limit=20&includeArchived=false
```

Поэтому в список экспортёра попадали только активные чаты, и архивные приходилось
выводить из архива по одному.

В бандле самого сайта Arena видно, что у этого API есть параметры `includeArchived` и
`archivedOnly`, а каждая запись списка содержит поле `archivedAt`. Фильтр «Archived» в
интерфейсе Arena — это тот же запрос с `archivedOnly=true`. Значит, для экспорта архива
**разархивировать чаты не нужно**: достаточно попросить список вместе с архивными.

## Что нового в 2.3.2

- Селектор **Scope** в панели экспорта:
  - `Active + archived` — по умолчанию;
  - `Active only` — прежнее поведение 2.3.1;
  - `Archived only` — только архив.
- В списке у архивных чатов пометка `archived <дата>`.
- Счётчики: `Loaded N conversations (X archived)`, `N selected (X archived)`.
- `manifest.json` в ZIP: `archivedCount`, `listScope`, полный `selectedItems`
  (id, тип, заголовок, `archivedAt`), а также `archivedAt` в `successfulExports`/`failedExports`.
- `archivedAt` в JSON-записи (верхний уровень) и строка `Archived : ...` в TXT-шапке.
- Кнопка **Save list JSON** — выгрузка загруженного списка (id, тип, заголовок, даты,
  флаг архива). Удобно сверять с уже сохранённым архивом и видеть, чего не хватает.
- Если API не вернул `archivedAt`, значение подставляется из списка; добавлена защита от
  зацикливания пагинации по повторяющемуся курсору.
- Версия 2.3.1 не изменена — откат делается её переустановкой.

## Как пользоваться

1. Обновить скрипт в Tampermonkey (добавить/заменить на v2.3.2).
2. Открыть arena.ai (любой чат или список), нажать кнопку **Export** справа.
3. Выбрать Scope: `Active + archived` или `Archived only`.
4. **Fetch list** → дождаться `Loaded N conversations (X archived)`.
5. (по желанию) **Save list JSON** — сохранить список для сверки.
6. **Select all** → **Export selected JSON** — основной архив (ZIP с `manifest.json`).
   При необходимости повторить с TXT.
7. Первый прогон лучше сделать на 2–3 архивных чатах и проверить в `manifest.json`,
   что `failedCount` = 0.

Экспорт ничего не меняет в аккаунте: ни разархивирования, ни удаления — только чтение.

## Быстрая проверка API (если что-то не так)

Консоль браузера на arena.ai, будучи залогиненным:

```js
// список вместе с архивными
const r = await fetch('/api/history/unified?limit=50&includeArchived=true', {
  credentials: 'include',
}).then((x) => x.json());
console.log('всего:', r.entries.length,
            'архивных:', r.entries.filter((e) => e.archivedAt).length,
            r.pagination);

// только архивные (то же, что делает фильтр «Archived» в интерфейсе)
const a = await fetch('/api/history/unified?limit=50&archivedOnly=true', {
  credentials: 'include',
}).then((x) => x.json());
console.log(a.entries.map((e) => [e.type, e.id, e.archivedAt, e.title].join(' | ')).join('\n'),
            a.pagination);
```

При ошибках экспорта смотрите `failedExports` в `manifest.json` и консоль браузера
(сообщения с тегом `[arena-chat-export]`).

## Ориентир по объёму

В сохранённой странице `Search Chats - Arena.htm` (фильтр «Archived») видно
228 архивных сессий: 193 обычных (`/c/...`) и 35 агентных (`/agent/...`).

## Проверено на реальных данных

- `latest try` (12 ZIP, TXT, v2.3.2): 244 беседы, 239 архивных, 0 неуспешных экспортов,
  0 регрессий против прежней выгрузки, полное совпадение со списком аккаунта.
- `latest try_json` (4 ZIP, JSON, v2.3.2): те же 244 беседы, наборы id и вызовов
  инструментов совпадают с TXT побитово; 0 регрессий.

Архивные агентные чаты выгружаются этим же путём — обходной сценарий
с разархивированием **(unarchive → export → archive) не понадобился**.

Отчёты: `latest try/AUDIT-v2.3.2.md`, `latest try_json/AUDIT-json.md`.

## Инструменты в репозитории

```bash
python3 tools/audit_export.py --zips "<папка или zip>" --list "<list.json>" [--baseline <старые zip>]

npm install          # один раз, для тестов
npm test             # jsdom-тесты экспортёра (12/12 для 2.3.2)
```

Если что-то всё же не выгружается, пришлите `failedExports` из `manifest.json`
и сообщения из консоли браузера с тегом `[arena-chat-export]`.
