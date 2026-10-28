const { Telegraf } = require('telegraf');
const { getConfig } = require('./config');
const db = require('./database');
const api = require('./api3xui');
const sync = require('./sync');
const userHandlers = require('./handlers/user');
const adminHandlers = require('./handlers/admin');

async function main() {
  const cfg = getConfig();
  const bot = new Telegraf(cfg.bot_token);

  // Login to 3x-ui panel
  await api.login();
  console.log('✅ Logged in to 3x-ui panel');

  // Set bot commands
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Регистрация' },
    { command: 'sub', description: 'Моя подписка' },
    { command: 'stats', description: 'Статистика' },
    { command: 'help', description: 'Помощь' },
  ]);

  // User commands
  bot.start(userHandlers.cmdStart);
  bot.command('my_sub', userHandlers.cmdMySub);
  bot.command('sub', userHandlers.cmdMySub);
  bot.command('stats', userHandlers.cmdStats);
  bot.command('help', userHandlers.cmdHelp);

  // Admin commands
  bot.command('dashboard', adminHandlers.cmdDashboard);
  bot.command('users', adminHandlers.cmdUsers);
  bot.command('enable', adminHandlers.cmdEnable);
  bot.command('disable', adminHandlers.cmdDisable);
  bot.command('broadcast', adminHandlers.cmdBroadcast);
  bot.command('delete', adminHandlers.cmdDelete);

  // Inline-кнопки
  bot.action(/^grp:check$/, userHandlers.onGroupCheck);
  bot.action(/^sub:qr$/, userHandlers.onQrButton);
  bot.action(/^menu:.+$/, userHandlers.onMenuCallback);
  bot.action(/^adm:.+$/, adminHandlers.onAdminCallback);

  // Error handling
  bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply(`❌ Внутренняя ошибка: ${err.message}`);
  });

  // Launch
  const launchOpts = {};
  if (cfg.webhook_domain && cfg.webhook_secret) {
    launchOpts.domain = cfg.webhook_domain;
    launchOpts.secretToken = cfg.webhook_secret;
    launchOpts.port = cfg.webhook_port || 8443;
    launchOpts.healthCheck = { enabled: true, path: '/health' };
  }

  await bot.launch(launchOpts, () => {
    console.log(`🤖 Bot @${bot.botInfo.username} is running`);
    if (launchOpts.domain) {
      console.log(`   Webhook: https://${launchOpts.domain}:${launchOpts.port}`);
    }
    // Первичная синхронизация и периодический опрос панели
    sync.syncOnce(bot.telegram)
      .then(r => console.log(`🔄 Синхронизировано клиентов: ${r.total} (новых: ${r.newlySeen})`))
      .catch(e => console.error('Первичная синхронизация не удалась:', e.message));
    sync.startSyncLoop(bot.telegram);
  });

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
