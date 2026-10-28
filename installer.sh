#!/bin/bash
set -e

echo "============================================="
echo "  Telegram Bot для 3x-ui — Установщик"
echo "============================================="

INSTALL_DIR="${HOME}/tg-bot-3xui"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check/install Node.js
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 18 ]; then
  info "Установка Node.js 20..."
  if command -v apt-get &> /dev/null; then
    apt-get update -y
    apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  elif command -v dnf &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    err "Не удалось установить Node.js. Установите вручную (>=18)."
    exit 1
  fi
fi

info "Node.js: $(node -v), npm: $(npm -v)"

# Interactive setup
echo ""
info "Введите данные для настройки бота:"
echo ""

read -rp "Токен Telegram-бота (@BotFather): " BOT_TOKEN
read -rp "ID администратора (Telegram numeric ID): " ADMIN_TG_ID
read -rp "URL панели 3x-ui (https://host:port): " PANEL_URL
read -rp "Базовый путь панели (пусто = /): " PANEL_BASE_PATH
read -rp "Логин 3x-ui (или пусто если API-токен): " PANEL_USERNAME
read -sp "Пароль 3x-ui (или пусто если API-токен): " PANEL_PASSWORD
echo ""
read -rp "API-токен 3x-ui (Bearer, или пусто): " API_TOKEN
read -rp "ID Telegram-группы (напр. -100xxx, или пусто): " TG_GROUP_ID
read -rp "Лимит трафика по умолчанию, ГБ [100]: " TRAFFIC_GB
TRAFFIC_GB=${TRAFFIC_GB:-100}
read -rp "Домен для webhook (или пусто = polling): " WEBHOOK_DOMAIN
WEBHOOK_SECRET=""
WEBHOOK_PORT=8443
if [ -n "$WEBHOOK_DOMAIN" ]; then
  read -rp "Секрет webhook: " WEBHOOK_SECRET
  read -rp "Порт webhook [8443]: " WEBHOOK_PORT
  WEBHOOK_PORT=${WEBHOOK_PORT:-8443}
fi

if [ -z "$BOT_TOKEN" ] || [ -z "$ADMIN_TG_ID" ] || [ -z "$PANEL_URL" ]; then
  err "Bot token, Admin TG ID и Panel URL обязательны!"
  exit 1
fi

# Create project
mkdir -p "$INSTALL_DIR"/{src/handlers,data}
cd "$INSTALL_DIR"

# Config
cat > data/config.json <<EOCFG
{
  "bot_token": "${BOT_TOKEN}",
  "admin_tg_id": "${ADMIN_TG_ID}",
  "panel_url": "${PANEL_URL}",
  "panel_base_path": "${PANEL_BASE_PATH}",
  "panel_username": "${PANEL_USERNAME}",
  "panel_password": "${PANEL_PASSWORD}",
  "api_token": "${API_TOKEN}",
  "tg_group_id": "${TG_GROUP_ID}",
  "default_traffic_gb": ${TRAFFIC_GB},
  "webhook_domain": "${WEBHOOK_DOMAIN}",
  "webhook_secret": "${WEBHOOK_SECRET}",
  "webhook_port": ${WEBHOOK_PORT}
}
EOCFG
chmod 600 data/config.json
info "Конфигурация сохранена"

# package.json
cat > package.json <<'EOJSON'
{
  "name": "telegram-bot-3x-ui",
  "version": "1.0.0",
  "description": "Telegram bot for 3x-ui panel",
  "main": "src/index.js",
  "scripts": { "start": "node src/index.js", "dev": "node --watch src/index.js" },
  "dependencies": {
    "qrcode": "^1.5.4",
    "sql.js": "^1.11.0",
    "telegraf": "^4.16.3",
    "undici": "^6.19.0"
  },
  "engines": { "node": ">=18.0.0" }
}
EOJSON

# src/config.js
cat > src/config.js <<'EOF'
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

let config = null;

function loadConfig() {
  if (config) return config;
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('Config file not found. Run installer first.');
  }
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return config;
}

