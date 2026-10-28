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

/**
 * Настройки панели: POST /panel/api/setting/all.
 * Нужны, чтобы взять subURI — базовый адрес подписки. У подписки отдельный
 * порт (subPort), отдельный путь (subPath) и, возможно, отдельный домен,
 * поэтому ссылка подписки НЕ равна panel_url + /sub.
 */
let subBaseCache = '';
async function getSubscriptionBase() {
  if (subBaseCache) return subBaseCache;
  const cfg = getConfig();
  try {
    const res = await apiRequest('/panel/api/setting/all', 'POST', {});
    const s = res.obj || {};
    let base = String(s.subURI || '').trim();
    if (!base && s.subEnable) {
      const domain = s.subDomain ||
        cfg.panel_url.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/$/, '');
      const subPath = String(s.subPath || '/sub/');
      const tls = !!(s.subCertFile && s.subKeyFile);
      const scheme = tls ? 'https' : (String(cfg.panel_url).startsWith('https') ? 'https' : 'http');
      const port = Number(s.subPort) || 0;
      const hostPort = (port && port !== 80 && port !== 443) ? `${domain}:${port}` : domain;
      base = `${scheme}://${hostPort}${subPath}`;
    }
    if (base) {
      if (!base.endsWith('/')) base += '/';
      subBaseCache = base;
      return base;
    }
  } catch (e) {
    /* нет доступа к настройкам — собираем из panel_url */
  }
  const subPath = (cfg.sub_path || '/sub').replace(/\/+$/, '');
  return `${cfg.panel_url.replace(/\/$/, '')}${subPath}/`;
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
  // Имя группы клиентов в панели (поле group) — например "Telegram"
  const groupName = String(getConfig().panel_client_group || '').trim();

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
        group: groupName,
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
      group: groupName,
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
 * поэтому ссылка собирается из subURI панели: {subURI}{subId}.
 * subURI учитывает отдельный порт/домен/путь подписки из настроек панели.
 */
async function getSubscriptionUrl(subId) {
  const base = await getSubscriptionBase();
  return `${base}${subId}`;
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
      enable: !!(c.traffic ? c.traffic.enable : c.enable),
      total: c.totalGB || (c.traffic && c.traffic.total) || 0,
      up: (c.traffic && c.traffic.up) || 0,
      down: (c.traffic && c.traffic.down) || 0,
      expiryTime: c.expiryTime || 0,
      comment: c.comment || '',
      group: c.group || '',
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

/**
 * Клиент панели, заведённый вручную, но привязанный к Telegram-аккаунту.
 * Позволяет пользоваться ботом без /start.
 */
async function getClientByTgId(tgId) {
  const id = Number(tgId);
  if (!id) return null;

  if (apiMode === 'clients') {
    try {
      const res = await apiRequest(`/panel/api/clients/get/tgId/${id}`);
      const rec = res.obj;
      const c = rec && (rec.client || rec);
      if (c && c.email) {
        return {
          email: c.email,
          subId: c.subId || '',
          uuid: c.uuid || c.id || '',
          tgId: id,
          enable: !!c.enable,
          total: c.totalGB || 0,
          group: c.group || '',
        };
      }
    } catch (e) {
      /* эндпоинт недоступен — ищем перебором */
    }
  }

  const all = await getPanelClients();
  return all.find(c => Number(c.tgId) === id) || null;
}

module.exports = {
  login,
  getApiMode,
  getInbounds,
  getServerStatus,
  getOnlineCount,
  getClientTraffic,
  getPanelClients,
  getClientByTgId,
  registerUser,
  getClient,
  getNewUUID,
  setClientActive,
  deleteClient,
  getSubscriptionUrl,
  getSubscriptionBase,
  trafficBytes,
};
