const { Markup } = require('telegraf');
const { getConfig, saveConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;
const PAGE_SIZE = 15;

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
    const limitGB = Number(cfg.default_traffic_gb) || 0;
    const limitLine = `\n📏 Лимит по умолчанию: ${limitGB === 0 ? '♾ Без ограничений' : limitGB + ' ГБ'}`;

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
      `🔌 API: ${mode} — ${quotaNote}${groupLine}${limitLine}\n\n` +
      `👑 КОМАНДЫ АДМИНИСТРАТОРА\n` +
      `🔗 Ниже — кнопки для быстрого доступа к командам.`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('👥 Пользователи', 'adm:users:0'),
            Markup.button.callback('🏷 Группа клиентов', 'adm:group'),
          ],
          [
            Markup.button.callback('▶️ /enable', 'adm:enable'),
            Markup.button.callback('⏸ /disable', 'adm:disable'),
          ],
          [Markup.button.callback('🗑 /delete', 'adm:delete')],
          [Markup.button.callback('📢 /broadcast', 'adm:broadcast')],
          [Markup.button.callback('📏 Лимит', 'adm:limit')],
          [Markup.button.callback('🔄 Обновить', 'adm:dashboard')],
        ]),
      }
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}

/**
 * /users — клиенты панели с пагинацией по 15 человек на страницу.
 * Свои (из базы бота) — первыми, затем заведённые вручную.
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

  const own = clients.filter(c => byEmail.has(c.email));
  const foreign = clients.filter(c => !byEmail.has(c.email));
  const sorted = [...own, ...foreign];

  if (!sorted.length) return ctx.reply('👥 В панели нет клиентов.');

  const pages = Math.ceil(sorted.length / PAGE_SIZE);
  const cur = Math.max(0, Math.min(page || 0, pages - 1));
  const slice = sorted.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);

  let msg = `👥 Клиенты панели: ${sorted.length}\n` +
    `🗂 Через бота: ${own.length} · ➕ Вручную: ${foreign.length}\n` +
    `Страница ${cur + 1} из ${pages}\n\n`;

  for (const c of slice) {
    const bu = byEmail.get(c.email);
    const used = (c.up || 0) + (c.down || 0);
    const mark = bu ? (bu.is_active ? '🟢' : '🔴') : '⚪';
    const who = bu
      ? `${bu.tg_id} · ${esc(bu.tg_first_name || bu.tg_username || 'без имени')}`
      : (c.tgId ? `${c.tgId} · вручную` : 'без Telegram ID');

    const toggle = c.enable
      ? `<a href="${cmdLink(bot, 'disable', c.email)}">⏸ Выключить</a>`
      : `<a href="${cmdLink(bot, 'enable', c.email)}">▶️ Включить</a>`;

    msg += `${mark} <code>${esc(c.email)}</code> — ${who}\n` +
      `   ${fmtGB(used)} из ${fmtGB(c.total || 0)} · ${c.enable ? '🟢 вкл' : '🔴 выкл'}\n` +
      `   ${toggle} · <a href="${cmdLink(bot, 'delete', c.email)}">🗑 Удалить</a>\n\n`;
  }

  const nav = [];
  if (cur > 0) nav.push(Markup.button.callback('◀️ Назад', `adm:users:${cur - 1}`));
  nav.push(Markup.button.callback('🔄 Обновить', `adm:users:${cur}`));
  nav.push(Markup.button.callback('👑 Дашборд', 'adm:dashboard'));
  if (cur < pages - 1) nav.push(Markup.button.callback('Вперёд ▶️', `adm:users:${cur + 1}`));

  return ctx.reply(msg, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([nav]),
  });
}

async function cmdUsers(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');
  return buildUsersPage(ctx, 0);
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
    ]),
  });
}

/**
 * /setlimit <ГБ> — задать лимит трафика по умолчанию для новых клиентов.
 * 0 = без ограничений. Без аргумента — экран выбора.
 */
