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
