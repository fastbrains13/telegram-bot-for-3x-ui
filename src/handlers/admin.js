const { Markup } = require('telegraf');
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;
const PAGE_SIZE = 10;

function fmtGB(bytes) {
  return (bytes / GiB).toFixed(2) + ' ГБ';
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isAdmin(ctx) {
  return String(ctx.from.id) === String(getConfig().admin_tg_id);
}

/** Ссылка на команду с предзаполненным текстом — «быстрая ссылка» на /enable, /disable. */
function cmdLink(botUsername, command, arg) {
  return `https://t.me/${botUsername}?text=${encodeURIComponent('/' + command + ' ' + arg)}`;
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

    let panelClients = [];
    try {
      panelClients = await api.getPanelClients();
    } catch (e) {
      panelClients = [];
    }
    const panelActive = panelClients.filter(c => c.enable).length;

    const mode = api.getApiMode();
    const quotaNote = mode === 'clients'
      ? 'единая квота на все инбаунды'
      : 'legacy API: лимит на каждый инбаунд';

    const botInfo = await ctx.telegram.getMe();
    const cfg = getConfig();
    const groupLine = cfg.panel_client_group ? `\n🏷 Группа клиентов: ${cfg.panel_client_group}` : '';

    await ctx.reply(
      `📊 ПАНЕЛЬ АДМИНИСТРАТОРА\n\n` +
      `👥 Через бота: ${users.length}\n` +
      `🟢 Активных: ${activeUsers.length}\n` +
      `🔴 Неактивных: ${users.length - activeUsers.length}\n` +
      `🗂 Клиентов в панели: ${panelClients.length} (🟢 ${panelActive})\n` +
      `🌐 Онлайн: ${online.length}\n` +
      `📡 Инбаундов: ${inbounds.length}\n` +
      `🖥 Xray: ${xrayRunning ? '🟢 запущен' : '🔴 остановлен'}${xrayVer ? ' — ' + xrayVer : ''}\n` +
      `💾 CPU: ${status && typeof status.cpu === 'number' ? status.cpu.toFixed(1) + '%' : 'N/A'}\n` +
      `🧠 RAM: ${memTot ? fmtGB(memCur) + ' из ' + fmtGB(memTot) : 'N/A'}\n` +
      `📦 Панель: ${status && status.panelVersion ? status.panelVersion : 'N/A'}\n` +
      `🔌 API: ${mode} — ${quotaNote}${groupLine}\n\n` +
      `👑 КОМАНДЫ АДМИНИСТРАТОРА\n` +
      `<a href="${cmdLink(botInfo.username, 'users', '')}">/users</a> — список клиентов панели со ссылками вкл/выкл\n` +
      `<a href="${cmdLink(botInfo.username, 'enable', '')}">/enable</a> &lt;tg_id или email&gt; — включить подписку\n` +
      `<a href="${cmdLink(botInfo.username, 'disable', '')}">/disable</a> &lt;tg_id или email&gt; — выключить подписку\n` +
      `<a href="${cmdLink(botInfo.username, 'delete', '')}">/delete</a> &lt;tg_id или email&gt; — удалить из панели и базы\n` +
      `<a href="${cmdLink(botInfo.username, 'broadcast', ' ')}}">/broadcast</a> &lt;текст&gt; — рассылка всей базе`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('👥 Пользователи', 'adm:users:0'),
            Markup.button.callback('🔄 Обновить', 'adm:dashboard'),
          ],
        ]).reply_markup,
      }
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

/**
 * /users — показываем ВСЕХ клиентов панели, а не только зарегистрированных ботом.
 * Рядом с каждым — ссылки-команды на включение/выключение/удаление.
 */
async function buildUsersPage(ctx, page) {
  const botInfo = await ctx.telegram.getMe();
  const bot = botInfo.username;

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

  for (const c of slice) {
    const bu = byEmail.get(c.email);
    const used = (c.up || 0) + (c.down || 0);
    const mark = bu ? (bu.is_active ? '🟢' : '🔴') : '⚪';
    const who = bu
      ? `${bu.tg_id} · ${esc(bu.tg_first_name || bu.tg_username || 'без имени')}`
      : (c.tgId ? `${c.tgId} · вручную` : 'без Telegram ID');

    msg += `${mark} <code>${esc(c.email)}</code> — ${who}\n` +
      `   ${fmtGB(used)} из ${fmtGB(c.total || 0)} · ${c.enable ? '🟢 вкл' : '🔴 выкл'}\n`;

    // Ссылки-команды: открывают чат с уже набранным сообщением
    const links = c.enable
      ? [`<a href="${cmdLink(bot, 'disable', c.email)}">⏸ Выключить</a>`,
         `<a href="${cmdLink(bot, 'delete', c.email)}">🗑 Удалить</a>`]
      : [`<a href="${cmdLink(bot, 'enable', c.email)}">▶️ Включить</a>`,
         `<a href="${cmdLink(bot, 'delete', c.email)}">🗑 Удалить</a>`];
    msg += `   ${links.join(' · ')}\n\n`;
  }

  const nav = [];
  if (cur > 0) nav.push(Markup.button.callback('◀️ Назад', `adm:users:${cur - 1}`));
  nav.push(Markup.button.callback('🔄 Обновить', `adm:users:${cur}`));
  nav.push(Markup.button.callback('👑 Дашборд', 'adm:dashboard'));
  if (cur < pages - 1) nav.push(Markup.button.callback('Вперёд ▶️', `adm:users:${cur + 1}`));

  return ctx.reply(msg, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([nav]).reply_markup,
  });
}

async function cmdUsers(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');
  return buildUsersPage(ctx, 0);
}

/** Общая логика вкл/выкл — используется и командами, и кнопками. */
async function toggleClient(ctx, email, enable) {
  const bu = await db.getUserByEmail(email);

  await api.setClientActive(email, enable);
  if (bu) await db.setActive(bu.tg_id, enable);

  if (enable) {
    const target = bu ? bu.tg_id : Number(String(email).replace(/^tg_/, ''));
    if (target) {
      try {
        await ctx.telegram.sendMessage(
          target,
          '🎉 Ваша подписка активирована! Нажмите «🔗 Подписка», чтобы получить ссылку.'
        );
      } catch (e) {
        // пользователь мог заблокировать бота
      }
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

/** /enable и /disable аргумент — tg_id или email клиента панели. */
async function resolveEmail(arg) {
  const asNum = parseInt(arg, 10);
  if (asNum) {
    const user = await db.getUserByTgId(asNum);
    if (user) return user.email;
    // tg_id есть, но в базе бота такого нет — ищем среди клиентов панели
    const pc = await api.getClientByTgId(asNum);
    if (pc) return pc.email;
    return String(arg);
  }
  return String(arg);
}

async function cmdEnable(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const arg = (ctx.message.text || '').split(' ')[1];
  if (!arg) return ctx.reply('Использование: /enable <tg_id или email>');

  const email = await resolveEmail(arg);
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
  if (!arg) return ctx.reply('Использование: /disable <tg_id или email>');

  const email = await resolveEmail(arg);
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
  if (!arg) return ctx.reply('Использование: /delete <tg_id или email>');

  const email = await resolveEmail(arg);
  const user = await db.getUserByEmail(email);
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
