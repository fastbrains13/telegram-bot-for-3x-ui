const { Markup } = require('telegraf');
const { getConfig, saveConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;
// Лимит текста сообщения в Telegram — 4096 символов; держим запас на хедер частей
const MAX_MESSAGE = 3600;

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Панель отвечает «... not found ...», если записи клиента уже нет (удалили в веб-UI). */
function isNotFound(e) {
  return /not\s*found/i.test(String((e && e.message) || ''));
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
    const groupName = String(cfg.panel_client_group || '').trim();
    const groupLine = `\n🏷 Группа для новых клиентов: ${groupName ? `<b>${esc(groupName)}</b>` : '(без группы)'}`;

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
      `<a href="${cmdLink(botInfo.username, 'users', '')}">/users</a> — абсолютно все клиенты панели, ссылки вкл/выкл/удалить\n` +
      `<a href="${cmdLink(botInfo.username, 'enable', '')}">/enable</a> &lt;tg_id или email&gt; — включить подписку\n` +
      `<a href="${cmdLink(botInfo.username, 'disable', '')}">/disable</a> &lt;tg_id или email&gt; — выключить подписку\n` +
      `<a href="${cmdLink(botInfo.username, 'delete', '')}">/delete</a> &lt;tg_id или email&gt; — удалить из панели и базы\n` +
      `<a href="${cmdLink(botInfo.username, 'setgroup', '')}">/setgroup</a> [&lt;имя&gt;] — группа панели для новых клиентов\n` +
      `<a href="${cmdLink(botInfo.username, 'broadcast', ' ')}}">/broadcast</a> &lt;текст&gt; — рассылка всей базе`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('👥 Пользователи', 'adm:users'),
            Markup.button.callback('🏷 Группа клиентов', 'adm:group'),
          ],
          [Markup.button.callback('🔄 Обновить', 'adm:dashboard')],
        ]).reply_markup,
      }
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

/**
 * /users — ВСЕ клиенты панели, включая заведённых вручную.
 * Список не режется по количеству: лимит Telegram — длина сообщения, поэтому
 * блоки склеиваются по размеру и отправляются несколькими сообщениями,
 * чтобы админ видел каждого клиента, а не первую десятку.
 */
async function buildUsersPage(ctx) {
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

  // Свои (из базы бота) — первыми, затем остальные клиенты панели
  const own = clients.filter(c => byEmail.has(c.email));
  const foreign = clients.filter(c => !byEmail.has(c.email));
  const sorted = [...own, ...foreign];

  if (!sorted.length) return ctx.reply('👥 В панели нет клиентов.');

  const blocks = sorted.map(c => {
    const bu = byEmail.get(c.email);
    const used = (c.up || 0) + (c.down || 0);
    const mark = bu ? (bu.is_active ? '🟢' : '🔴') : '⚪';
    const who = bu
      ? `${bu.tg_id} · ${esc(bu.tg_first_name || bu.tg_username || 'без имени')}`
      : (c.tgId ? `${c.tgId} · вручную` : 'без Telegram ID');

    // Ссылки-команды: открывают чат с уже набранным сообщением
    const toggle = c.enable
      ? `<a href="${cmdLink(bot, 'disable', c.email)}">⏸ Выключить</a>`
      : `<a href="${cmdLink(bot, 'enable', c.email)}">▶️ Включить</a>`;

    return `${mark} <code>${esc(c.email)}</code> — ${who}\n` +
      `   ${fmtGB(used)} из ${fmtGB(c.total || 0)} · ${c.enable ? '🟢 вкл' : '🔴 выкл'}\n` +
      `   ${toggle} · <a href="${cmdLink(bot, 'delete', c.email)}">🗑 Удалить</a>\n\n`;
  });

  const parts = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length > MAX_MESSAGE) {
      parts.push(cur);
      cur = '';
    }
    cur += b;
  }
  if (cur) parts.push(cur);

  for (let i = 0; i < parts.length; i++) {
    const head = i === 0
      ? `👥 Все клиенты панели: ${sorted.length}\n` +
        `🗂 Через бота: ${own.length} · ➕ Заведены вручную: ${foreign.length}\n\n`
      : `👥 Клиенты панели: ${sorted.length}\n\n`;
    const tag = parts.length > 1 ? `📄 Часть ${i + 1} из ${parts.length}\n\n` : '';

    const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (i === parts.length - 1) {
      Object.assign(opts, Markup.inlineKeyboard([[
        Markup.button.callback('🔄 Обновить', 'adm:users'),
        Markup.button.callback('🏷 Группа', 'adm:group'),
        Markup.button.callback('👑 Дашборд', 'adm:dashboard'),
      ]]).reply_markup);
    }
    await ctx.reply(head + tag + parts[i], opts);
    // Чересчур быстрые сообщения Telegram режет лимитом 429 — выдерживаем паузу
    if (i < parts.length - 1) await sleep(1100);
  }
}

async function cmdUsers(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');
  return buildUsersPage(ctx);
}

/**
 * Экран выбора группы клиентов панели: показывает реальные группы из панели
 * с количеством клиентов и ссылки-команды /setgroup <имя>.
 */
