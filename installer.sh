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
GROUP_LINK=""
if [ -n "$TG_GROUP_ID" ]; then
  read -rp "Публичная ссылка группы (напр. https://t.me/mygroup, или пусто): " GROUP_LINK
fi
read -rp "Лимит трафика по умолчанию, ГБ [100]: " TRAFFIC_GB
TRAFFIC_GB=${TRAFFIC_GB:-100}
read -rp "Путь подписки в панели [sub]: " SUB_PATH
SUB_PATH=${SUB_PATH:-sub}
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
  "group_link": "${GROUP_LINK}",
  "default_traffic_gb": ${TRAFFIC_GB},
  "sub_path": "/${SUB_PATH}",
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
  // Значения по умолчанию для полей, добавленных после установки
  if (config.sub_path === undefined) config.sub_path = '/sub';
  if (config.group_link === undefined) config.group_link = '';
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
      used_traffic INTEGER DEFAULT 0,
      group_joined INTEGER DEFAULT 0,
      group_invite_link TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Миграция для баз, созданных до появления обязательной привязки к группе
  const cols = db.exec('PRAGMA table_info(users)');
  const names = cols.length ? cols[0].values.map(v => v[1]) : [];
  if (!names.includes('group_joined')) {
    db.run('ALTER TABLE users ADD COLUMN group_joined INTEGER DEFAULT 0');
    saveDb();
  }
  if (!names.includes('group_invite_link')) {
    db.run('ALTER TABLE users ADD COLUMN group_invite_link TEXT');
    saveDb();
  }
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

