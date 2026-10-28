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