function saveConfig(cfg) {
  config = cfg;
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function getConfig() {
  return loadConfig();
}

module.exports = { getConfig, saveConfig };
EOF

# src/database.js
cat > src/database.js <<'EOF'
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileData = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileData);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      tg_username TEXT,
      tg_first_name TEXT,
      email TEXT UNIQUE NOT NULL,
      uuid TEXT NOT NULL,
      sub_id TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 0,
      traffic_limit INTEGER DEFAULT 107374182400,
      used_traffic INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function saveDb() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function rowToObj(cols, vals) {
  const obj = {};
  cols.forEach((c, i) => obj[c] = vals[i]);
  return obj;
}

async function registerUser({ tgId, username, firstName, email, uuid, subId, trafficLimit }) {
  const d = await getDb();
  d.run(
    'INSERT INTO users (tg_id, tg_username, tg_first_name, email, uuid, sub_id, registered_at, traffic_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tgId, username || '', firstName || '', email, uuid, subId, Date.now(), trafficLimit || 107374182400]
  );
  saveDb();
}

async function getUserByTgId(tgId) {
  const d = await getDb();
  const res = d.exec('SELECT * FROM users WHERE tg_id = ' + Number(tgId));
  if (!res.length || !res[0].values.length) return null;
  return rowToObj(res[0].columns, res[0].values[0]);
}

async function getAllUsers() {
  const d = await getDb();
  const res = d.exec('SELECT * FROM users');
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map(vals => rowToObj(cols, vals));
}

async function setActive(tgId, isActive) {
  const d = await getDb();
  d.run('UPDATE users SET is_active = ' + (isActive ? 1 : 0) + ' WHERE tg_id = ' + Number(tgId));
  saveDb();
}

async function deleteUser(tgId) {
  const d = await getDb();
  d.run('DELETE FROM users WHERE tg_id = ' + Number(tgId));
  saveDb();
}

module.exports = {
  getDb,
  saveDb,
  registerUser,
  getUserByTgId,
  getAllUsers,
  setActive,
  deleteUser,
};
EOF

# src/api3xui.js
cat > src/api3xui.js <<'EOF'
const { request } = require('undici');
const { getConfig } = require('./config');

const GiB = 1024 * 1024 * 1024;

let cookies = '';
// 'clients' — 3x-ui >= 3.0: клиент это отдельная сущность, одна общая квота на все инбаунды
// 'legacy'  — 3x-ui 2.x: клиент заводится отдельно в каждом инбаунде
let apiMode = null;

