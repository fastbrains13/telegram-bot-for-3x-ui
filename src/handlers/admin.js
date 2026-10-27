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
