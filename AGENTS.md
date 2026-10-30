# AGENTS.md — инструкция для AI-агентов

## О проекте

Telegram-бот для панели [3x-ui](https://github.com/MHSanaei/3x-ui): саморегистрация пользователей,
активация админом, подписка/QR/статистика, рассылка, дашборд,
фоновая синхронизация со ВСЕМИ клиентами панели.
Стек: Node.js ≥18, CommonJS, telegraf 4, sql.js (WebAssembly SQLite), undici, qrcode.

## Структура

```
src/index.js            — точка входа, регистрация команд, bot.action(...) для inline-кнопок, старт sync
src/config.js           — чтение data/config.json (кэшируется; дефолты для новых полей — здесь)
src/database.js         — sql.js: таблицы users и panel_clients, миграции через PRAGMA table_info
src/api3xui.js          — клиент API 3x-ui: детект режима, CRUD клиентов, трафик, статус, subURI
src/sync.js             — периодический опрос панели: снимок клиентов, статусы, импорт ручных, уведомления
src/setupGroups.js      — шаг установщика: показать клиентов/группы панели, выбрать группу для новых
src/handlers/user.js    — /start /my_sub /sub /stats /help + callback'и grp:/sub:/menu:
src/handlers/admin.js   — /dashboard /users /enable /disable /broadcast /delete /setgroup + callback'и adm:
installer.sh            — интерактивная установка; СОДЕРЖИТ ВСТРОЕННЫЕ КОПИИ src/*.js (см. ниже)
data/                   — config.json и bot.db (в .gitignore, НИКОГДА не коммитить)
```

## КРИТИЧНЫЕ ПРАВИЛА

### 1. installer.sh дублирует исходники
Внутри `installer.sh` — heredoc-блоки `cat > src/... <<'EOF'` с полными копиями всех восьми
файлов из `src/` (config, database, api3xui, sync, setupGroups, handlers/user, handlers/admin, index).
**После любого изменения `src/*.js` обязателен пересинхрон**, иначе установщик
развернёт устаревший код. Быстрый способ: скрипт, который для каждого файла заменяет блок
регекспом `cat > <файл> <<'EOF' ... EOF` актуальным содержимым (новый файл — вставить пустой блок
перед `cat > src/index.js <<'EOF'`). После — `bash -n installer.sh` и сверка строгого равенства блоков.

### 2. Два режима API панели (детект автоматический)
- **`clients`** (3x-ui ≥3.0): клиент — отдельная сущность. `POST /panel/api/clients/add` с
  `{client:{email,subId,tgId,enable,totalGB,expiryTime,limitIp,reset,group}, inboundIds:[...]}` —
  ОДНА запись на пользователя, привязанная ко всем инбаундам. Таблица `client_traffics` ключуется
  по email (UNIQUE) → **totalGB = единая квота на все инбаунды** (главная фича проекта).
  Вкл/выкл: `bulkEnable`/`bulkDisable {emails:[]}`. Удаление: `del/{email}?keepTraffic=0`.
  `getPanelClients()` берёт `enable` из `traffic.enable`, а не из `client.enable`.
- **`legacy`** (2.x): клиент заводится в каждый инбаунд отдельно (`inbounds/{id}/addClient`),
  лимит на каждый инбаунд свой. Фолбэк, не developing target — новую логику сюда не добавлять.
Режим определяется в `probeClientsApi()`: JSON-массив в obj у `/clients/list` → clients.

### 3. Экраны и поля API
- **`totalGB` содержит БАЙТЫ, а не гигабайты** (100 ГБ = 107374182400). `trafficBytes()` пересчитывает.
- `server/status`: `xray` — объект `{state:'running', version}`, `mem` — `{current,total}` байт.
- Пустой JSON-ответ у add-эндпоинтов — известная особенность панели; `apiRequest` возвращает
  `{success: по HTTP-коду, obj:null}` вместо падения парсера.
- **`/clients/subLinks/{subId}` НЕИСПОЛЬЗУЕМ** — он отдаёт конфиги (vless://…), а не ссылку
  подписки.
- **Ссылка подписки ≠ `panel_url` + `sub_path`.** Базовый адрес берётся из
  `POST /panel/api/setting/all` → поле `subURI` (готовый адрес из subDomain/subPort/subPath/TLS
  настроек панели). `getSubscriptionBase()` кэширует его в `subBaseCache`; фолбеки — сборка из
  `subDomain/subPort/subPath`, и только потом `panel_url + sub_path`. Пример: панель на `:42203`,
  подписка на `https://host:40840/x_wEG0r1YC/{subId}`.
- `GET /panel/api/clients/get/tgId/{id}` — клиент по Telegram ID (`getClientByTgId`, с фолбеком
  перебором `getPanelClients()`).
- Поле `group` у клиента — имя группы в веб-интерфейсе панели; при регистрации передаётся
  `panel_client_group` из конфига (по умолчанию `Telegram`). Панель создаёт группу сама при
  первом клиенте с таким именем — отдельно заводить её не нужно.
- `getClientGroups()` — группы панели с числом клиентов (пустое имя = «без группы», сортировка по
  количеству). Используется установщиком (`src/setupGroups.js`) и `/setgroup`.

### 4. Группа клиентов: настройка и /setgroup
- Установщик после `npm install` запускает `node src/setupGroups.js`: показывает клиентов и группы
  панели, даёт выбрать существующую (номер), создать новую (`n<имя>`), сбросить (`-`) или оставить
  (Enter). Неинтерактивный запуск/недоступная панель — не ошибка, дефолт сохраняется.
  Тесты форсируют интерактив через `SETUP_INTERACTIVE=1`.
- `/setgroup` (admin): без аргумента — экран групп со ссылками-командами и кнопкой `adm:group`;
  с аргументом — запись в `panel_client_group` через `saveConfig()` (действует сразу, без рестарта).
  **Sentinel `-` означает «без группы»**, т.к. пустой аргумент открывает экран. Пустая строка в
  конфиге — осознанный выбор, а не «не задано» (в `setupGroups.js` — функция `currentGroup()`).
- Меняется только группа НОВЫХ клиентов; существующих бот не переносит (экран и `/setgroup`
  предупреждают).

### 5. Панель — источник истины о статусе (src/sync.js)
`syncOnce(telegram)` вызывается при старте бота и каждые `sync_interval_sec`:
1. `getPanelClients()` → снимок в таблицу `panel_clients` (email PK, `notified` против дублей);
2. `is_active` в `users` приводится к `enable` из панели (включили вручную в веб-UI → бот показывает
   активно, и наоборот);
3. новый клиент с ненулевым `tgId` импортируется в `users` (`group_joined=1` ставится для
   совместимости со старыми базами), после чего он пользуется `/my_sub`/`/stats`/QR без `/start`;
4. админу шлётся `🆕 Новый клиент в панели` с inline-кнопкой `adm:tgl:on|off:<email>`.

Аналогично `refreshStatus(user)` в `user.js` — точечная сверка с `getClientTraffic().enable` перед
`/my_sub` и `/stats`, не ждём следующего тика синхронизации.

**Клиента удалили в веб-интерфейсе панели** — запись в `users` остаётся, и без обработки бот
отдавал бы ссылку подписки, которая уже не работает:
- `api.clientExists(email)` → `true` / `false` / `null` (нет определённого ответа — статус не трогаем,
  сбой API не должен массово деактивировать подписки);
- `refreshStatus`: нет строки трафика И клиент точно отсутствует в панели → `is_active = 0` и
  флаг `panelMissing` (не сохраняется в БД, только в объекте) → `/my_sub`, `/stats`, `sub:qr`
  отвечают «⚠️ Ваша подписка больше не найдена в панели»;
- `syncOnce`: то же для всех активных пользователей на каждом тике;
- **восстановление**: `/start` при записи в базе сначала проверяет `clientExists(email)` — если
  клиента в панели точно нет, `recoverSubscription()` пересоздаёт его с **прежними email и
  `sub_id`** (ссылка подписки и QR не меняются!) и прежним `traffic_limit`, `enable:false` —
  активация снова за админом. Тот же путь — по кнопке `sub:recover` («♻️ Восстановить подписку»),
  которую показывают `subscriptionGone()` из `/my_sub`, `/stats`, QR. В БД это `db.resetUserClient()`
  (UPDATE uuid/sub_id/is_active=0/traffic_limit), НЕ `deleteUser + addUser` — иначе потеряется
  `group_joined` и имя;
- `/delete` не падает, если в панели записи уже нет (`isNotFound()` по сообщению панели) —
  строка из `users` удаляется в любом случае; `/enable` отсутствующего клиента даёт внятную ошибку
  с подсказкой `/delete <email>`.

**Вручную базу править нельзя без остановки сервиса**: `sql.js` держит образ БД в памяти и
перезаписывает `data/bot.db` целиком при каждом `saveDb()` (в т.ч. на каждом тике синхронизации),
так что удаление «на живом» боте может быть перезаписано. Порядок: `systemctl stop` → правка → `start`.

### 6. panel_base_path применяется ко ВСЕМ запросам
Все маршруты панели (и `/login`, и `/panel/api/*`) зарегистрированы gin под базовым путём.
В `apiRequest` путь строится как `{base}{path}`. Забыть об этом = 404 с пустым телом =
«Unexpected end of JSON input» в логах.

### 7. Миграции БД — в getDb()
Схема создаётся `CREATE TABLE IF NOT EXISTS`, новые колонки добавляются проверкой
`PRAGMA table_info(users)` + `ALTER TABLE ADD COLUMN`. Новый колончатый код должен
учитывать, что в старых базах колонок нет до первой миграции. `better-sqlite3` не использовать —
не компилируется без node-gyp/Xcode CLT, только `sql.js`.

### 8. Telegram-группа — факультативно
`tg_group_id` и `group_link` задаются в конфиге (по желанию). Если заданы — в главном меню
появляется кнопка «👥 Наша группа» с ссылкой `group_link`. Вступление **не проверяется**,
`group_joined` не влияет на выдачу подписки, QR, статистики.
`group_joined` остаётся в БД для обратной совместимости и для клиентов, импортированных из панели.

### 9. Inline-кнопки и ссылки-команды
- `callback_data` ≤ 64 байт — email клиента проверяется (`Buffer.byteLength <= 55`) перед
  кнопкой `adm:tgl:on|off:<email>`.
- Префиксы: `menu:` (главное меню), `sub:qr`, `sub:recover` — в `user.onMenuCallback /
  onQrButton / onRecoverButton`; `adm:` (users, toggle, dashboard, group) —
  в `admin.onAdminCallback`. Новые кнопки регистрировать через `bot.action(/^префикс:.+$/, ...)`
  в `src/index.js`.
- **`/users` выводит АБСОЛЮТНО ВСЕХ клиентов панели — пагинации нет.** Telegram режет длину
  сообщения, поэтому блоки склеиваются по `MAX_MESSAGE = 3600` символов и отправляются
  несколькими сообщениями с заголовком `👥 Все клиенты панели: N` и меткой `📄 Часть i из N`;
  между частями — `sleep(1100)` против лимита 429. Inline-кнопки (`adm:users`) остаются только
  навигационными и только на последнем сообщении.
- **В `/users` переключение клиента — НЕ inline-кнопкой, а ссылкой-командой**
  `https://t.me/{bot}?text=%2Fenable%20<email>` (`cmdLink` в admin.js, `encodeURIComponent`).
  Inline остаются навигация (`adm:users`, `adm:dashboard`, `adm:group`) и кнопка в
  уведомлении о новом клиенте. Аргумент `/enable|/disable|/delete` — `tg_id` **или** email:
  разрешается через `resolveEmail()` (users → getClientByTgId → как есть).
- Текст `/help` НЕ должен содержать админ-команд; они выводятся в `/dashboard`.

## Стиль кода

- CommonJS (`require`/`module.exports`), без transpiler-синтаксиса.
- Комментарии и строки для пользователя — на русском; идентификаторы — на английском.
- Все функции БД и API — async; ошибки handler'ы ловят сами и отвечают `ctx.reply('❌ ...')`.
- Проверка админа — `isAdmin(ctx)` по `admin_tg_id` из конфига (сравнение строк).
- Константы GiB/MiB определять в верху файла, не инлайном.

## Проверка изменений (обязательный минимум)

1. `node --check` каждого изменённого файла.
2. Мок-панель (пример: `/tmp/mock3x.js`, порт 45999) — HTTP-заглушка с эндпоинтами clients-API,
   `__inject` для трафика, `__panel_add` (с параметром `group`)/`__panel_toggle`/`__panel_del` для
   имитации ручных клиентов, веб-тоглов и удалений, `__reset` для очистки перед тестом,
   `setting/all` с `subURI` на ДРУГОМ порту/пути. Мок обязан срезать базовый путь:
   `url.split('/panel/api')[1]`, иначе запросы с `panel_base_path` дадут 404.
   Временно pointing `panel_url` в config.json на мок (+`tg_group_id`, `group_link`).
   Каждый тест начинается с `__reset` и своего чистого `data/config.json` + `rm data/bot.db`,
   иначе состояние мока и кэш `getConfig()` протекают между прогонами.
3. E2E с фейковым ctx (объект с `from/message/callbackQuery/reply/replyWithPhoto/answerCbQuery/telegram`)
   прогоняет: /start (проверка `group` клиента панели; с заполненными `tg_group_id`/`group_link`
   в конфиге — тексты НЕ должны упоминать вступление) → /enable → /my_sub (ссылка = `subURI`
   панели, НЕ `panel_url`, НЕ `vless://`) → /stats → /users (ссылки-команды, все клиенты панели) →
   syncOnce (уведомление админа + отсутствие дублей) → панельный toggle → статус в боте → adm:tgl →
   /broadcast → /delete. Плюс: `__panel_del` → «не найдена в панели» в /sub, /stats, QR → /delete
   чистит базу; `/setgroup` (экран/смена/`-`/длинное имя/не-админ) → новая регистрация в выбранную
    группу без рестарта; `node src/setupGroups.js --print|--set` и интерактив через `SETUP_INTERACTIVE=1`.
    Отдельно проверять: `/start` после `__panel_del` пересоздаёт клиента с ТЕМ ЖЕ `sub_id` и
    `enable:false` (ссылка не меняется), кнопка `sub:recover`, `/start` живого клиента не пересоздаёт;
    `/users` на 25+ клиентах — сообщений несколько, но показаны ВСЕ email, длина каждого ≤ лимита.
4. Тест единой квоты: registerUser → inject up/down с «разных инбаундов» → used = up+down из ОДНОЙ
   строки traffic, remaining = total − used.
5. Пересинхрон installer.sh + `bash -n installer.sh` + сверка блоков с src (строгое равенство).
6. Вернуть оригинальный `data/config.json` после тестов, удалить временные файлы.

## Чего НЕ делать

- Не коммитить `data/` (секреты), не логировать `api_token`/`panel_password`.
- Не менять git-историю и не пушить без явного запроса пользователя.
- Не переписывать legacy-ветку логики ради новых фич — только поддерживать совместимость.
- Не заменять sql.js на нативный sqlite, не добавлять node-gyp-зависимости.
- Не вызывать `res.body.json()` напрямую — только через `apiRequest` (пустые тела, ре-логин 401).

## Обновление на проде (справка)

Сервер: `/root/tg-bot-3xui` — git-репозиторий с `origin` на GitHub.
Обновление: `git pull && systemctl restart tg-bot-3xui` (зависимости менялись не всегда —
`npm install --production` только если менялся `package.json`).
`data/` в `.gitignore` — pull его не трогает.