async function buildGroupScreen(ctx) {
  const cfg = getConfig();
  const current = String(cfg.panel_client_group || '').trim();
  const bot = (await ctx.telegram.getMe()).username;

  let clients = [];
  let groups = [];
  try {
    clients = await api.getPanelClients();
    groups = await api.getClientGroups();
  } catch (e) {
    return ctx.reply(`❌ Не удалось получить клиентов из панели: ${e.message}`);
  }

  let msg = `🏷 ГРУППА КЛИЕНТОВ В ПАНЕЛИ\n\n` +
    `Сейчас новые клиенты добавляются в: <b>${current ? esc(current) : '(без группы)'}</b>\n\n`;

  if (!clients.length) {
    msg += `📋 В панели пока нет клиентов — группа появится после создания первого.\n\n`;
  } else {
    msg += `👥 Клиентов в панели: ${clients.length}\n`;
    for (const g of groups) {
      const mark = g.name === current ? ' ✅' : '';
      // Пустую группу выбираем sentinel'-ом "-": пустой аргумент /setgroup — это экран
      const arg = g.name || '-';
      msg += `• <a href="${cmdLink(bot, 'setgroup', arg)}">${g.name ? esc(g.name) : '(без группы)'}</a> — ${g.count}${mark}\n`;
    }
    msg += `\nНажмите на группу, чтобы выбрать её, или введите <code>/setgroup имя_группы</code> для новой.\n`;
    msg += `<code>/setgroup -</code> — добавлять клиентов без группы.\n\n`;
  }

  msg += `⚠️ Существующие клиенты не переносятся — меняется только группа для новых регистраций.`;

  return ctx.reply(msg, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Обновить', 'adm:group'),
        Markup.button.callback('👑 Дашборд', 'adm:dashboard'),
      ],
    ]).reply_markup,
  });
}

/**
 * /setgroup <имя> — задать группу клиентов панели для новых регистраций.
 * Без аргумента — показать экран выбора с реальными группами из панели.
 */
async function cmdSetGroup(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const text = (ctx.message.text || '').trim();
  const arg = text.replace(/^\/setgroup\s*/, '').trim();

  if (!arg) return buildGroupScreen(ctx);

  // "-" — явный выбор «без группы» (пустой аргумент открывает экран выбора)
  const name = /^[-—]$/.test(arg) ? '' : arg;

  // Имя группы: без переносов, вразумительной длины
  if (/[\r\n]/.test(arg)) return ctx.reply('❌ Имя группы не должно содержать перенос строки.');
  if (Buffer.byteLength(arg, 'utf8') > 60) return ctx.reply('❌ Имя группы слишком длинное (максимум 60 байт).');

  const cfg = getConfig();
  const prev = String(cfg.panel_client_group || '').trim();
  cfg.panel_client_group = name;
  saveConfig(cfg);

  let count = 0;
  try {
    count = (await api.getPanelClients()).filter(c => String(c.group || '').trim() === name).length;
  } catch (e) {
    count = -1;
  }

  const exists = count > 0;
  const note = count < 0
    ? `Панель недоступна — проверить количество клиентов в группе не удалось.`
    : exists
      ? `В группе уже ${count} ${pluralRu(count)}.`
      : (name ? `Группы «${name}» ещё нет в панели — она появится после создания первого клиента.`
              : 'Клиенты создаются без группы — в панели они окажутся в разделе без названия.');

  return ctx.reply(
    `🏷 Группа для новых клиентов: <b>${name ? esc(name) : '(без группы)'}</b>\n` +
    (prev !== name ? `Было: ${prev ? esc(prev) : '(без группы)'}\n` : '') +
    `${note}\n\n` +
    `⚠️ Существующие клиенты не переносятся.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🏷 Все группы', 'adm:group'),
          Markup.button.callback('👑 Дашборд', 'adm:dashboard'),
        ],
      ]).reply_markup,
    }
  );
}

function pluralRu(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'клиент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'клиента';
  return 'клиентов';
}

/** Общая логика вкл/выкл — используется и командами, и кнопками. */
async function toggleClient(ctx, email, enable) {
  const bu = await db.getUserByEmail(email);

  try {
    await api.setClientActive(email, enable);
  } catch (e) {
    if (isNotFound(e)) {
      throw new Error(`клиента ${email} нет в панели — запись в базе бота устарела, удалите её через /delete ${email}`);
    }
    throw e;
  }
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

  // adm:users:N — старая пагинация; номер игнорируется, показываем всех
  if (/^adm:users(?::\d+)?$/.test(data)) {
    await ctx.answerCbQuery();
    return buildUsersPage(ctx);
  }

  if (data === 'adm:group') {
    await ctx.answerCbQuery();
    return buildGroupScreen(ctx);
  }

  const toggleMatch = data.match(/^adm:tgl:(on|off):(.+)$/);
  if (toggleMatch) {
    const email = toggleMatch[2];
    const enable = toggleMatch[1] === 'on';
    try {
      await toggleClient(ctx, email, enable);
      await ctx.answerCbQuery(enable ? '✅ Включён' : '⏸ Выключен');
      return buildUsersPage(ctx);
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

  // Клиента могли удалить раньше прямо в веб-интерфейсе панели. Отсутствие
  // записи — не ошибка: в этом случае убираем хотя бы «мёртвую» строку из базы.
  let wasInPanel = true;
  try {
    await api.deleteClient(email);
  } catch (e) {
    if (!isNotFound(e)) return ctx.reply(`❌ Ошибка: ${e.message}`);
    wasInPanel = false;
  }

  if (user) await db.deleteUser(user.tg_id);
  await ctx.reply(
    wasInPanel
      ? `🗑 ${email} удалён из панели и базы.`
      : `🗑 ${email}: в панели записи уже не было, убран из базы бота.`
  );
}

module.exports = {
  cmdDashboard,
  cmdUsers,
  cmdEnable,
  cmdDisable,
  cmdBroadcast,
  cmdDelete,
  cmdSetGroup,
  onAdminCallback,
};
