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

async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;

  const existing = await db.getUserByTgId(tgId);
  if (existing) {
    // Запись в базе есть, но клиента могли удалить в веб-интерфейсе панели.
    // Тогда /start не отказывает, а пересоздаёт клиента — иначе пользователь
    // остаётся с «призрачной» подпиской, которая ничего не отдаёт.
    if (await api.clientExists(existing.email) === false) {
      return recoverSubscription(ctx, existing);
    }
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

    await ctx.reply(
      `✅ Аккаунт создан.\n\n` +
      `📋 Email: ${email}\n` +
      `📊 Лимит: ${cfg.default_traffic_gb === 0 ? '♾ Без ограничений' : cfg.default_traffic_gb + ' ГБ — общий на все инбаунды'}\n` +
      `⏸ Ожидание активации администратором`,
      mainKeyboard(ctx, cfg)
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка регистрации: ${err.message}`);
  }
}

/**
 * Восстановление подписки: клиента удалили в панели, а запись в базе бота осталась.
 * Создаём клиента заново (прежние email и sub_id → ссылка подписки не меняется,
 * прежний лимит), доступ снова выключен до активации админом.
 */
async function recoverSubscription(ctx, user) {
  const cfg = getConfig();

  try {
    const inbounds = await api.getInbounds();
    if (!inbounds.length) {
      return ctx.reply('❌ В панели нет ни одного inbound — восстановление невозможно.');
    }
    const inboundIds = inbounds.map(ib => ib.id);
    const subId = user.sub_id || genSubId();

    const { uuid, total } = await api.registerUser({
      email: user.email,
      subId,
      tgId: user.tg_id,
      inboundIds,
      totalGB: Number(user.traffic_limit) || 0,
    });
    await db.resetUserClient({
      tgId: user.tg_id, uuid: uuid || '', subId, trafficLimit: total,
    });

    return ctx.reply(
      `♻️ Подписка восстановлена\n\n` +
      `Клиент был удалён из панели — мы создали его заново.\n` +
      `📋 Email: ${user.email}\n` +
      `🌐 Инбаундов: ${inboundIds.length}\n` +
      `📊 Лимит: ${total === 0 ? '♾ Без ограничений' : (total / GiB).toFixed(0) + ' ГБ'} — общий на все инбаунды\n` +
      `⏸ Доступ снова активирует администратор`,
      mainKeyboard(ctx, cfg)
    );
  } catch (err) {
    return ctx.reply(`❌ Не удалось восстановить подписку: ${err.message}`);
  }
}

/** Кнопка «♻️ Восстановить» — то же, что /start для «призрачной» подписки. */
async function onRecoverButton(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) return ctx.answerCbQuery('Сначала нажмите /start');

  const exists = await api.clientExists(user.email).catch(() => null);
  if (exists) {
    await ctx.answerCbQuery('✅ Клиент в панели на месте');
    return cmdMySub(ctx);
  }
  await ctx.answerCbQuery('Создаю клиента в панели…');
  return recoverSubscription(ctx, user);
}

/** Сообщение о том, что подписку удалили из панели, с кнопкой восстановления. */
function subscriptionGone(ctx) {
  return ctx.reply(
    `⚠️ Ваша подписка больше не найдена в панели — обратитесь к администратору.\n\n` +
    `Можно восстановить её самостоятельно: клиент будет создан заново, ` +
    `активацию потребуется подтвердить повторно.`,
    Markup.inlineKeyboard([[Markup.button.callback('♻️ Восстановить подписку', 'sub:recover')]])
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

  // Панель — источник истины о статусе: клиента могли включить прямо в ней
  // или удалить в веб-интерфейсе. refreshStatus обновляет is_active и ставит
  // флаг panelMissing, если записи о клиенте в панели больше нет.
  const fresh = await refreshStatus(user);
  if (fresh.panelMissing) {
    return subscriptionGone(ctx);
  }
  if (!fresh.is_active) {
    return ctx.reply('⏸ Ваша подписка ещё не активирована администратором.', mainKeyboard(ctx, cfg));
  }

  return sendSubLink(ctx, fresh);
}

/**
 * Сверяет локальный флаг is_active с реальным состоянием клиента в панели.
 * Позволяет включать и выключать подписки прямо в 3x-ui без рассинхрона в боте.
 * Если записи о клиенте в панели уже нет (удалили в веб-интерфейсе), доступ
 * закрывается — иначе бот отдавал бы ссылку, которая не работает.
 */
async function refreshStatus(user) {
  try {
    const t = await api.getClientTraffic(user.email);
    if (!t) {
      // Строки трафика ещё нет, но клиент в панели есть — статус не трогаем.
      // null = панель не ответила определённо, тоже не трогаем.
      if (await api.clientExists(user.email) !== false) return user;
      if (Number(user.is_active)) await db.setActive(user.tg_id, false);
      user.is_active = 0;
      user.panelMissing = true;
      return user;
    }
    if (t.enable !== undefined) {
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
  // findUser, а не только база бота: клиент, заведённый вручную в панели с tgId,
  // должен получать QR так же, как /sub и /stats
  const user = await findUser(ctx);
  if (!user) return ctx.answerCbQuery('Сначала нажмите /start');
  const fresh = await refreshStatus(user);
  if (fresh.panelMissing) {
    return ctx.answerCbQuery('⚠️ Подписка не найдена в панели — нажмите /start для восстановления', { show_alert: true });
  }
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
    const unlimited = limit === 0;
    const remaining = unlimited ? 0 : Math.max(0, limit - used);
    const pct = !unlimited && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const filled = Math.round(pct / 10);
    const bar = unlimited ? '' : '▓'.repeat(filled) + '░'.repeat(10 - filled) + '\n';

    await ctx.reply(
      `📊 Статистика подписки\n\n` +
      `📡 Статус: ${traffic.enable ? '🟢 Активен' : '🔴 Неактивен'}\n` +
      `⬇️ Скачано: ${(traffic.down / GiB).toFixed(2)} ГБ\n` +
      `⬆️ Отдано: ${(traffic.up / GiB).toFixed(2)} ГБ\n` +
      `🔄 Израсходовано: ${(used / GiB).toFixed(2)} ГБ${unlimited ? '' : ' (' + pct + '%)'}\n` +
      (unlimited ? '' : bar) +
      `📏 Лимит: ${unlimited ? '♾ Без ограничений' : (limit / GiB).toFixed(0) + ' ГБ'} — общий на все инбаунды\n` +
      (unlimited ? '' : `✅ Остаток: ${(remaining / GiB).toFixed(2)} ГБ`),
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
  const fresh = await refreshStatus(user);
  if (fresh.panelMissing) {
    return subscriptionGone(ctx);
  }
  return sendStats(ctx, fresh);
}

async function cmdHelp(ctx) {
  const cfg = getConfig();
  await ctx.reply(
    `📖 Как пользоваться ботом\n\n` +
    `1️⃣ /start — регистрация, клиент создаётся во всех инбаундах\n` +
    `2️⃣ Активация администратором\n` +
    `3️⃣ «Подписка» — ссылка для приложения, «QR-код» — картинка для телефона\n\n` +
    `📏 Лимит ${cfg.default_traffic_gb === 0 ? '♾ без ограничений' : cfg.default_traffic_gb + ' ГБ'} расходуется суммарно по всем инбаундам.\n\n` +
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
    // cmdStats сам разберётся: база бота → импорт клиента панели → сверка статуса
    return cmdStats(ctx);
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
  onQrButton,
  onRecoverButton,
  recoverSubscription,
  onMenuCallback,
};
