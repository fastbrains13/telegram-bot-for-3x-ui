// Синхронизация состояния клиентов между панелью 3x-ui и локальной базой бота.
const { Markup } = require('telegraf');
const { getConfig } = require('./config');
const db = require('./database');
const api = require('./api3xui');

const GiB = 1024 * 1024 * 1024;

let timer = null;
let running = false;

function fmtGB(bytes) {
  return ((bytes || 0) / GiB).toFixed(0) + ' ГБ';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Один проход синхронизации:
 *  - снимок всех клиентов панели;
 *  - обновление is_active у тех, кого включили/выключили прямо в панели;
 *  - импорт клиентов, заведённых вручную и привязанных к Telegram;
 *  - уведомление администратора о новых клиентах с кнопкой «Включить».
 */
async function syncOnce(telegram) {
  if (running) return { skipped: true };
  running = true;
  try {
    const cfg = getConfig();
    const clients = await api.getPanelClients();
    const { newlySeen } = await db.syncPanelClients(clients);

    // 1. Статус enable из панели — источник истины для локальной базы
    for (const c of clients) {
      const u = await db.getUserByEmail(c.email);
      if (u && !!u.is_active !== !!c.enable) {
        await db.setActive(u.tg_id, !!c.enable);
      }
    }

    // 1b. Клиента удалили в веб-интерфейсе панели — закрываем доступ и в боте,
    // иначе /my_sub отдавал бы ссылку на несуществующую подписку.
    // clientExists === false только при точном ответе панели, сбой API игнорируем.
    for (const u of await db.getAllUsers()) {
      if (!Number(u.is_active)) continue;
      if (await api.clientExists(u.email) !== false) continue;
      await db.setActive(u.tg_id, false);
      console.log(`[sync] ${u.email} отсутствует в панели — подписка деактивирована`);
    }

    // 2. Ручные клиенты с указанным tgId начинают пользоваться ботом без /start
    for (const c of newlySeen) {
      const tgId = Number(c.tgId) || 0;
      if (!tgId) continue;
      if (await db.getUserByEmail(c.email)) continue;
      try {
        await db.importPanelClient({
          tgId, email: c.email, subId: c.subId, uuid: c.uuid, trafficLimit: c.total,
        });
      } catch (e) {
        /* пользователь мог зарегистрироваться сам параллельно */
      }
    }

    // 3. Уведомления админу о новых клиентах
    let notified = 0;
    if (cfg.notify_new_clients !== false && telegram) {
      for (const c of newlySeen) {
        try {
          await notifyNewClient(telegram, c);
          await db.markPanelClientNotified(c.email);
          notified++;
        } catch (e) {
          /* админ заблокировал бота — не критично */
        }
      }
    }

    return { total: clients.length, newlySeen: newlySeen.length, notified };
  } finally {
    running = false;
  }
}

/** Сообщение админу: появился новый клиент + кнопка включения. */
async function notifyNewClient(telegram, c) {
  const cfg = getConfig();
  const tgId = Number(c.tgId) || 0;
  const source = tgId ? `👤 Telegram: <code>${tgId}</code>` : '🖐 заведён вручную в панели';

  const rows = [];
  if (Buffer.byteLength(c.email, 'utf8') <= 55) {
    rows.push([Markup.button.callback(
      c.enable ? '⏸ Выключить' : '▶️ Включить',
      `adm:tgl:${c.enable ? 'off' : 'on'}:${c.email}`
    )]);
  }
  rows.push([Markup.button.callback('👥 Все клиенты', 'adm:users:0')]);

  await telegram.sendMessage(
    cfg.admin_tg_id,
    `🆕 <b>Новый клиент в панели</b>\n\n` +
    `📧 Email: <code>${esc(c.email)}</code>\n` +
    `${source}\n` +
    `📏 Лимит: ${fmtGB(c.total)}\n` +
    `🔌 Статус: ${c.enable ? '🟢 включён' : '⏸ выключен'}\n\n` +
    `Нажмите кнопку, чтобы активировать.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
  );
}

/** Периодический опрос панели. */
function startSyncLoop(telegram, intervalSec) {
  const cfg = getConfig();
  const sec = Number(intervalSec || cfg.sync_interval_sec) || 60;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    syncOnce(telegram).catch(e => console.error('[sync] ошибка:', e.message));
  }, sec * 1000);
  if (timer.unref) timer.unref();
  console.log(`🔄 Синхронизация с панелью: каждые ${sec} с`);
}

module.exports = { syncOnce, startSyncLoop, notifyNewClient };
