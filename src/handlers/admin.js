const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

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
    const online = await api.getOnlineUsers();

    await ctx.reply(
      `📊 Дашборд панели\n\n` +
      `👥 Всего пользователей: ${users.length}\n` +
      `🟢 Активных: ${activeUsers.length}\n` +
      `🔴 Неактивных: ${users.length - activeUsers.length}\n` +
      `🌐 Онлайн сейчас: ${online.length}\n` +
      `📡 Инбаундов: ${inbounds.length}\n` +
      `🖥 Xray запущен: ${status.xray ? 'Да' : 'Нет'}\n` +
      `💾 CPU: ${status.cpu ? status.cpu + '%' : 'N/A'}\n` +
      `🧠 RAM: ${status.mem ? (status.mem / 1048576).toFixed(0) + ' MB' : 'N/A'}\n\n` +
      `Команды: /users /enable /disable /broadcast`
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
    msg += `${status} ${u.tg_id} — ${name} (@${u.tg_username || 'нет'})\n`;
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
    const inbounds = await api.getInbounds();
    for (const inbound of inbounds) {
      const settings = JSON.parse(inbound.settings || '{}');
      const client = (settings.clients || []).find(c => c.email === user.email);
      if (client) {
        await api.deleteClient(inbound.id, client.id || client.password);
      }
    }
    await db.deleteUser(targetId);
    await ctx.reply(`🗑 Пользователь ${targetId} удалён.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

module.exports = { cmdDashboard, cmdUsers, cmdEnable, cmdDisable, cmdBroadcast, cmdDelete };