async function cmdSetLimit(ctx) {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');

  const text = (ctx.message.text || '').trim();
  const arg = text.replace(/^\/setlimit\s*/, '').trim();

  if (!arg) return buildLimitScreen(ctx);

  const gb = Number(arg);
  if (!Number.isFinite(gb) || gb < 0) {
    return ctx.reply('❌ Укажите число ГБ ≥ 0 или 0 для безлимитного трафика.');
  }

  const cfg = getConfig();
  const prev = cfg.default_traffic_gb;
  cfg.default_traffic_gb = gb;
  saveConfig(cfg);

  return ctx.reply(
    `📏 Лимит изменён\n\n` +
    `Было: ${Number(prev) === 0 ? '♾ Без ограничений' : prev + ' ГБ'}\n` +
    `Стало: ${gb === 0 ? '♾ Без ограничений' : gb + ' ГБ'}\n\n` +
    `⚠️ Изменение действует на НОВЫХ клиентов; существующих не трогает.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📏 Изменить лимит', 'adm:limit')],
        [Markup.button.callback('👑 Дашборд', 'adm:dashboard')],
      ]),
    }
  );
}

/** Экран настройки лимита трафика по умолчанию. */
async function buildLimitScreen(ctx) {
  const cfg = getConfig();
  const cur = Number(cfg.default_traffic_gb) || 0;
  const bot = (await ctx.telegram.getMe()).username;

  const curText = cur === 0 ? '♾ Без ограничений' : cur + ' ГБ';

  const rows = [];
  // Быстрые кнопки-команды
  const quick = [0, 10, 50, 100, 500];
  for (const n of quick) {
    const label = n === 0 ? '♾ Безлимит' : n + ' ГБ';
    rows.push(Markup.button.callback(label, `adm:setlimit:${n}`));
  }

  return ctx.reply(
    `📏 ЛИМИТ ТРАФИКА ПО УМОЛЧАНИЮ\n\n` +
    `Сейчас: <b>${curText}</b>\n\n` +
    `0 = без ограничений (∞), остальные значения — ГБ на все инбаунды.\n` +
    `Действует на НОВЫХ клиентов при регистрации.\n\n` +
    `Можно задать и командой: <code>/setlimit 50</code> или <code>/setlimit 0</code>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          ...rows,
        ],
        [
          Markup.button.callback('👥 Пользователи', 'adm:users:0'),
          Markup.button.callback('👑 Дашборд', 'adm:dashboard'),
        ],
      ]),
    }
  );
}

/** Быстрое изменение лимита по callback */
async function quickSetLimit(ctx, gb) {
  const cfg = getConfig();
  const prev = cfg.default_traffic_gb;
  cfg.default_traffic_gb = gb;
  saveConfig(cfg);

  const curText = gb === 0 ? '♾ Без ограничений' : gb + ' ГБ';
  const prevText = Number(prev) === 0 ? '♾ Без ограничений' : prev + ' ГБ';

  await ctx.answerCbQuery('✅ Лимит обновлён');
  return ctx.reply(
    `📏 Лимит изменён\n\n` +
    `Было: ${prevText}\n` +
    `Стало: ${curText}\n\n` +
    `⚠️ Изменение действует на НОВЫХ клиентов; существующих не трогает.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📏 Изменить лимит', 'adm:limit')],
        [Markup.button.callback('👥 Пользователи', 'adm:users:0')],
        [Markup.button.callback('👑 Дашборд', 'adm:dashboard')],
      ]),
    }
  );
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
      ]),
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

  if (data === 'adm:enable') {
    await ctx.answerCbQuery();
    return ctx.reply('Укажите <code>tg_id</code> или <code>email</code>:\nПример: <code>/enable tg_123456</code>', { parse_mode: 'HTML' });
  }

  if (data === 'adm:disable') {
    await ctx.answerCbQuery();
    return ctx.reply('Укажите <code>tg_id</code> или <code>email</code>:\nПример: <code>/disable tg_123456</code>', { parse_mode: 'HTML' });
  }

  if (data === 'adm:delete') {
    await ctx.answerCbQuery();
    return ctx.reply('Укажите <code>tg_id</code> или <code>email</code>:\nПример: <code>/delete tg_123456</code>', { parse_mode: 'HTML' });
  }

  if (data === 'adm:broadcast') {
    await ctx.answerCbQuery();
    return ctx.reply('Введите текст рассылки:\nПример: <code>/broadcast Привет! Сервис обновлён.</code>', { parse_mode: 'HTML' });
  }

  if (data === 'adm:limit') {
    await ctx.answerCbQuery();
    return buildLimitScreen(ctx);
  }

  const limitMatch = data.match(/^adm:setlimit:(\d+)$/);
  if (limitMatch) {
    return quickSetLimit(ctx, parseInt(limitMatch[1], 10));
  }

  // adm:users:N — пагинация
  if (/^adm:users(?::\d+)?$/.test(data)) {
    await ctx.answerCbQuery();
    const pageMatch = data.match(/^adm:users:(\d+)$/);
    return buildUsersPage(ctx, pageMatch ? parseInt(pageMatch[1], 10) : 0);
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
  cmdSetLimit,
  onAdminCallback,
};
