const QRCode = require('qrcode');
const { getConfig } = require('../config');
const db = require('../database');
const api = require('../api3xui');

function genSubId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

async function cmdStart(ctx) {
  const cfg = getConfig();
  const tgId = ctx.from.id;
  const existing = await db.getUserByTgId(tgId);

  if (existing) {
    return ctx.reply('ℹ️ Вы уже зарегистрированы. Используйте /my_sub для просмотра подписки.');
  }

  const email = `tg_${tgId}`;
  const uuid = await api.getNewUUID();
  const subId = genSubId();

  try {
    await api.registerUser({
      email,
      uuid,
      subId,
      tgId: String(tgId),
    });

    await db.registerUser({
      tgId,
      username: ctx.from.username || '',
      firstName: ctx.from.first_name || '',
      email,
      uuid,
      subId,
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
      `📋 Ваш email: \`${email}\`\n` +
      `🔑 UUID: \`${uuid}\`\n` +
      `📊 Лимит трафика: ${cfg.default_traffic_gb} ГБ\n` +
      `⏸ Статус: Ожидание активации администратором${groupLine}\n\n` +
      `После активации используйте /my_sub для получения подписки.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка регистрации: ${err.message}`);
  }
}

async function cmdMySub(ctx) {
  const tgId = ctx.from.id;
  const user = await db.getUserByTgId(tgId);

  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Используйте /start для регистрации.');
  }

  if (!user.is_active) {
    return ctx.reply('⏸ Ваша подписка ещё не активирована администратором.');
  }

  const cfg = getConfig();
  const subUrl = api.getSubscriptionUrl(user.sub_id);

  try {
    const qrData = await QRCode.toBuffer(subUrl, { type: 'png', width: 300 });
    await ctx.replyWithPhoto({ source: qrData }, { caption: `📱 QR-код подписки:\n${subUrl}` });
  } catch (e) {
    // ignore QR errors
  }

  await ctx.reply(
    `🔗 Ссылка подписки:\n\`${subUrl}\`\n\n` +
    `Для управления используйте /stats (статистика) или /help`,
    { parse_mode: 'Markdown' }
  );
}

async function cmdStats(ctx) {
  const tgId = ctx.from.id;
  const user = await db.getUserByTgId(tgId);

  if (!user) {
    return ctx.reply('❌ Вы не зарегистрированы. Используйте /start для регистрации.');
  }

  try {
    const traffic = await api.getUserStats(user.email);
    if (!traffic) {
      return ctx.reply('📊 Статистика пока недоступна.');
    }

    const upGB = (traffic.up / 1073741824).toFixed(2);
    const downGB = (traffic.down / 1073741824).toFixed(2);
    const totalGB = (traffic.total / 1073741824).toFixed(2);
    const limitGB = (user.traffic_limit / 1073741824).toFixed(0);
    const remaining = ((user.traffic_limit - traffic.total) / 1073741824).toFixed(2);
    const status = traffic.enable ? '🟢 Активен' : '🔴 Неактивен';

    await ctx.reply(
      `📊 Статистика подписки:\n\n` +
      `📡 Статус: ${status}\n` +
      `⬆️ Отдано: ${upGB} ГБ\n` +
      `⬇️ Скачано: ${downGB} ГБ\n` +
      `🔄 Всего: ${totalGB} ГБ\n` +
      `📏 Лимит: ${limitGB} ГБ\n` +
      `✅ Осталось: ${remaining} ГБ`
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
  }

  await ctx.reply(msg);
}

module.exports = { cmdStart, cmdMySub, cmdStats, cmdHelp };