async function login() {
  const cfg = getConfig();
  if (cfg.api_token) {
    apiMode = await probeClientsApi();
    return;
  }

  const baseUrl = cfg.panel_url.replace(/\/$/, '');
  const base = cfg.panel_base_path ? cfg.panel_base_path.replace(/^\//, '') : '';
  const loginPath = base ? `/${base}/login` : '/login';
  const res = await request(`${baseUrl}${loginPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(cfg.panel_username)}&password=${encodeURIComponent(cfg.panel_password)}`,
  });

  const setCookie = res.headers['set-cookie'];
  if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');

  const text = await res.body.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Логин панели не вернул JSON (HTTP ${res.statusCode} по адресу ${loginPath}). ` +
      `Проверьте panel_url и panel_base_path в data/config.json.`
    );
  }
  if (json.success === false) throw new Error('Panel login failed: ' + (json.msg || 'unknown'));
  apiMode = await probeClientsApi();
}

// Панели 2.x отдают на неизвестный путь HTML или пустое тело,
// поэтому режим определяется по наличию JSON-массива в obj.
async function probeClientsApi() {
  try {
    const res = await apiRequest('/panel/api/clients/list');
    if (res && Array.isArray(res.obj)) return 'clients';
  } catch (e) {
    /* неизвестный эндпоинт — старый API */
  }
  return 'legacy';
}

async function apiRequest(path, method = 'GET', body = null, allowRetry = true) {
  const cfg = getConfig();
  const baseUrl = cfg.panel_url.replace(/\/$/, '');
  const base = cfg.panel_base_path ? cfg.panel_base_path.replace(/^\//, '') : '';
  const full = base ? `/${base}${path}` : path;
  const headers = {};
  if (cfg.api_token) headers['Authorization'] = `Bearer ${cfg.api_token}`;
  else if (cookies) headers['Cookie'] = cookies;

  const opts = { method, headers };
  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await request(`${baseUrl}${full}`, opts);
  const text = await res.body.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // Пустой ответ addClient — известная особенность ряда версий панели.
    // Для всех остальных GET-запросов — бросаем понятную ошибку.
    if (res.statusCode === 404) {
      throw new Error(`API 404: ${full} (возможно, неверный panel_base_path или панель не запущена)`);
    }
    return { success: res.statusCode >= 200 && res.statusCode < 300, obj: null, raw: text };
  }

  const sessionExpired = res.statusCode === 401 ||
    (json && json.msg && /login|session/i.test(String(json.msg)));
  if (sessionExpired && allowRetry && !cfg.api_token) {
    await login();
    return apiRequest(path, method, body, false);
  }

  if (res.statusCode === 404) throw new Error(`Not found: ${full}`);
  return json;
}

// Поле totalGB в API панели хранит байты, а не гигабайты
// (в исходниках Total = client.TotalGB пишется прямо в client_traffics.total).
function trafficBytes() {
  const gb = Number(getConfig().default_traffic_gb) || 100;
  return Math.round(gb * GiB);
}

function getApiMode() {
  return apiMode;
}

async function getInbounds() {
  const res = await apiRequest('/panel/api/inbounds/list');
  return res.obj || [];
}

async function getServerStatus() {
  const res = await apiRequest('/panel/api/server/status');
  return res.obj;
}

async function getOnlineCount() {
  if (apiMode === 'clients') {
    const res = await apiRequest('/panel/api/clients/onlines', 'POST', {});
    return Array.isArray(res.obj) ? res.obj : [];
  }
  const res = await apiRequest('/panel/api/inbounds/onlines');
  return Array.isArray(res.obj) ? res.obj : [];
}

/**
 * Регистрация.
 *
 * В режиме 'clients' один POST /clients/add создаёт ОДНУ запись клиента
 * и привязывает её ко всем инбаундам. Таблица client_traffics ключуется по email,
 * поэтому total — единая квота на все инбаунды, а up/down суммируются с любого.
 * Кредиты (uuid/password/...) панель генерирует сама под протокол каждого инбаунда.
 */
async function registerUser({ email, subId, tgId, inboundIds }) {
  const total = trafficBytes();

  if (apiMode === 'clients') {
    const res = await apiRequest('/panel/api/clients/add', 'POST', {
      client: {
        email,
        subId,
        tgId: Number(tgId) || 0,
        enable: false,
        totalGB: total,
        expiryTime: 0,
        limitIp: 0,
        reset: 0,
      },
      inboundIds,
    });
    if (res.success === false) throw new Error(res.msg || 'client create failed');
    const rec = await getClient(email);
    return { uuid: (rec && rec.client && rec.client.uuid) || null, total };
  }

  // 3x-ui 2.x: клиента нужно заводить в каждый инбаунд отдельно.
  const uuid = await getNewUUID();
  if (!uuid) throw new Error('панель не вернула UUID (getNewUUID) — проверьте версию API');

  const inbounds = await getInbounds();
  for (const inbound of inbounds) {
    if (!inboundIds.includes(inbound.id)) continue;
    const settings = JSON.parse(inbound.settings || '{}');
    const client = {
      id: uuid,
      email,
      flow: (settings.clients && settings.clients[0] && settings.clients[0].flow) || '',
      enable: false,
      subId,
      totalGB: total,
      expiryTime: 0,
      tgId: Number(tgId) || 0,
      reset: 0,
    };
    // Панель требует свой credential под каждый протокол
    if (inbound.protocol === 'trojan' || inbound.protocol === 'shadowsocks') {
      client.password = uuid.replace(/-/g, '');
    }
    const r = await apiRequest(`/panel/api/inbounds/${inbound.id}/addClient`, 'POST', client);
    if (r.success === false) throw new Error(r.msg || `addClient failed on inbound ${inbound.id}`);
  }
  return { uuid, total };
}

async function getClient(email) {
  const res = await apiRequest(`/panel/api/clients/get/${encodeURIComponent(email)}`);
  return res.obj;
}

async function getNewUUID() {
  const res = await apiRequest('/panel/api/server/getNewUUID');
  return res.obj;
}

/** Включение/выключение одной командой — действует на все инбаунды клиента. */
async function setClientActive(email, active) {
  if (apiMode === 'clients') {
    const path = active ? '/panel/api/clients/bulkEnable' : '/panel/api/clients/bulkDisable';
    const res = await apiRequest(path, 'POST', { emails: [email] });
    if (res.success === false) throw new Error(res.msg || 'toggle failed');
    return;
  }

  const total = trafficBytes();
  const inbounds = await getInbounds();
  for (const inbound of inbounds) {
    const settings = JSON.parse(inbound.settings || '{}');
    const client = (settings.clients || []).find(c => c.email === email);
    if (!client) continue;
    const clientId = client.id || client.password || client.subId;
    await apiRequest(
      `/panel/api/inbounds/${inbound.id}/updateClient/${encodeURIComponent(clientId)}`,
      'POST',
      { ...client, enable: active, totalGB: total }
    );
  }
}

async function deleteClient(email) {
  if (apiMode === 'clients') {
    const res = await apiRequest(`/panel/api/clients/del/${encodeURIComponent(email)}?keepTraffic=0`, 'POST');
    if (res.success === false) throw new Error(res.msg || 'delete failed');
    return;
  }

  const inbounds = await getInbounds();
  for (const inbound of inbounds) {
    const settings = JSON.parse(inbound.settings || '{}');
    const client = (settings.clients || []).find(c => c.email === email);
    if (!client) continue;
    const clientId = client.id || client.password || client.subId;
    await apiRequest(`/panel/api/inbounds/${inbound.id}/delClient/${encodeURIComponent(clientId)}`, 'POST');
  }
}

async function getClientTraffic(email) {
  if (apiMode === 'clients') {
    const res = await apiRequest(`/panel/api/clients/traffic/${encodeURIComponent(email)}`);
    return res.obj;
  }
  const res = await apiRequest(`/panel/api/inbounds/getClientTraffics/${encodeURIComponent(email)}`);
  return res.obj;
}

/** Панель сама подставляет корректные хост/порт из своих настроек. */
async function getSubscriptionUrl(subId) {
  if (apiMode === 'clients') {
    try {
      const res = await apiRequest(`/panel/api/clients/subLinks/${encodeURIComponent(subId)}`);
      if (Array.isArray(res.obj) && res.obj.length) {
        const first = res.obj[0];
        const url = typeof first === 'string' ? first : (first && first.url);
        if (url) return url;
      }
    } catch (e) {
      /* эндпоинт недоступен — собираем ссылку вручную */
    }
  }
  const cfg = getConfig();
  const subPath = cfg.sub_path || '/sub';
  return `${cfg.panel_url.replace(/\/$/, '')}${subPath}/${subId}`;
}

module.exports = {
  login,
  getApiMode,
  getInbounds,
  getServerStatus,
  getOnlineCount,
  getClientTraffic,
  registerUser,
  getClient,
  getNewUUID,
  setClientActive,
  deleteClient,
  getSubscriptionUrl,
  trafficBytes,
};
EOF

# src/handlers/user.js
cat > src/handlers/user.js <<'EOF'
const QRCode = require('qrcode');
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;

function genSubId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;

  if (await db.getUserByTgId(tgId)) {
    return ctx.reply('ℹ️ Вы уже зарегистрированы. Используйте /my_sub для просмотра подписки.');
  }

  const email = `tg_${tgId}`;
  const subId = genSubId();

  try {
    const inbounds = await api.getInbounds();
    if (!inbounds.length) {
      return ctx.reply('❌ В панели нет ни одного inbound — регистрация невозможна.');
    }
    const inboundIds = inbounds.map(ib => ib.id);

    const { uuid, total } = await api.registerUser({ email, subId, tgId, inboundIds });

    await db.registerUser({
      tgId,
      username: ctx.from.username || '',
      firstName: ctx.from.first_name || '',
      email,
      uuid: uuid || '',
      subId,
      trafficLimit: total,
    });

    // Приглашение в Telegram-группу панели (бот должен быть админом с правом Invite users)
    let groupLine = '';
    if (cfg.tg_group_id) {
      try {
        const link = await ctx.telegram.createChatInviteLink(cfg.tg_group_id, { member_limit: 1 });
        groupLine = `\n👥 Группа: ${link.invite_link}`;
      } catch (e) {
        // Недостаточно прав в группе — пропускаем без ошибки регистрации
      }
    }

    await ctx.reply(
      `✅ Регистрация успешна!\n\n` +
      `📋 Ваш email: ${email}\n` +
      (uuid ? `🔑 UUID: ${uuid}\n` : '') +
      `🌐 Доступно инбаундов: ${inboundIds.length}\n` +
      `📊 Лимит трафика: ${cfg.default_traffic_gb} ГБ — общий на все инбаунды\n` +
      `⏸ Статус: Ожидание активации администратором${groupLine}\n\n` +
      `После активации используйте /my_sub для получения подписки.`
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка регистрации: ${err.message}`);
  }
}

