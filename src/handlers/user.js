const QRCode = require('qrcode');
const { Markup } = require('telegraf');
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

const GiB = 1024 * 1024 * 1024;

function genSubId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isAdmin(ctx) {
  return String(ctx.from.id) === String(getConfig().admin_tg_id);
}

/** Главное меню — inline-кнопки вместо перечисления команд текстом. */
function mainKeyboard(ctx, cfg) {
  const rows = [];
  if (cfg.tg_group_id && cfg.group_link) {
    rows.push([Markup.button.url('👥 Наша группа', cfg.group_link)]);
  }
  rows.push(
    [
      Markup.button.callback('🔗 Подписка', 'menu:sub'),
      Markup.button.callback('📊 Статистика', 'menu:stats'),
    ],
    [
      Markup.button.callback('📱 QR-код', 'menu:qr'),
      Markup.button.callback('📖 Помощь', 'menu:help'),
    ]
  );
  if (isAdmin(ctx)) {
    rows.push([Markup.button.callback('👑 Панель администратора', 'menu:admin')]);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Ссылка-приглашение в группу выдаётся всегда:
 * сначала персональная ссылка (бот-админ с Invite users),
 * при неудаче — публичная ссылка из конфига.
 */
async function getGroupLink(ctx, cfg) {
  if (!cfg.tg_group_id) return { link: '', required: false };

  try {
    const inv = await ctx.telegram.createChatInviteLink(cfg.tg_group_id, {
      member_limit: 100000,
      name: `bot_user_${ctx.from.id}`,
    });
    if (inv && inv.invite_link) return { link: inv.invite_link, required: true };
  } catch (e) {
    // нет прав админа в группе — переходим к публичной ссылке
  }

  if (cfg.group_link) return { link: cfg.group_link, required: true };

  throw new Error(
    'не удалось получить ссылку-приглашение в группу. Добавьте бота админом в группу ' +
    'с правом «Invite users» или пропишите публичную ссылку в data/config.json → group_link.'
  );
}

/** Проверка членства в группе. */
async function isGroupMember(ctx, tgId) {
  const cfg = getConfig();
  if (!cfg.tg_group_id) return true;
  try {
    const member = await ctx.telegram.getChatMember(cfg.tg_group_id, tgId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (e) {
    return false;
  }
}

async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;

  if (await db.getUserByTgId(tgId)) {
    return ctx.reply('ℹ️ Вы уже зарегистрированы. Откройте подписку кнопкой ниже.', mainKeyboard(ctx, cfg));
  }

  const email = `tg_${tgId}`;
  const subId = genSubId();

  try {
    const inbounds = await api.getInbounds();
    if (!inbounds.length) {
      return ctx.reply('❌ В панели нет ни одного inbound — регистрация невозможна.');
    }
    const inboundIds = inbounds.map(ib => ib.id);

    const { uuid, total } = await api.registerUser({ email, subId, tgId, inboundIds });

    await db.registerUser({
      tgId,
      username: ctx.from.username || '',
      firstName: ctx.from.first_name || '',
      email,
      uuid: uuid || '',
      subId,
      trafficLimit: total,
    });

    // Привязка к группе обязательна: без неё регистрация не завершена
    let group = { link: '', required: false };
    try {
      group = await getGroupLink(ctx, cfg);
    } catch (e) {
      await api.deleteClient(email);
      await db.deleteUser(tgId);
      return ctx.reply(`❌ Регистрация отменена: ${e.message}`);
    }

    if (group.required) {
      await db.setGroupJoined(tgId, false, group.link);
      const joined = await isGroupMember(ctx, tgId);
      if (joined) await db.setGroupJoined(tgId, true, group.link);

      return ctx.reply(
        `✅ Аккаунт создан, но нужно вступить в группу.\n\n` +
        `📋 Email: ${email}\n` +
        `📊 Лимит: ${cfg.default_traffic_gb} ГБ — общий на все инбаунды\n` +
        `⏸ Доступ активирует администратор\n\n` +
        `👉 Нажмите «Вступить в группу», затем «Я вступил». ` +
        `Пока вы в группе не подтверждены, подписка не откроется.`,
        Markup.inlineKeyboard([
          [Markup.button.url('👥 Вступить в группу', group.link)],
          [Markup.button.callback(joined ? '✅ Вы в группе' : '✔️ Я вступил', 'grp:check')],
        ])
      );
    }

    await ctx.reply(
      `✅ Регистрация успешна!\n\n` +
      `📋 Email: ${email}\n` +
      `🌐 Инбаундов: ${inboundIds.length}\n` +
      `📊 Лимит: ${cfg.default_traffic_gb} ГБ — общий на все инбаунды\n` +
      `⏸ Ожидание активации администратором`,
      mainKeyboard(ctx, cfg)
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка регистрации: ${err.message}`);
  }
}

/** Кнопка «Я вступил» — проверяем состав группы. */
async function onGroupCheck(ctx) {
  const tgId = ctx.from.id;
  const user = await db.getUserByTgId(tgId);
  if (!user) return ctx.answerCbQuery('Сначала нажмите /start');

  const joined = await isGroupMember(ctx, tgId);
  if (!joined) {
    await db.setGroupJoined(tgId, false, user.group_invite_link || '');
    return ctx.answerCbQuery('❌ Вас нет в группе — вступите и нажмите снова', { show_alert: true });
  }

  await db.setGroupJoined(tgId, true, user.group_invite_link || '');
  await ctx.answerCbQuery('✅ Группа подтверждена');
  return ctx.reply(
    `✅ Группа подтверждена!\n\n⏸ Осталось дождаться активации подписки администратором.`,
    mainKeyboard(ctx, getConfig())
  );
}

async function sendSubLink(ctx, user) {
  const subUrl = await api.getSubscriptionUrl(user.sub_id);
  return ctx.reply(
    `🔗 Ссылка подписки — вставьте её в приложение:\n${subUrl}\n\n` +
    `📱 QR-код — по кнопке ниже.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📱 Показать QR-код', 'sub:qr')],
      [Markup.button.callback('📊 Статистика', 'menu:stats')],
    ])
  );
}

/**
 * Находит пользователя: сначала в базе бота, затем среди клиентов панели
 * (на случай, когда админ завёл клиента вручную и указал его tgId).
 */
async function findUser(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (user) return user;
  const pc = await api.getClientByTgId(ctx.from.id).catch(() => null);
  if (!pc || !pc.email) return null;
  return db.importPanelClient({
    tgId: ctx.from.id, email: pc.email, subId: pc.subId, uuid: pc.uuid, trafficLimit: pc.total,
  });
}

async function cmdMySub(ctx) {
  const cfg = getConfig();
  const user = await findUser(ctx);

  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Нажмите /start для регистрации.');
  }

  // Подписка доступна только привязанным к группе
  if (cfg.tg_group_id && !user.group_joined) {
    const rows = [];
    if (user.group_invite_link) {
      rows.push([Markup.button.url('👥 Вступить в группу', user.group_invite_link)]);
    }
    rows.push([Markup.button.callback('✔️ Я вступил', 'grp:check')]);
    return ctx.reply('⛔ Подписка доступна только после вступления в нашу Telegram-группу.', Markup.inlineKeyboard(rows));
  }

  // Панель — источник истины о статусе: клиента могли включить прямо в ней
  const fresh = await refreshStatus(user);
  if (!fresh.is_active) {
    return ctx.reply('⏸ Ваша подписка ещё не активирована администратором.', mainKeyboard(ctx, cfg));
  }

  return sendSubLink(ctx, fresh);
}

/**
 * Сверяет локальный флаг is_active с реальным состоянием клиента в панели.
 * Позволяет включать и выключать подписки прямо в 3x-ui без рассинхрона в боте.
 */
async function refreshStatus(user) {
  try {
    const t = await api.getClientTraffic(user.email);
    if (t && t.enable !== undefined) {
      const active = t.enable ? 1 : 0;
      if (Number(user.is_active) !== active) {
        await db.setActive(user.tg_id, !!active);
        user.is_active = active;
      }
    }
  } catch (e) {
    /* панель недоступна — оставляем локальный флаг */
  }
  return user;
}

/** QR отправляем отдельным сообщением — по нажатию кнопки. */
async function sendQr(ctx, user) {
  const subUrl = await api.getSubscriptionUrl(user.sub_id);
  try {
    const qr = await QRCode.toBuffer(subUrl, { type: 'png', width: 400, margin: 2 });
    return ctx.replyWithPhoto({ source: qr }, { caption: `📱 QR-код подписки\n${subUrl}` });
  } catch (e) {
    return ctx.reply(`❌ Не удалось сгенерировать QR: ${e.message}`);
  }
}

async function onQrButton(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) return ctx.answerCbQuery('Сначала нажмите /start');
  if (getConfig().tg_group_id && !user.group_joined) {
    return ctx.answerCbQuery('⛔ Сначала вступите в группу', { show_alert: true });
  }
  const fresh = await refreshStatus(user);
  if (!fresh.is_active) {
    return ctx.answerCbQuery('⏸ Подписка ещё не активирована', { show_alert: true });
  }
  await ctx.answerCbQuery('Готовлю QR…');
  return sendQr(ctx, fresh);
}