async function setGroupJoined(tgId, joined, inviteLink) {
  const d = await getDb();
  const link = inviteLink ? `'${String(inviteLink).replace(/'/g, "''")}'` : 'NULL';
  d.run(
    'UPDATE users SET group_joined = ' + (joined ? 1 : 0) + ', group_invite_link = ' + link +
    ' WHERE tg_id = ' + Number(tgId)
  );
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
  setGroupJoined,
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

/**
 * Ссылка именно на ПОДПИСКУ (sub), а не на конфигурацию.
 * Эндпоинт /clients/subLinks отдаёт готовые конфиги (vless://, trojan://),
 * поэтому ссылка собирается вручную из настроек панели: {panel_url}{sub_path}/{subId}.
 */
async function getSubscriptionUrl(subId) {
  const cfg = getConfig();
  const subPath = (cfg.sub_path || '/sub').replace(/\/+$/, '');
  return `${cfg.panel_url.replace(/\/$/, '')}${subPath}/${subId}`;
}

/**
 * Все клиенты панели (не только зарегистрированные ботом).
 * В clients-режиме /clients/list отдаёт сразу всех; в legacy клиенты
 * лежат внутри settings каждого инбаунда.
 */
async function getPanelClients() {
  if (apiMode === 'clients') {
    const res = await apiRequest('/panel/api/clients/list');
    const rows = Array.isArray(res.obj) ? res.obj : [];
    return rows.map(c => ({
      email: c.email,
      subId: c.subId || '',
      uuid: c.uuid || c.id || '',
      tgId: c.tgId || 0,
      enable: !!c.enable,
      total: c.totalGB || (c.traffic && c.traffic.total) || 0,
      up: (c.traffic && c.traffic.up) || 0,
      down: (c.traffic && c.traffic.down) || 0,
      expiryTime: c.expiryTime || 0,
      comment: c.comment || '',
      online: false,
    }));
  }

  const inbounds = await getInbounds();
  const byEmail = new Map();
  for (const inbound of inbounds) {
    let settings;
    try {
      settings = JSON.parse(inbound.settings || '{}');
    } catch (e) {
      continue;
    }
    for (const c of settings.clients || []) {
      if (!c.email) continue;
      if (!byEmail.has(c.email)) {
        byEmail.set(c.email, {
          email: c.email,
          subId: c.subId || '',
          uuid: c.id || c.password || '',
          tgId: Number(c.tgId) || 0,
          enable: !!c.enable,
          total: c.totalGB || 0,
          up: 0,
          down: 0,
          expiryTime: c.expiryTime || 0,
          comment: c.comment || '',
          online: false,
        });
      }
    }
  }

  // В 2.x трафик хранится отдельной строкой на email — он и даёт общую картину
  for (const [email, c] of byEmail) {
    try {
      const t = await getClientTraffic(email);
      if (t) {
        c.up = t.up || 0;
        c.down = t.down || 0;
        c.enable = t.enable !== undefined ? !!t.enable : c.enable;
        if (t.total) c.total = t.total;
      }
    } catch (e) {
      /* статистики ещё нет */
    }
  }
  return [...byEmail.values()];
}

module.exports = {
  login,
  getApiMode,
  getInbounds,
  getServerStatus,
  getOnlineCount,
  getClientTraffic,
  getPanelClients,
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
const { Markup } = require('telegraf');
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

function isAdmin(ctx) {
  return String(ctx.from.id) === String(getConfig().admin_tg_id);
}

/** Главное меню — inline-кнопки вместо перечисления команд текстом. */
function mainKeyboard(ctx, cfg) {
  const rows = [];
  if (cfg.tg_group_id && cfg.group_link) {
    rows.push([Markup.button.url('👥 Наша группа', cfg.group_link)]);
  }
  rows.push(
    [
      Markup.button.callback('🔗 Подписка', 'menu:sub'),
      Markup.button.callback('📊 Статистика', 'menu:stats'),
    ],
    [
      Markup.button.callback('📱 QR-код', 'menu:qr'),
      Markup.button.callback('📖 Помощь', 'menu:help'),
    ]
  );
  if (isAdmin(ctx)) {
    rows.push([Markup.button.callback('👑 Панель администратора', 'menu:admin')]);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Ссылка-приглашение в группу выдаётся всегда:
 * сначала персональная ссылка (бот-админ с Invite users),
 * при неудаче — публичная ссылка из конфига.
 */
async function getGroupLink(ctx, cfg) {
  if (!cfg.tg_group_id) return { link: '', required: false };

  try {
    const inv = await ctx.telegram.createChatInviteLink(cfg.tg_group_id, {
      member_limit: 100000,
      name: `bot_user_${ctx.from.id}`,
    });
    if (inv && inv.invite_link) return { link: inv.invite_link, required: true };
  } catch (e) {
    // нет прав админа в группе — переходим к публичной ссылке
  }

  if (cfg.group_link) return { link: cfg.group_link, required: true };

  throw new Error(
    'не удалось получить ссылку-приглашение в группу. Добавьте бота админом в группу ' +
    'с правом «Invite users» или пропишите публичную ссылку в data/config.json → group_link.'
  );
}

/** Проверка членства в группе. */
async function isGroupMember(ctx, tgId) {
  const cfg = getConfig();
  if (!cfg.tg_group_id) return true;
  try {
    const member = await ctx.telegram.getChatMember(cfg.tg_group_id, tgId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (e) {
    return false;
  }
}

async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;

  if (await db.getUserByTgId(tgId)) {
    return ctx.reply('ℹ️ Вы уже зарегистрированы. Откройте подписку кнопкой ниже.', mainKeyboard(ctx, cfg));
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

    // Привязка к группе обязательна: без неё регистрация не завершена
    let group = { link: '', required: false };
    try {
      group = await getGroupLink(ctx, cfg);
    } catch (e) {
      await api.deleteClient(email);
      await db.deleteUser(tgId);
      return ctx.reply(`❌ Регистрация отменена: ${e.message}`);
    }

    if (group.required) {
      await db.setGroupJoined(tgId, false, group.link);
      const joined = await isGroupMember(ctx, tgId);
      if (joined) await db.setGroupJoined(tgId, true, group.link);

      return ctx.reply(
        `✅ Аккаунт создан, но нужно вступить в группу.\n\n` +
        `📋 Email: ${email}\n` +
        `📊 Лимит: ${cfg.default_traffic_gb} ГБ — общий на все инбаунды\n` +
        `⏸ Доступ активирует администратор\n\n` +
        `👉 Нажмите «Вступить в группу», затем «Я вступил». ` +
        `Пока вы в группе не подтверждены, подписка не откроется.`,
        Markup.inlineKeyboard([
          [Markup.button.url('👥 Вступить в группу', group.link)],
          [Markup.button.callback(joined ? '✅ Вы в группе' : '✔️ Я вступил', 'grp:check')],
        ])
      );
    }

    await ctx.reply(
      `✅ Регистрация успешна!\n\n` +
      `📋 Email: ${email}\n` +
      `🌐 Инбаундов: ${inboundIds.length}\n` +
      `📊 Лимит: ${cfg.default_traffic_gb} ГБ — общий на все инбаунды\n` +
      `⏸ Ожидание активации администратором`,
      mainKeyboard(ctx, cfg)
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка регистрации: ${err.message}`);
  }
}

/** Кнопка «Я вступил» — проверяем состав группы. */
async function onGroupCheck(ctx) {
  const tgId = ctx.from.id;
  const user = await db.getUserByTgId(tgId);
  if (!user) return ctx.answerCbQuery('Сначала нажмите /start');

  const joined = await isGroupMember(ctx, tgId);
  if (!joined) {
    await db.setGroupJoined(tgId, false, user.group_invite_link || '');
    return ctx.answerCbQuery('❌ Вас нет в группе — вступите и нажмите снова', { show_alert: true });
  }

  await db.setGroupJoined(tgId, true, user.group_invite_link || '');
  await ctx.answerCbQuery('✅ Группа подтверждена');
  return ctx.reply(
    `✅ Группа подтверждена!\n\n⏸ Осталось дождаться активации подписки администратором.`,
    mainKeyboard(ctx, getConfig())
  );
}

async function sendSubLink(ctx, user) {
  const subUrl = await api.getSubscriptionUrl(user.sub_id);
  return ctx.reply(
    `🔗 Ссылка подписки — вставьте её в приложение:\n${subUrl}\n\n` +
    `📱 QR-код — по кнопке ниже.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📱 Показать QR-код', 'sub:qr')],
      [Markup.button.callback('📊 Статистика', 'menu:stats')],
    ])
  );
}

async function cmdMySub(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Нажмите /start для регистрации.');
  }

  // Подписка доступна только привязанным к группе
  if (getConfig().tg_group_id && !user.group_joined) {
    const rows = [];
    if (user.group_invite_link) {
      rows.push([Markup.button.url('👥 Вступить в группу', user.group_invite_link)]);
    }
    rows.push([Markup.button.callback('✔️ Я вступил', 'grp:check')]);
    return ctx.reply('⛔ Подписка доступна только после вступления в нашу Telegram-группу.', Markup.inlineKeyboard(rows));
  }

  if (!user.is_active) {
    return ctx.reply('⏸ Ваша подписка ещё не активирована администратором.', mainKeyboard(ctx, getConfig()));
  }

  return sendSubLink(ctx, user);
}

/** QR отправляем отдельным сообщением — по нажатию кнопки. */
async function sendQr(ctx, user) {
  const subUrl = await api.getSubscriptionUrl(user.sub_id);
  try {
    const qr = await QRCode.toBuffer(subUrl, { type: 'png', width: 400, margin: 2 });
    return ctx.replyWithPhoto({ source: qr }, { caption: `📱 QR-код подписки\n${subUrl}` });
  } catch (e) {
    return ctx.reply(`❌ Не удалось сгенерировать QR: ${e.message}`);
  }
}

async function onQrButton(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) return ctx.answerCbQuery('Сначала нажмите /start');
  if (getConfig().tg_group_id && !user.group_joined) {
    return ctx.answerCbQuery('⛔ Сначала вступите в группу', { show_alert: true });
  }
  if (!user.is_active) {
    return ctx.answerCbQuery('⏸ Подписка ещё не активирована', { show_alert: true });
  }
  await ctx.answerCbQuery('Готовлю QR…');
  return sendQr(ctx, user);
}

async function sendStats(ctx, user) {
  try {
    const traffic = await api.getClientTraffic(user.email);
    if (!traffic) {
      return ctx.reply('📊 Статистика пока недоступна.', mainKeyboard(ctx, getConfig()));
    }

    const used = (traffic.up || 0) + (traffic.down || 0);
    const limit = user.traffic_limit || traffic.total || 0;
    const remaining = Math.max(0, limit - used);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const filled = Math.round(pct / 10);
    const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);

    await ctx.reply(
      `📊 Статистика подписки\n\n` +
      `📡 Статус: ${traffic.enable ? '🟢 Активен' : '🔴 Неактивен'}\n` +
      `⬇️ Скачано: ${(traffic.down / GiB).toFixed(2)} ГБ\n` +
      `⬆️ Отдано: ${(traffic.up / GiB).toFixed(2)} ГБ\n` +
      `🔄 Израсходовано: ${(used / GiB).toFixed(2)} ГБ (${pct}%)\n` +
      `${bar}\n` +
      `📏 Лимит: ${(limit / GiB).toFixed(0)} ГБ — общий на все инбаунды\n` +
      `✅ Остаток: ${(remaining / GiB).toFixed(2)} ГБ`,
      mainKeyboard(ctx, getConfig())
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка получения статистики: ${e.message}`);
  }
}

async function cmdStats(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Нажмите /start для регистрации.');
  }
  return sendStats(ctx, user);
}

async function cmdHelp(ctx) {
  const cfg = getConfig();
  await ctx.reply(
    `📖 Как пользоваться ботом\n\n` +
    `1️⃣ /start — регистрация, клиент создаётся во всех инбаундах\n` +
    `2️⃣ Вступление в Telegram-группу — обязательно\n` +
    `3️⃣ Активация администратором\n` +
    `4️⃣ «Подписка» — ссылка для приложения, «QR-код» — картинка для телефона\n\n` +
    `📏 Лимит ${cfg.default_traffic_gb} ГБ расходуется суммарно по всем инбаундам.\n\n` +
    `Все действия — кнопками ниже.`,
    mainKeyboard(ctx, cfg)
  );
}

/** Нажатия кнопок главного меню. */
async function onMenuCallback(ctx) {
  const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';
  const cfg = getConfig();

  if (data === 'menu:sub') {
    await ctx.answerCbQuery();
    return cmdMySub(ctx);
  }
  if (data === 'menu:stats') {
    await ctx.answerCbQuery();
    const user = await db.getUserByTgId(ctx.from.id);
    if (!user) return ctx.reply('❌ Вы не зарегистрированы. Нажмите /start.');
    return sendStats(ctx, user);
  }
  if (data === 'menu:qr') return onQrButton(ctx);
  if (data === 'menu:help') {
    await ctx.answerCbQuery();
    return cmdHelp(ctx);
  }
  if (data === 'menu:admin') {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');
    return require('./admin').cmdDashboard(ctx);
  }
  return ctx.answerCbQuery();
}

module.exports = {
  cmdStart,
  cmdMySub,
  cmdStats,
  cmdHelp,
  sendQr,
  mainKeyboard,
  onGroupCheck,
  onQrButton,
  onMenuCallback,
  isGroupMember,
};
EOF

# src/handlers/admin.js
cat > src/handlers/admin.js <<'EOF'
const { Markup } = require('telegraf');
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;
const PAGE_SIZE = 10;

function fmtGB(bytes) {
  return (bytes / GiB).toFixed(2) + ' ГБ';
}

function isAdmin(ctx) {
  return String(ctx.from.id) === String(getConfig().admin_tg_id);
}

/** Ссылка на команду с предзаполненным текстом — «быстрая ссылка» на /enable, /disable. */
function cmdLink(botUsername, command, arg) {
  return `https://t.me/${botUsername}?text=/${command}%20${arg}`;
}

async function cmdDashboard(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  try {
    const users = await db.getAllUsers();
    const activeUsers = users.filter(u => u.is_active);
    const status = await api.getServerStatus();
    const inbounds = await api.getInbounds();
    const online = await api.getOnlineCount();

    const xrayRunning = status && status.xray && status.xray.state === 'running';
    const xrayVer = status && status.xray ? status.xray.version : '';
    const memCur = status && status.mem ? status.mem.current : 0;
    const memTot = status && status.mem ? status.mem.total : 0;

    let panelClients = 0;
    try {
      panelClients = (await api.getPanelClients()).length;
    } catch (e) {
      panelClients = users.length;
    }

    const mode = api.getApiMode();
    const quotaNote = mode === 'clients'
      ? 'единая квота на все инбаунды'
      : 'legacy API: лимит на каждый инбаунд';

    const botInfo = await ctx.telegram.getMe();

    await ctx.reply(
      `📊 ПАНЕЛЬ АДМИНИСТРАТОРА\n\n` +
      `👥 Через бота: ${users.length}\n` +
      `🟢 Активных: ${activeUsers.length}\n` +
      `🔴 Неактивных: ${users.length - activeUsers.length}\n` +
      `🗂 Клиентов в панели: ${panelClients}\n` +
      `🌐 Онлайн: ${online.length}\n` +
      `📡 Инбаундов: ${inbounds.length}\n` +
      `🖥 Xray: ${xrayRunning ? '🟢 запущен' : '🔴 остановлен'}${xrayVer ? ' — ' + xrayVer : ''}\n` +
      `💾 CPU: ${status && typeof status.cpu === 'number' ? status.cpu.toFixed(1) + '%' : 'N/A'}\n` +
      `🧠 RAM: ${memTot ? fmtGB(memCur) + ' из ' + fmtGB(memTot) : 'N/A'}\n` +
      `📦 Панель: ${status && status.panelVersion ? status.panelVersion : 'N/A'}\n` +
      `🔌 API: ${mode} — ${quotaNote}\n\n` +
      `👑 КОМАНДЫ АДМИНИСТРАТОРА\n` +
      `/users — список клиентов с кнопками вкл/выкл\n` +
      `/enable <tg_id> — включить подписку\n` +
      `/disable <tg_id> — выключить подписку\n` +
      `/delete <tg_id> — удалить клиента из панели и базы\n` +
      `/broadcast <текст> — рассылка всей базе`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 Пользователи', 'adm:users:0'),
          Markup.button.callback('🔄 Обновить', 'adm:dashboard'),
        ],
        [Markup.button.url('📝 Рассылка', cmdLink(botInfo.username, 'broadcast', 'привет'))],
      ])
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

/**
 * /users — показываем ВСЕХ клиентов панели, а не только зарегистрированных ботом.
 * У каждого — кнопка быстрого включения/выключения.
 */
async function buildUsersPage(ctx, page) {
  const cfg = getConfig();
  const botInfo = await ctx.telegram.getMe();

  let clients = [];
  try {
    clients = await api.getPanelClients();
  } catch (e) {
    return ctx.reply(`❌ Не удалось получить клиентов из панели: ${e.message}`);
  }

  const botUsers = await db.getAllUsers();
  const byEmail = new Map(botUsers.map(u => [u.email, u]));

  // Свои (из базы бота) — на первой странице, затем остальные клиенты панели
  const own = clients.filter(c => byEmail.has(c.email));
  const foreign = clients.filter(c => !byEmail.has(c.email));
  const sorted = [...own, ...foreign];

  if (!sorted.length) return ctx.reply('👥 В панели нет клиентов.');

  const pages = Math.ceil(sorted.length / PAGE_SIZE);
  const cur = Math.max(0, Math.min(page, pages - 1));
  const slice = sorted.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);

  let msg = `👥 Клиенты панели: ${sorted.length}\n` +
    `🗂 Через бота: ${own.length} · ➕ Заведены вручную: ${foreign.length}\n` +
    `Страница ${cur + 1} из ${pages}\n\n`;

  const rows = [];
  for (const c of slice) {
    const bu = byEmail.get(c.email);
    const used = (c.up || 0) + (c.down || 0);
    const mark = bu ? (bu.is_active ? '🟢' : '🔴') : '⚪';
    const who = bu
      ? `${bu.tg_id} · ${bu.tg_first_name || bu.tg_username || 'без имени'}`
      : `${c.tgId || 'без TG'} · вручную`;
    msg += `${mark} ${c.email}\n   ${who}\n   ${fmtGB(used)} из ${fmtGB(c.total || 0)} ${c.enable ? '· 🟢 вкл' : '· 🔴 выкл'}\n\n`;

    // Кнопки include только там, где callback_data влезает в лимит Telegram (64 байта)
    const emailBuf = Buffer.byteLength(c.email, 'utf8');
    if (emailBuf <= 55) {
      rows.push([
        Markup.button.callback(c.enable ? '⏸ Выключить' : '▶️ Включить', `adm:tgl:${c.enable ? 'off' : 'on'}:${c.email}`),
        Markup.button.url('🗑 Удалить', cmdLink(botInfo.username, 'delete', bu ? bu.tg_id : c.email)),
      ]);
    }
  }

  const nav = [];
  if (cur > 0) nav.push(Markup.button.callback('◀️ Назад', `adm:users:${cur - 1}`));
  nav.push(Markup.button.callback('👑 Дашборд', 'adm:dashboard'));
  if (cur < pages - 1) nav.push(Markup.button.callback('Вперёд ▶️', `adm:users:${cur + 1}`));
  rows.push(nav);

  return ctx.reply(msg, Markup.inlineKeyboard(rows));
}

async function cmdUsers(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');
  return buildUsersPage(ctx, 0);
}

/** Общая логика вкл/выкл — используется и командами, и кнопками. */
async function toggleClient(ctx, email, enable) {
  const bu = (await db.getAllUsers()).find(u => u.email === email);

  await api.setClientActive(email, enable);
  if (bu) await db.setActive(bu.tg_id, enable);

  if (enable) {
    try {
      await ctx.telegram.sendMessage(
        email.replace(/^tg_/, ''),
        '🎉 Ваша подписка активирована! Нажмите «Подписка», чтобы получить ссылку.'
      );
    } catch (e) {
      // пользователь мог заблокировать бота
    }
  }
  return bu;
}

async function onAdminCallback(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('⛔ Нет доступа');
    return;
  }
  const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';

  if (data === 'adm:dashboard') {
    await ctx.answerCbQuery();
    return cmdDashboard(ctx);
  }

  const usersMatch = data.match(/^adm:users:(\d+)$/);
  if (usersMatch) {
    await ctx.answerCbQuery();
    return buildUsersPage(ctx, parseInt(usersMatch[1], 10));
  }

  const toggleMatch = data.match(/^adm:tgl:(on|off):(.+)$/);
  if (toggleMatch) {
    const email = toggleMatch[2];
    const enable = toggleMatch[1] === 'on';
    try {
      await toggleClient(ctx, email, enable);
      await ctx.answerCbQuery(enable ? '✅ Включён' : '⏸ Выключен');
      return buildUsersPage(ctx, 0);
    } catch (e) {
      await ctx.answerCbQuery('❌ ' + e.message, { show_alert: true });
      return;
    }
  }

  return ctx.answerCbQuery();
}

async function cmdEnable(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const arg = (ctx.message.text || '').split(' ')[1];
  if (!arg) return ctx.reply('Использование: /enable <tg_id>');

  let user = await db.getUserByTgId(parseInt(arg, 10));
  const email = user ? user.email : arg;

  try {
    await toggleClient(ctx, email, true);
    await ctx.reply(`✅ ${email} активирован.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

async function cmdDisable(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const arg = (ctx.message.text || '').split(' ')[1];
  if (!arg) return ctx.reply('Использование: /disable <tg_id>');

  const user = await db.getUserByTgId(parseInt(arg, 10));
  const email = user ? user.email : arg;

  try {
    await toggleClient(ctx, email, false);
    await ctx.reply(`🔴 ${email} деактивирован.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

async function cmdBroadcast(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const text = ctx.message.text || '';
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
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const arg = (ctx.message.text || '').split(' ')[1];
  if (!arg) return ctx.reply('Использование: /delete <tg_id>');

  const user = await db.getUserByTgId(parseInt(arg, 10));
  const email = user ? user.email : arg;

  try {
    await api.deleteClient(email);
    if (user) await db.deleteUser(user.tg_id);
    await ctx.reply(`🗑 ${email} удалён из панели и базы.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

module.exports = {
  cmdDashboard,
  cmdUsers,
  cmdEnable,
  cmdDisable,
  cmdBroadcast,
  cmdDelete,
  onAdminCallback,
};
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

  // Inline-кнопки
  bot.action(/^grp:check$/, userHandlers.onGroupCheck);
  bot.action(/^sub:qr$/, userHandlers.onQrButton);
  bot.action(/^menu:.+$/, userHandlers.onMenuCallback);
  bot.action(/^adm:.+$/, adminHandlers.onAdminCallback);

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