async function cmdMySub(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Используйте /start для регистрации.');
  }
  if (!user.is_active) {
    return ctx.reply('⏸ Ваша подписка ещё не активирована администратором.');
  }

  const subUrl = await api.getSubscriptionUrl(user.sub_id);

  try {
    const qrData = await QRCode.toBuffer(subUrl, { type: 'png', width: 300 });
    await ctx.replyWithPhoto({ source: qrData }, { caption: `📱 QR-код подписки:\n${subUrl}` });
  } catch (e) {
    // не критично, ссылку отправим текстом ниже
  }

  await ctx.reply(
    `🔗 Ссылка подписки:\n${subUrl}\n\n` +
    `Статистика — /stats, список команд — /help`
  );
}

async function cmdStats(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Используйте /start для регистрации.');
  }

  try {
    const traffic = await api.getClientTraffic(user.email);
    if (!traffic) {
      return ctx.reply('📊 Статистика пока недоступна.');
    }

    const used = (traffic.up || 0) + (traffic.down || 0);
    const limit = user.traffic_limit || traffic.total || 0;
    const remaining = Math.max(0, limit - used);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

    await ctx.reply(
      `📊 Статистика подписки\n\n` +
      `📡 Статус: ${traffic.enable ? '🟢 Активен' : '🔴 Неактивен'}\n` +
      `⬆️ Отдано: ${(traffic.up / GiB).toFixed(2)} ГБ\n` +
      `⬇️ Скачано: ${(traffic.down / GiB).toFixed(2)} ГБ\n` +
      `🔄 Израсходовано: ${(used / GiB).toFixed(2)} ГБ (${pct}%)\n` +
      `📏 Лимит: ${(limit / GiB).toFixed(0)} ГБ\n` +
      `✅ Остаток: ${(remaining / GiB).toFixed(2)} ГБ\n\n` +
      `Лимит общий — расходуется суммарно по всем инбаундам.`
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка получения статистики: ${e.message}`);
  }
}

async function cmdHelp(ctx) {
  const cfg = getConfig();

  let msg = `📖 Команды пользователя:\n`;
  msg += `/start — регистрация\n`;
  msg += `/my_sub — получить ссылку и QR-код\n`;
  msg += `/stats — статистика трафика\n`;

  if (String(ctx.from.id) === String(cfg.admin_tg_id)) {
    msg += `\n👑 Команды админа:\n`;
    msg += `/dashboard — панель управления\n`;
    msg += `/users — список пользователей\n`;
    msg += `/enable <tg_id> — активировать\n`;
    msg += `/disable <tg_id> — деактивировать\n`;
    msg += `/broadcast <сообщение> — рассылка всем\n`;
    msg += `/delete <tg_id> — удалить\n`;
  }

  await ctx.reply(msg);
}

module.exports = { cmdStart, cmdMySub, cmdStats, cmdHelp };
EOF

# src/handlers/admin.js
cat > src/handlers/admin.js <<'EOF'
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function fmtGB(bytes) {
  return (bytes / GiB).toFixed(2) + ' ГБ';
}

async function cmdDashboard(ctx) {
  const cfg = getConfig();
  if (String(ctx.from.id) !== String(cfg.admin_tg_id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  try {
    const users = await db.getAllUsers();
    const activeUsers = users.filter(u => u.is_active);
    const status = await api.getServerStatus();
    const inbounds = await api.getInbounds();
    const online = await api.getOnlineCount();

    // Панель отдаёт xray как объект {state, version} и mem как {current, total} в байтах
    const xrayRunning = status && status.xray && status.xray.state === 'running';
    const xrayVer = status && status.xray ? status.xray.version : '';
    const memCur = status && status.mem ? status.mem.current : 0;
    const memTot = status && status.mem ? status.mem.total : 0;

    const mode = api.getApiMode();
    const quotaNote = mode === 'clients'
      ? 'единая квота на все инбаунды'
      : 'legacy API: лимит применяется к каждому инбаунду';

    await ctx.reply(
      `📊 Дашборд панели\n\n` +
      `👥 Всего пользователей: ${users.length}\n` +
      `🟢 Активных: ${activeUsers.length}\n` +
      `🔴 Неактивных: ${users.length - activeUsers.length}\n` +
      `🌐 Онлайн сейчас: ${online.length}\n` +
      `📡 Инбаундов: ${inbounds.length}\n` +
      `🖥 Xray: ${xrayRunning ? '🟢 запущен' : '🔴 остановлен'}${xrayVer ? ' (' + xrayVer + ')' : ''}\n` +
      `💾 CPU: ${status && typeof status.cpu === 'number' ? status.cpu.toFixed(1) + '%' : 'N/A'}\n` +
      `🧠 RAM: ${memTot ? fmtGB(memCur) + ' из ' + fmtGB(memTot) : 'N/A'}\n` +
      `📦 Панель: ${status && status.panelVersion ? status.panelVersion : 'N/A'}\n` +
      `🔌 API: ${mode} (${quotaNote})\n\n` +
      `Команды: /users /enable /disable /broadcast /delete`
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

async function cmdUsers(ctx) {
  const cfg = getConfig();
  if (String(ctx.from.id) !== String(cfg.admin_tg_id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  const users = await db.getAllUsers();
  if (users.length === 0) {
    return ctx.reply('👥 Пользователей пока нет.');
  }

  let msg = `👥 Список пользователей (${users.length}):\n\n`;
  for (const u of users) {
    const status = u.is_active ? '🟢' : '🔴';
    const name = u.tg_first_name || u.tg_username || 'без имени';
    let used = '';
    try {
      const t = await api.getClientTraffic(u.email);
      if (t) used = ` — ${fmtGB((t.up || 0) + (t.down || 0))} из ${fmtGB(u.traffic_limit || 0)}`;
    } catch (e) {
      // у пользователя мог отсутствовать клиент — показываем без трафика
    }
    msg += `${status} ${u.tg_id} — ${name} (@${u.tg_username || 'нет'})${used}\n`;
  }

  await ctx.reply(msg);
}

async function cmdEnable(ctx) {
  const cfg = getConfig();
  if (String(ctx.from.id) !== String(cfg.admin_tg_id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  const text = ctx.message.text;
  const parts = text.split(' ');
  const targetId = parseInt(parts[1]);

  if (!targetId) {
    return ctx.reply('Использование: /enable <tg_id>');
  }

  const user = await db.getUserByTgId(targetId);
  if (!user) {
    return ctx.reply(`❌ Пользователь ${targetId} не найден.`);
  }

  try {
    await api.setClientActive(user.email, true);
    await db.setActive(targetId, true);
    await ctx.reply(`✅ Пользователь ${targetId} активирован.`);

    // Notify user
    try {
      await ctx.telegram.sendMessage(targetId, '🎉 Ваша подписка активирована! Используйте /my_sub для получения ссылки.');
    } catch (e) {
      // user may have blocked bot
    }
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

async function cmdDisable(ctx) {
  const cfg = getConfig();
  if (String(ctx.from.id) !== String(cfg.admin_tg_id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  const text = ctx.message.text;
  const parts = text.split(' ');
  const targetId = parseInt(parts[1]);

  if (!targetId) {
    return ctx.reply('Использование: /disable <tg_id>');
  }

  const user = await db.getUserByTgId(targetId);
  if (!user) {
    return ctx.reply(`❌ Пользователь ${targetId} не найден.`);
  }

  try {
    await api.setClientActive(user.email, false);
    await db.setActive(targetId, false);
    await ctx.reply(`🔴 Пользователь ${targetId} деактивирован.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

async function cmdBroadcast(ctx) {
  const cfg = getConfig();
  if (String(ctx.from.id) !== String(cfg.admin_tg_id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  const text = ctx.message.text;
  const message = text.substring(text.indexOf(' ') + 1);

  if (!message || message === text) {
    return ctx.reply('Использование: /broadcast <сообщение>');
  }

  const users = await db.getAllUsers();
  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      await ctx.telegram.sendMessage(u.tg_id, `📢 ${message}`);
      sent++;
    } catch (e) {
      failed++;
    }
  }

  await ctx.reply(`📢 Рассылка завершена.\n✅ Доставлено: ${sent}\n❌ Не доставлено: ${failed}`);
}

async function cmdDelete(ctx) {
  const cfg = getConfig();
  if (String(ctx.from.id) !== String(cfg.admin_tg_id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  const text = ctx.message.text;
  const parts = text.split(' ');
  const targetId = parseInt(parts[1]);

  if (!targetId) {
    return ctx.reply('Использование: /delete <tg_id>');
  }

  const user = await db.getUserByTgId(targetId);
  if (!user) {
    return ctx.reply(`❌ Пользователь ${targetId} не найден.`);
  }

  try {
    await api.deleteClient(user.email);
    await db.deleteUser(targetId);
    await ctx.reply(`🗑 Пользователь ${targetId} удалён.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

module.exports = { cmdDashboard, cmdUsers, cmdEnable, cmdDisable, cmdBroadcast, cmdDelete };
EOF

# src/index.js
cat > src/index.js <<'EOF'
const { Telegraf } = require('telegraf');
const { getConfig } = require('./config');
const db = require('./database');
const api = require('./api3xui');
const userHandlers = require('./handlers/user');
const adminHandlers = require('./handlers/admin');

async function main() {
  const cfg = getConfig();
  const bot = new Telegraf(cfg.bot_token);

  // Login to 3x-ui panel
  await api.login();
  console.log('✅ Logged in to 3x-ui panel');

  // Set bot commands
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Регистрация' },
    { command: 'my_sub', description: 'Моя подписка' },
    { command: 'stats', description: 'Статистика' },
    { command: 'help', description: 'Помощь' },
  ]);

  // User commands
  bot.start(userHandlers.cmdStart);
  bot.command('my_sub', userHandlers.cmdMySub);
  bot.command('stats', userHandlers.cmdStats);
  bot.command('help', userHandlers.cmdHelp);

  // Admin commands
  bot.command('dashboard', adminHandlers.cmdDashboard);
  bot.command('users', adminHandlers.cmdUsers);
  bot.command('enable', adminHandlers.cmdEnable);
  bot.command('disable', adminHandlers.cmdDisable);
  bot.command('broadcast', adminHandlers.cmdBroadcast);
  bot.command('delete', adminHandlers.cmdDelete);

  // Error handling
  bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply(`❌ Внутренняя ошибка: ${err.message}`);
  });

  // Launch
  const launchOpts = {};
  if (cfg.webhook_domain && cfg.webhook_secret) {
    launchOpts.domain = cfg.webhook_domain;
    launchOpts.secretToken = cfg.webhook_secret;
    launchOpts.port = cfg.webhook_port || 8443;
    launchOpts.healthCheck = { enabled: true, path: '/health' };
  }

  await bot.launch(launchOpts, () => {
    console.log(`🤖 Bot @${bot.botInfo.username} is running`);
    if (launchOpts.domain) {
      console.log(`   Webhook: https://${launchOpts.domain}:${launchOpts.port}`);
    }
  });

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
EOF

# Install dependencies
info "Установка npm-зависимостей..."
npm install --production

# Systemd service
SERVICE_NAME="tg-bot-3xui"
if command -v systemctl &> /dev/null && [ "$(id -u)" = "0" ]; then
  cat > /etc/systemd/system/${SERVICE_NAME}.service <<SVCEOF
[Unit]
Description=Telegram Bot for 3x-ui
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) src/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME}
  info "Systemd-сервис: ${SERVICE_NAME}"
  echo ""
  read -rp "Запустить сейчас? (y/n): " RUN_NOW
  if [ "$RUN_NOW" = "y" ]; then
    systemctl start ${SERVICE_NAME}
    info "✅ Бот запущен!"
  fi
else
  info "Запустите вручную: cd ${INSTALL_DIR} && npm start"
fi

echo ""
echo "============================================="
echo -e "${GREEN}  Установка завершена!${NC}"
echo "============================================="
echo "  Директория: ${INSTALL_DIR}"
echo "  Конфиг:     ${INSTALL_DIR}/data/config.json"
echo ""
echo "  Управление:"
echo "    systemctl start|stop|status|restart ${SERVICE_NAME}"
echo ""
