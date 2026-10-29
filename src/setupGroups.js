// Интерактивный выбор группы клиентов панели 3x-ui при установке.
// Вызывается из installer.sh после npm install:  node src/setupGroups.js
// Завершается с кодом 0 всегда — недоступная панель не должна ломать установку.
//
//   node src/setupGroups.js --print   — только вывести JSON с клиентами и группами
//   node src/setupGroups.js --set X   — записать группу X без вопросов

const readline = require('readline');
const { getConfig, saveConfig } = require('./config');
const api = require('./api3xui');

function plural(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'клиент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'клиента';
  return 'клиентов';
}

function label(name) { return name ? `"${name}"` : '"(без группы)"'; }

async function collect() {
  await api.login();
  const clients = await api.getPanelClients();
  const groups = await api.getClientGroups();
  return { clients, groups };
}

function currentGroup(cfg) {
  // Пустая строка — осознанный выбор «без группы», а не «не задано».
  const raw = cfg.panel_client_group;
  return raw === undefined || raw === null ? 'Telegram' : String(raw).trim();
}

async function interactive(cfg) {
  const defGroup = currentGroup(cfg);

  // Сначала подключаемся к панели, и только потом начинаем спрашивать:
  // иначе набранный (или переданный по pipe) ответ во время ожидания ответа
  // панели теряется, а readline закрывается с "readline was closed".
  let data;
  try { data = await collect(); }
  catch (e) {
    console.log(`\n⚠️ Панель недоступна: ${e.message}`);
    console.log(`   Группа клиентов: ${label(defGroup)} — изменить командой /setgroup в боте.`);
    return;
  }

  const { clients, groups } = data;
  console.log(`\n📋 Клиентов в панели: ${clients.length}, групп клиентов: ${groups.length}`);

  if (!clients.length) {
    console.log('   В панели пока нет клиентов — группа будет создана при первой регистрации.');
  } else {
    groups.forEach((g, i) => {
      const mark = g.name === defGroup ? '  ← текущая' : '';
      console.log(`   ${i + 1}) ${label(g.name)} — ${g.count} ${plural(g.count)}${mark}`);
    });
    const active = clients.filter(c => c.enable).length;
    console.log(`   🟢 включено: ${active}, ⏸ выключено: ${clients.length - active}`);
  }

  console.log('\n🏷 В какую группу панели добавлять новых клиентов бота?');
  if (groups.length) {
    console.log('   номер 1-' + groups.length + ' — выбрать существующую');
    console.log('   n<имя> — создать новую, напр. nTelegram');
    console.log('   -      — без группы');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await new Promise(resolve =>
    rl.question(`   Выбор [Enter — оставить ${label(defGroup)}]: `, resolve))).trim();
  rl.close();

  if (!ans) {
    console.log(`   Оставлено: ${label(defGroup)}`);
  } else if (ans === '-' || ans === '—') {
    cfg.panel_client_group = '';
    saveConfig(cfg);
    console.log('✅ Новые клиенты будут создаваться без группы.');
  } else if (/^n(.+)$/s.test(ans)) {
    const name = ans.slice(1).trim();
    cfg.panel_client_group = name;
    saveConfig(cfg);
    console.log(`✅ Новая группа: ${label(name)} — применится к следующим регистрациям.`);
  } else {
    const idx = parseInt(ans, 10);
    if (idx >= 1 && idx <= groups.length) {
      const g = groups[idx - 1];
      cfg.panel_client_group = g.name;
      saveConfig(cfg);
      console.log(`✅ Выбрана группа ${label(g.name)} (${g.count} ${plural(g.count)}).`);
    } else {
      console.log(`   Не поняли ввод, оставлено: ${label(defGroup)}`);
    }
  }
}

async function main() {
  const cfg = getConfig();

  if (process.argv.includes('--print')) {
    try {
      const { clients, groups } = await collect();
      console.log(JSON.stringify({
        total: clients.length,
        enabled: clients.filter(c => c.enable).length,
        groups,
        current: currentGroup(cfg),
      }, null, 2));
    } catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 2; }
    return;
  }

  const si = process.argv.indexOf('--set');
  if (si > 0) {
    const name = String(process.argv[si + 1] || '').trim();
    cfg.panel_client_group = name;
    saveConfig(cfg);
    console.log(`✅ Группа клиентов: ${label(name)}`);
    return;
  }

  // Без stdin (например, curl | bash) вопросы бессмысленны — оставляем дефолт.
  // SETUP_INTERACTIVE=1 форсирует вопросы (используется в тестах).
  if (!process.stdin.isTTY && !process.env.SETUP_INTERACTIVE) {
    console.log(`\nℹ️ Неинтерактивный режим — группа: ${label(currentGroup(cfg))}`);
    console.log('   Настроить: /setgroup в боте или node src/setupGroups.js');
    return;
  }

  await interactive(cfg);
}

main().catch(e => { console.log(`\n⚠️ Пропущено: ${e.message}`); });

