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
  "scripts": { "start": "node src/index.js" },
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
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('Config not found. Run installer.');
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return config;
}
module.exports = { getConfig: loadConfig };
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
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id INTEGER PRIMARY KEY, tg_username TEXT, tg_first_name TEXT,
    email TEXT UNIQUE NOT NULL, uuid TEXT NOT NULL, sub_id TEXT NOT NULL,
    registered_at INTEGER NOT NULL, is_active INTEGER DEFAULT 0,
    traffic_limit INTEGER DEFAULT 107374182400, used_traffic INTEGER DEFAULT 0
  )`);
  return db;
}
function saveDb() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
function rowToObj(cols, vals) { const o={}; cols.forEach((c,i)=>o[c]=vals[i]); return o; }
async function registerUser({tgId,username,firstName,email,uuid,subId}) {
  const d = await getDb();
  d.run('INSERT INTO users (tg_id,tg_username,tg_first_name,email,uuid,sub_id,registered_at) VALUES (?,?,?,?,?,?,?)',
    [tgId, username||'', firstName||'', email, uuid, subId, Date.now()]);
  saveDb();
}
async function getUserByTgId(tgId) {
  const d = await getDb();
  const r = d.exec('SELECT * FROM users WHERE tg_id=' + Number(tgId));
  return (r.length && r[0].values.length) ? rowToObj(r[0].columns, r[0].values[0]) : null;
}
async function getAllUsers() {
  const d = await getDb();
  const r = d.exec('SELECT * FROM users');
  if (!r.length) return [];
  return r[0].values.map(v => rowToObj(r[0].columns, v));
}
async function setActive(tgId, active) {
  const d = await getDb();
  d.run('UPDATE users SET is_active=' + (active?1:0) + ' WHERE tg_id=' + Number(tgId));
  saveDb();
}
async function deleteUser(tgId) {
  const d = await getDb();
  d.run('DELETE FROM users WHERE tg_id=' + Number(tgId));
  saveDb();
}
module.exports = { getDb, saveDb, registerUser, getUserByTgId, getAllUsers, setActive, deleteUser };
EOF

# src/api3xui.js
cat > src/api3xui.js <<'EOF'
const { request } = require('undici');
const { getConfig } = require('./config');
let cookies = '';
async function login() {
  const cfg = getConfig();
  const baseUrl = cfg.panel_url.replace(/\/$/,'');
  if (cfg.api_token) return;
  const lp = cfg.panel_base_path ? cfg.panel_base_path+'/login' : '/login';
  const res = await request(baseUrl+lp, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'username='+encodeURIComponent(cfg.panel_username)+'&password='+encodeURIComponent(cfg.panel_password)});
  const sc = res.headers['set-cookie'];
  if (sc) cookies = sc.map(c=>c.split(';')[0]).join('; ');
  const json = await res.body.json();
  if (!json.success) throw new Error('Panel login failed');
}
async function req(path, method='GET', body=null) {
  const cfg = getConfig();
  const baseUrl = cfg.panel_url.replace(/\/$/,'');
  const h = {};
  if (cfg.api_token) h['Authorization']='Bearer '+cfg.api_token;
  else if (cookies) h['Cookie']=cookies;
  const opts = {method,headers:h};
  if (body) { h['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const res = await request(baseUrl+path, opts);
  return res.body.json();
}
async function getInbounds() { return (await req('/panel/api/inbounds/list')).obj||[]; }
async function getNewUUID() { return (await req('/panel/api/server/getNewUUID')).obj; }
async function addClient(id,c) { return req('/panel/api/inbounds/'+id+'/addClient','POST',c); }
async function updateClient(id,cid,c) { return req('/panel/api/inbounds/'+id+'/updateClient/'+cid,'POST',c); }
async function deleteClient(id,cid) { return req('/panel/api/inbounds/'+id+'/delClient/'+cid,'POST'); }
async function getClientTraffics(email) { return (await req('/panel/api/inbounds/getClientTraffics/'+encodeURIComponent(email))).obj; }
async function getServerStatus() { return (await req('/panel/api/server/status')).obj; }
async function getOnlineUsers() { return (await req('/panel/api/inbounds/onlines')).obj||[]; }
async function registerUser({email,uuid,subId,tgId}) {
  const cfg = getConfig();
  const lim = cfg.default_traffic_gb * 1073741824;
  const inbounds = await getInbounds();
  for (const ib of inbounds) {
    const st = JSON.parse(ib.settings||'{}');
    const c = {id:uuid,uuid,email,flow:(st.clients&&st.clients[0])?(st.clients[0].flow||''):'',enable:false,subId,total:lim,expiryTime:0,tgId:String(tgId||''),reset:0};
    if (ib.protocol==='trojan') { c.password=uuid; delete c.id; delete c.uuid; }
    if (ib.protocol==='shadowsocks') { c.password=uuid; c.method=st.method||'aes-128-gcm'; delete c.id; delete c.uuid; }
    await addClient(ib.id, c);
  }
}
async function setClientActive(email, active) {
  const cfg = getConfig();
  const lim = cfg.default_traffic_gb * 1073741824;
  const inbounds = await getInbounds();
  for (const ib of inbounds) {
    const st = JSON.parse(ib.settings||'{}');
    const c = (st.clients||[]).find(x=>x.email===email);
    if (c) await updateClient(ib.id, c.id||c.password, {...c,enable:active,total:lim});
  }
}
function getSubscriptionUrl(subId) {
  return getConfig().panel_url.replace(/\/$/,'')+'/sub/'+subId;
}
async function getUserStats(email) { return getClientTraffics(email); }
module.exports = {login,getInbounds,getNewUUID,addClient,updateClient,deleteClient,getClientTraffics,getServerStatus,getOnlineUsers,registerUser,setClientActive,getSubscriptionUrl,getUserStats};
EOF

# src/handlers/user.js
cat > src/handlers/user.js <<'EOF'
const QRCode = require('qrcode');
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');
function genSubId(){return Math.random().toString(36).substring(2,15)+Date.now().toString(36)}
async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;
  if (await db.getUserByTgId(tgId)) return ctx.reply('ℹ️ Вы уже зарегистрированы. /my_sub — подписка.');
  const email = 'tg_'+tgId;
  const uuid = await api.getNewUUID();
  const subId = genSubId();
  await api.registerUser({email,uuid,subId,tgId:String(tgId)});
  await db.registerUser({tgId,username:ctx.from.username||'',firstName:ctx.from.first_name||'',email,uuid,subId});
  await ctx.reply('✅ Регистрация успешна!\n📋 Email: '+email+'\n🔑 UUID: '+uuid+'\n📊 Лимит: '+cfg.default_traffic_gb+' ГБ\n⏸ Ожидание активации админом\n\nПосле активации: /my_sub');
}
async function cmdMySub(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) return ctx.reply('❌ Нет регистрации. /start');
  if (!user.is_active) return ctx.reply('⏸ Подписка не активирована.');
  const url = api.getSubscriptionUrl(user.sub_id);
  try { const qr=await QRCode.toBuffer(url,{type:'png',width:300}); await ctx.replyWithPhoto({source:qr},{caption:'📱 QR-код:\n'+url}); } catch(e){}
  await ctx.reply('🔗 '+url);
}
async function cmdStats(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) return ctx.reply('❌ Нет регистрации.');
  try {
    const t = await api.getUserStats(user.email);
    if (!t) return ctx.reply('📊 Статистика недоступна.');
    await ctx.reply('📊 Статус: '+(t.enable?'🟢':'🔴')+'\n⬆️ '+(t.up/1073741824).toFixed(2)+' ГБ\n⬇️ '+(t.down/1073741824).toFixed(2)+' ГБ\n🔄 '+(t.total/1073741824).toFixed(2)+' ГБ\n📏 Лимит: '+(user.traffic_limit/1073741824).toFixed(0)+' ГБ\n✅ Осталось: '+((user.traffic_limit-t.total)/1073741824).toFixed(2)+' ГБ');
  } catch(e) { await ctx.reply('❌ '+e.message); }
}
async function cmdHelp(ctx) {
  const cfg = getConfig();
  let m='📖 /start — регистрация\n/my_sub — подписка+QR\n/stats — статистика';
  if(String(ctx.from.id)===String(cfg.admin_tg_id)) m+='\n\n👑 /dashboard /users /enable <id> /disable <id> /broadcast <текст> /delete <id>';
  await ctx.reply(m);
}
module.exports = {cmdStart,cmdMySub,cmdStats,cmdHelp};
EOF

# src/handlers/admin.js
cat > src/handlers/admin.js <<'EOF'
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');
function isAdmin(ctx){return String(ctx.from.id)===String(getConfig().admin_tg_id)}
async function cmdDashboard(ctx) {
  if(!isAdmin(ctx)) return ctx.reply('⛔');
  try {
    const users=await db.getAllUsers(),act=users.filter(u=>u.is_active);
    const st=await api.getServerStatus(),ib=await api.getInbounds(),on=await api.getOnlineUsers();
    await ctx.reply('📊 Дашборд\n👥 '+users.length+' (🟢'+act.length+' 🔴'+(users.length-act.length)+')\n🌐 Онлайн: '+on.length+'\n📡 Инбаунды: '+ib.length+'\n🖥 Xray: '+(st.xray?'Да':'Нет'));
  } catch(e){await ctx.reply('❌ '+e.message)}
}
async function cmdUsers(ctx) {
  if(!isAdmin(ctx)) return ctx.reply('⛔');
  const users=await db.getAllUsers();
  if(!users.length) return ctx.reply('👥 Нет пользователей.');
  let m='👥 Пользователи:\n';
  for(const u of users) m+=(u.is_active?'🟢':'🔴')+' '+u.tg_id+' '+(u.tg_first_name||u.tg_username||'')+'\n';
  await ctx.reply(m);
}
async function cmdEnable(ctx) {
  if(!isAdmin(ctx)) return ctx.reply('⛔');
  const id=parseInt(ctx.message.text.split(' ')[1]);
  if(!id) return ctx.reply('/enable <tg_id>');
  const u=await db.getUserByTgId(id);
  if(!u) return ctx.reply('❌ Не найден.');
  await api.setClientActive(u.email,true);
  await db.setActive(id,true);
  await ctx.reply('✅ '+id+' активирован.');
  try{await ctx.telegram.sendMessage(id,'🎉 Подписка активирована! /my_sub')}catch(e){}
}
async function cmdDisable(ctx) {
  if(!isAdmin(ctx)) return ctx.reply('⛔');
  const id=parseInt(ctx.message.text.split(' ')[1]);
  if(!id) return ctx.reply('/disable <tg_id>');
  const u=await db.getUserByTgId(id);
  if(!u) return ctx.reply('❌ Не найден.');
  await api.setClientActive(u.email,false);
  await db.setActive(id,false);
  await ctx.reply('🔴 '+id+' деактивирован.');
}
async function cmdBroadcast(ctx) {
  if(!isAdmin(ctx)) return ctx.reply('⛔');
  const msg=ctx.message.text.substring(ctx.message.text.indexOf(' ')+1);
  if(!msg||msg===ctx.message.text) return ctx.reply('/broadcast <текст>');
  const users=await db.getAllUsers();
  let ok=0,fail=0;
  for(const u of users){try{await ctx.telegram.sendMessage(u.tg_id,'📢 '+msg);ok++}catch(e){fail++}}
  await ctx.reply('📢 ok:'+ok+' fail:'+fail);
}
async function cmdDelete(ctx) {
  if(!isAdmin(ctx)) return ctx.reply('⛔');
  const id=parseInt(ctx.message.text.split(' ')[1]);
  if(!id) return ctx.reply('/delete <tg_id>');
  const u=await db.getUserByTgId(id);
  if(!u) return ctx.reply('❌ Не найден.');
  const ibs=await api.getInbounds();
  for(const ib of ibs){
    const st=JSON.parse(ib.settings||'{}');
    const c=(st.clients||[]).find(x=>x.email===u.email);
    if(c) await api.deleteClient(ib.id,c.id||c.password);
  }
  await db.deleteUser(id);
  await ctx.reply('🗑 '+id+' удалён.');
}
module.exports={cmdDashboard,cmdUsers,cmdEnable,cmdDisable,cmdBroadcast,cmdDelete};
EOF

# src/index.js
cat > src/index.js <<'EOF'
const { Telegraf } = require('telegraf');
const { getConfig } = require('./config');
const api = require('./api3xui');
const u = require('./handlers/user');
const a = require('./handlers/admin');
async function main() {
  const cfg = getConfig();
  const bot = new Telegraf(cfg.bot_token);
  await api.login();
  console.log('✅ Panel OK');
  await bot.telegram.setMyCommands([
    {command:'start',description:'Регистрация'},
    {command:'my_sub',description:'Подписка'},
    {command:'stats',description:'Статистика'},
    {command:'help',description:'Помощь'}
  ]);
  bot.start(u.cmdStart);
  bot.command('my_sub',u.cmdMySub);
  bot.command('stats',u.cmdStats);
  bot.command('help',u.cmdHelp);
  bot.command('dashboard',a.cmdDashboard);
  bot.command('users',a.cmdUsers);
  bot.command('enable',a.cmdEnable);
  bot.command('disable',a.cmdDisable);
  bot.command('broadcast',a.cmdBroadcast);
  bot.command('delete',a.cmdDelete);
  bot.catch((e,ctx)=>{console.error(e);try{ctx.reply('❌ Ошибка')}catch(x){}});
  const opts={};
  if(cfg.webhook_domain&&cfg.webhook_secret){opts.domain=cfg.webhook_domain;opts.secretToken=cfg.webhook_secret;opts.port=cfg.webhook_port||8443;}
  await bot.launch(opts,()=>console.log('🤖 @'+bot.botInfo.username+' running'));
  process.once('SIGINT',()=>bot.stop('SIGINT'));
  process.once('SIGTERM',()=>bot.stop('SIGTERM'));
}
main().catch(e=>{console.error('Fatal:',e);process.exit(1)});
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
