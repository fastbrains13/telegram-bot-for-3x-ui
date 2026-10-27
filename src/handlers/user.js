const QRCode = require('qrcode');
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

async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;

  if (await db.getUserByTgId(tgId)) {
    return ctx.reply('ℹ️ Вы уже зарегистрированы. Используйте /my_sub для просмотра подписки.');
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

    // Приглашение в Telegram-группу панели (бот должен быть админом с правом Invite users)
    let groupLine = '';
    if (cfg.tg_group_id) {
      try {
        const link = await ctx.telegram.createChatInviteLink(cfg.tg_group_id, { member_limit: 1 });
        groupLine = `\n👥 Группа: ${link.invite_link}`;
      } catch (e) {
        // Недостаточно прав в группе — пропускаем без ошибки регистрации
      }
    }

    await ctx.reply(
      `✅ Регистрация успешна!\n\n` +
      `📋 Ваш email: ${email}\n` +
      (uuid ? `🔑 UUID: ${uuid}\n` : '') +
      `🌐 Доступно инбаундов: ${inboundIds.length}\n` +
      `📊 Лимит трафика: ${cfg.default_traffic_gb} ГБ — общий на все инбаунды\n` +
      `⏸ Статус: Ожидание активации администратором${groupLine}\n\n` +
      `После активации используйте /my_sub для получения подписки.`
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка регистрации: ${err.message}`);
  }
}

async function cmdMySub(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Используйте /start для регистрации.');
  }
  if (!user.is_active) {
    return ctx.reply('⏸ Ваша подписка ещё не активирована администратором.');
  }

  const subUrl = await api.getSubscriptionUrl(user.sub_id);

  try {
    const qrData = await QRCode.toBuffer(subUrl, { type: 'png', width: 300 });
    await ctx.replyWithPhoto({ source: qrData }, { caption: `📱 QR-код подписки:\n${subUrl}` });
  } catch (e) {
    // не критично, ссылку отправим текстом ниже
  }

  await ctx.reply(
    `🔗 Ссылка подписки:\n${subUrl}\n\n` +
    `Статистика — /stats, список команд — /help`
  );
}

async function cmdStats(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Используйте /start для регистрации.');
  }

  try {
    const traffic = await api.getClientTraffic(user.email);
    if (!traffic) {
      return ctx.reply('📊 Статистика пока недоступна.');
    }

    const used = (traffic.up || 0) + (traffic.down || 0);
    const limit = user.traffic_limit || traffic.total || 0;
    const remaining = Math.max(0, limit - used);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

    await ctx.reply(
      `📊 Статистика подписки\n\n` +
      `📡 Статус: ${traffic.enable ? '🟢 Активен' : '🔴 Неактивен'}\n` +
      `⬆️ Отдано: ${(traffic.up / GiB).toFixed(2)} ГБ\n` +
      `⬇️ Скачано: ${(traffic.down / GiB).toFixed(2)} ГБ\n` +
      `🔄 Израсходовано: ${(used / GiB).toFixed(2)} ГБ (${pct}%)\n` +
      `📏 Лимит: ${(limit / GiB).toFixed(0)} ГБ\n` +
      `✅ Остаток: ${(remaining / GiB).toFixed(2)} ГБ\n\n` +
      `Лимит общий — расходуется суммарно по всем инбаундам.`
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка получения статистики: ${e.message}`);
  }
}

async function cmdHelp(ctx) {
  const cfg = getConfig();

  let msg = `📖 Команды пользователя:\n`;
  msg += `/start — регистрация\n`;
  msg += `/my_sub — получить ссылку и QR-код\n`;
  msg += `/stats — статистика трафика\n`;

  if (String(ctx.from.id) === String(cfg.admin_tg_id)) {
    msg += `\n👑 Команды админа:\n`;
    msg += `/dashboard — панель управления\n`;
    msg += `/users — список пользователей\n`;
    msg += `/enable <tg_id> — активировать\n`;
    msg += `/disable <tg_id> — деактивировать\n`;
    msg += `/broadcast <сообщение> — рассылка всем\n`;
    msg += `/delete <tg_id> — удалить\n`;
  }

  await ctx.reply(msg);
}

module.exports = { cmdStart, cmdMySub, cmdStats, cmdHelp };
