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
  // Имя группы клиентов в панели (поле group) — куда попадают новые клиенты
  if (config.panel_client_group === undefined) config.panel_client_group = 'Telegram';
  // Уведомлять администратора о новых клиентах в панели
  if (config.notify_new_clients === undefined) config.notify_new_clients = true;
  // Период опроса панели в секундах
  if (config.sync_interval_sec === undefined) config.sync_interval_sec = 60;
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
