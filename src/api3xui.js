const { request } = require('undici');
const { getConfig } = require('./config');

let cookies = '';
let loggedIn = false;

async function login() {
  const cfg = getConfig();
  const baseUrl = cfg.panel_url.replace(/\/$/, '');
  const loginPath = cfg.panel_base_path || '/login';

  // Try Bearer token first if api_token is set
  if (cfg.api_token) {
    loggedIn = true;
    return;
  }

  const res = await request(`${baseUrl}${loginPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(cfg.panel_username)}&password=${encodeURIComponent(cfg.panel_password)}`,
  });

  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    cookies = setCookie.map(c => c.split(';')[0]).join('; ');
  }
  loggedIn = true;

  const json = await res.body.json();
  if (!json.success) throw new Error('Panel login failed: ' + (json.msg || 'unknown'));
}

async function apiRequest(path, method = 'GET', body = null) {
  const cfg = getConfig();
  const baseUrl = cfg.panel_url.replace(/\/$/, '');
  const headers = {};

  if (cfg.api_token) {
    headers['Authorization'] = `Bearer ${cfg.api_token}`;
  } else if (cookies) {
    headers['Cookie'] = cookies;
  }

  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await request(`${baseUrl}${path}`, opts);
  const json = await res.body.json();

  // Session expired, re-login
  if (json === '' || (json.msg && json.msg.includes('login'))) {
    await login();
    return apiRequest(path, method, body);
  }

  return json;
}

async function getInbounds() {
  const res = await apiRequest('/panel/api/inbounds/list');
  return res.obj || [];
}

async function getInboundById(id) {
  const res = await apiRequest(`/panel/api/inbounds/get/${id}`);
  return res.obj;
}

async function getNewUUID() {
  const res = await apiRequest('/panel/api/server/getNewUUID');
  return res.obj;
}

async function addClientToInbound(inboundId, client) {
  const res = await apiRequest(`/panel/api/inbounds/${inboundId}/addClient`, 'POST', client);
  return res;
}

async function updateClient(inboundId, clientId, clientData) {
  const res = await apiRequest(`/panel/api/inbounds/${inboundId}/updateClient/${clientId}`, 'POST', clientData);
  return res;
}

async function deleteClient(inboundId, clientId) {
  const res = await apiRequest(`/panel/api/inbounds/${inboundId}/delClient/${clientId}`, 'POST');
  return res;
}

async function getClientTraffics(email) {
  const res = await apiRequest(`/panel/api/inbounds/getClientTraffics/${encodeURIComponent(email)}`);
  return res.obj;
}

async function getAllLinks() {
  const res = await apiRequest('/panel/api/inbounds/allLinks');
  return res.obj || [];
}

async function getServerStatus() {
  const res = await apiRequest('/panel/api/server/status');
  return res.obj;
}

async function getOnlineUsers() {
  const res = await apiRequest('/panel/api/inbounds/onlines');
  return res.obj || [];
}

/**
 * Register user across all inbounds with default settings:
 * - 100GB total traffic
 * - Disabled by default
 * - Access to all inbounds
 */
async function registerUser({ email, uuid, subId, tgId }) {
  const cfg = getConfig();
  const trafficLimit = cfg.default_traffic_gb * 1073741824; // GB to bytes
  const inbounds = await getInbounds();

  const results = [];
  for (const inbound of inbounds) {
    const settings = JSON.parse(inbound.settings || '{}');
    const clientObj = {
      id: uuid,
      uuid: uuid,
      email: email,
      flow: settings.clients && settings.clients[0] ? (settings.clients[0].flow || '') : '',
      enable: false, // disabled by default
      subId: subId,
      total: trafficLimit,
      expiryTime: 0,
      tgId: tgId || '',
      reset: 0,
    };

    // For trojan, use password instead of id/uuid
    if (inbound.protocol === 'trojan') {
      clientObj.password = uuid;
      delete clientObj.id;
      delete clientObj.uuid;
    }

    // For SS
    if (inbound.protocol === 'shadowsocks') {
      clientObj.password = uuid;
      clientObj.method = settings.method || 'aes-128-gcm';
      delete clientObj.id;
      delete clientObj.uuid;
    }

    const res = await addClientToInbound(inbound.id, clientObj);
    results.push({ inboundId: inbound.id, protocol: inbound.protocol, remark: inbound.remark, success: res.success });
  }

  return results;
}

/**
 * Enable/disable client across all inbounds
 */
async function setClientActive(email, active) {
  const inbounds = await getInbounds();
  for (const inbound of inbounds) {
    const settings = JSON.parse(inbound.settings || '{}');
    const client = (settings.clients || []).find(c => c.email === email);
    if (client) {
      const clientId = client.id || client.password || subId;
      const cfg = getConfig();
      const trafficLimit = cfg.default_traffic_gb * 1073741824;
      await updateClient(inbound.id, clientId, {
        ...client,
        enable: active,
        total: trafficLimit,
      });
    }
  }
}

/**
 * Get subscription URL for user
 */
function getSubscriptionUrl(subId) {
  const cfg = getConfig();
  const baseUrl = cfg.panel_url.replace(/\/$/, '');
  return `${baseUrl}/sub/${subId}`;
}

/**
 * Get user traffic stats
 */
async function getUserStats(email) {
  const traffic = await getClientTraffics(email);
  return traffic;
}

module.exports = {
  login,
  getInbounds,
  getInboundById,
  getNewUUID,
  addClientToInbound,
  updateClient,
  deleteClient,
  getClientTraffics,
  getAllLinks,
  getServerStatus,
  getOnlineUsers,
  registerUser,
  setClientActive,
  getSubscriptionUrl,
  getUserStats,
};
