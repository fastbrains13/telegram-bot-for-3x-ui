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
    CREATE TABLE IF NOT EXISTS panel_clients (
      email TEXT PRIMARY KEY,
      sub_id TEXT,
      tg_id INTEGER DEFAULT 0,
      enable INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      up INTEGER DEFAULT 0,
      down INTEGER DEFAULT 0,
      group_name TEXT,
      first_seen INTEGER,
      notified INTEGER DEFAULT 0
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

function sqlStr(v) {
  return `'${String(v === null || v === undefined ? '' : v).replace(/'/g, "''")}'`;
}

/**
 * Заносит/обновляет снимок клиента панели и возвращает разницу:
 * newlySeen — клиенты, которых в этой таблице раньше не было (уведомить админа),
 * enabled   — клиенты, у которых панель сообщила enable=true.
 */
async function syncPanelClients(clients) {
  const d = await getDb();
  const res = d.exec('SELECT email, enable, notified FROM panel_clients');
  const known = new Map();
  if (res.length) {
    for (const row of res[0].values) known.set(row[0], { enable: row[1], notified: row[2] });
  }

  const newlySeen = [];
  const enabled = [];

  for (const c of clients) {
    if (!c.email) continue;
    const prev = known.get(c.email);
    const enable = c.enable ? 1 : 0;
    d.run(
      'INSERT INTO panel_clients (email, sub_id, tg_id, enable, total, up, down, group_name, first_seen, notified) ' +
      'VALUES (' + [
        sqlStr(c.email), sqlStr(c.subId), Number(c.tgId) || 0, enable,
        Number(c.total) || 0, Number(c.up) || 0, Number(c.down) || 0,
        sqlStr(c.group), Date.now(), prev ? prev.notified : 0,
      ].join(', ') + ') ' +
      'ON CONFLICT(email) DO UPDATE SET sub_id=excluded.sub_id, tg_id=excluded.tg_id, enable=excluded.enable, ' +
      'total=excluded.total, up=excluded.up, down=excluded.down, group_name=excluded.group_name'
    );
    if (!prev) newlySeen.push(c);
    else if (!prev.enable && enable) enabled.push(c);
  }

  // Клиенты, удалённые из панели, убираем из снимка
  const live = new Set(clients.map(c => c.email));
  for (const email of known.keys()) {
    if (!live.has(email)) d.run('DELETE FROM panel_clients WHERE email = ' + sqlStr(email));
  }

  saveDb();
  return { newlySeen, enabled };
}

/** Отметить, что админ уже уведомлён о клиенте. */
async function markPanelClientNotified(email) {
  const d = await getDb();
  d.run('UPDATE panel_clients SET notified = 1 WHERE email = ' + sqlStr(email));
  saveDb();
}

async function getUserByEmail(email) {
  const d = await getDb();
  const res = d.exec('SELECT * FROM users WHERE email = ' + sqlStr(email));
  if (!res.length || !res[0].values.length) return null;
  return rowToObj(res[0].columns, res[0].values[0]);
}

/** Импорт клиента, заведённого вручную в панели (для /my_sub без /start). */
async function importPanelClient({ tgId, email, subId, uuid, trafficLimit }) {
  const d = await getDb();
  const exists = await getUserByTgId(tgId);
  if (exists) return exists;
  await registerUser({
    tgId,
    username: '',
    firstName: '',
    email,
    uuid: uuid || '',
    subId,
    trafficLimit,
  });
  // Клиент создан админом — требование группы к нему не применяется
  d.run('UPDATE users SET group_joined = 1 WHERE tg_id = ' + Number(tgId));
  saveDb();
  return getUserByTgId(tgId);
}

/**
 * Перезапись кредов клиента после восстановления в панели:
 * панель выдаёт новый uuid, sub_id может смениться, доступ снова выключен
 * (ждёт активации админом).
 */
async function resetUserClient({ tgId, uuid, subId, trafficLimit }) {
  const d = await getDb();
  d.run(
    'UPDATE users SET uuid = ' + sqlStr(uuid) + ', sub_id = ' + sqlStr(subId) +
    ', is_active = 0, traffic_limit = ' + (Number(trafficLimit) || 0) +
    ' WHERE tg_id = ' + Number(tgId)
  );
  saveDb();
  return getUserByTgId(tgId);
}

module.exports = {
  getDb,
  saveDb,
  registerUser,
  getUserByTgId,
  getUserByEmail,
  getAllUsers,
  setActive,
  setGroupJoined,
  deleteUser,
  syncPanelClients,
  markPanelClientNotified,
  importPanelClient,
  resetUserClient,
};