async function sendStats(ctx, user) {
  try {
    const traffic = await api.getClientTraffic(user.email);
    if (!traffic) {
      return ctx.reply('📊 Статистика пока недоступна.', mainKeyboard(ctx, getConfig()));
    }

    const used = (traffic.up || 0) + (traffic.down || 0);
    const limit = user.traffic_limit || traffic.total || 0;
    const remaining = Math.max(0, limit - used);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const filled = Math.round(pct / 10);
    const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);

    await ctx.reply(
      `📊 Статистика подписки\n\n` +
      `📡 Статус: ${traffic.enable ? '🟢 Активен' : '🔴 Неактивен'}\n` +
      `⬇️ Скачано: ${(traffic.down / GiB).toFixed(2)} ГБ\n` +
      `⬆️ Отдано: ${(traffic.up / GiB).toFixed(2)} ГБ\n` +
      `🔄 Израсходовано: ${(used / GiB).toFixed(2)} ГБ (${pct}%)\n` +
      `${bar}\n` +
      `📏 Лимит: ${(limit / GiB).toFixed(0)} ГБ — общий на все инбаунды\n` +
      `✅ Остаток: ${(remaining / GiB).toFixed(2)} ГБ`,
      mainKeyboard(ctx, getConfig())
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка получения статистики: ${e.message}`);
  }
}

async function cmdStats(ctx) {
  const user = await findUser(ctx);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Нажмите /start для регистрации.');
  }
  return sendStats(ctx, await refreshStatus(user));
}

async function cmdHelp(ctx) {
  const cfg = getConfig();
  await ctx.reply(
    `📖 Как пользоваться ботом\n\n` +
    `1️⃣ /start — регистрация, клиент создаётся во всех инбаундах\n` +
    `2️⃣ Вступление в Telegram-группу — обязательно\n` +
    `3️⃣ Активация администратором\n` +
    `4️⃣ «Подписка» — ссылка для приложения, «QR-код» — картинка для телефона\n\n` +
    `📏 Лимит ${cfg.default_traffic_gb} ГБ расходуется суммарно по всем инбаундам.\n\n` +
    `Все действия — кнопками ниже.`,
    mainKeyboard(ctx, cfg)
  );
}

/** Нажатия кнопок главного меню. */
async function onMenuCallback(ctx) {
  const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';
  const cfg = getConfig();

  if (data === 'menu:sub') {
    await ctx.answerCbQuery();
    return cmdMySub(ctx);
  }
  if (data === 'menu:stats') {
    await ctx.answerCbQuery();
    const user = await db.getUserByTgId(ctx.from.id);
    if (!user) return ctx.reply('❌ Вы не зарегистрированы. Нажмите /start.');
    return sendStats(ctx, user);
  }
  if (data === 'menu:qr') return onQrButton(ctx);
  if (data === 'menu:help') {
    await ctx.answerCbQuery();
    return cmdHelp(ctx);
  }
  if (data === 'menu:admin') {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ запрещён.');
    return require('./admin').cmdDashboard(ctx);
  }
  return ctx.answerCbQuery();
}

module.exports = {
  cmdStart,
  cmdMySub,
  cmdStats,
  cmdHelp,
  sendQr,
  findUser,
  mainKeyboard,
  onGroupCheck,
  onQrButton,
  onMenuCallback,
  isGroupMember,
};
