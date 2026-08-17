const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const config = require('./config');

// ===== СОСТОЯНИЕ БОТА =====
let bot = null;
let isRegistered = false;
let isLoggedIn = false;
let npcClicked = false;
let swordSelected = false;
let reconnecting = false;

// ===== ЦВЕТА ДЛЯ КОНСОЛИ =====
const log = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  ok: (msg) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  chat: (msg) => console.log(`\x1b[35m[CHAT]\x1b[0m ${msg}`),
};

// ===== СОЗДАНИЕ БОТА =====
function createBot() {
  if (reconnecting) return;
  
  isRegistered = false;
  isLoggedIn = false;
  npcClicked = false;
  swordSelected = false;

  log.info(`Подключение к ${config.host}:${config.port} (${config.version})...`);
  log.info(`Ник: ${config.username}`);

  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    hideErrors: false,
    checkTimeoutInterval: 60000,
    auth: 'offline',
  });

  bot.loadPlugin(pathfinder);

  // ===== СОБЫТИЯ =====
  bot.once('spawn', onSpawn);
  bot.on('chat', onChat);
  bot.on('message', onMessage);
  bot.on('windowOpen', onWindowOpen);
  bot.on('kicked', onKicked);
  bot.on('error', onError);
  bot.on('end', onEnd);
  bot.on('health', onHealth);
}

// ===== СПАВН =====
async function onSpawn() {
  log.ok('Бот заспавнился на сервере!');
  log.info(`Позиция: ${bot.entity.position}`);

  // Ждём немного, потом пробуем зарегистрироваться/залогиниться
  await sleep(config.registerDelay);
  await tryAuth();
}

// ===== АВТОРИЗАЦИЯ =====
async function tryAuth() {
  log.info('Попытка авторизации...');

  // Сначала пробуем /login (если уже зарегистрирован)
  bot.chat(`/login ${config.password}`);
  log.info(`Отправлена команда: /login ***`);

  await sleep(3000);

  // Если не залогинились, пробуем /register
  if (!isLoggedIn) {
    log.info('Попытка регистрации...');
    bot.chat(`/register ${config.password} ${config.password}`);
    log.info(`Отправлена команда: /register *** ***`);

    await sleep(3000);

    // После регистрации логинимся
    if (!isLoggedIn) {
      bot.chat(`/login ${config.password}`);
      log.info('Повторная попытка /login после регистрации...');
      await sleep(3000);
    }
  }

  // Переходим к поиску NPC
  await sleep(config.npcSearchDelay);
  if (!npcClicked) {
    await findAndClickNPC();
  }
}

// ===== ОБРАБОТКА ЧАТА =====
function onChat(username, message) {
  if (username === bot.username) return;
  log.chat(`<${username}> ${message}`);
}

function onMessage(jsonMsg) {
  const text = jsonMsg.toString().toLowerCase();
  const fullText = jsonMsg.toString();
  
  if (fullText.trim()) {
    log.chat(`[СЕРВЕР] ${fullText}`);
  }

  // Определяем успешную авторизацию
  if (
    text.includes('успешно') ||
    text.includes('авторизован') ||
    text.includes('logged in') ||
    text.includes('вошли') ||
    text.includes('вы вошли') ||
    text.includes('successfully') ||
    text.includes('login successful') ||
    text.includes('зарегистрирован') ||
    text.includes('registered')
  ) {
    if (!isLoggedIn) {
      isLoggedIn = true;
      log.ok('✅ Авторизация успешна!');
      
      // После авторизации ищем NPC
      setTimeout(async () => {
        if (!npcClicked) {
          await findAndClickNPC();
        }
      }, config.npcSearchDelay);
    }
  }

  // Если сервер просит зарегистрироваться
  if (
    text.includes('/register') ||
    text.includes('зарегистрируйтесь') ||
    text.includes('register')
  ) {
    if (!isRegistered) {
      isRegistered = true;
      log.info('Сервер просит зарегистрироваться...');
      setTimeout(() => {
        bot.chat(`/register ${config.password} ${config.password}`);
        log.info('Отправлена команда /register');
      }, 2000);
    }
  }

  // Если сервер просит залогиниться
  if (
    (text.includes('/login') || text.includes('войдите') || text.includes('авторизуйтесь')) &&
    !text.includes('успешно') &&
    !isLoggedIn
  ) {
    log.info('Сервер просит залогиниться...');
    setTimeout(() => {
      bot.chat(`/login ${config.password}`);
      log.info('Отправлена команда /login');
    }, 2000);
  }
}

// ===== ПОИСК NPC =====
async function findAndClickNPC() {
  log.info(`Поиск NPC в радиусе ${config.npcSearchRadius} блоков...`);

  // Ищем всех entities рядом (NPC обычно это Players или другие entity)
  const entities = Object.values(bot.entities);
  const botPos = bot.entity.position;

  // Сортируем по расстоянию
  const nearbyEntities = entities
    .filter(e => {
      if (e === bot.entity) return false;
      const dist = e.position.distanceTo(botPos);
      return dist < config.npcSearchRadius;
    })
    .sort((a, b) => {
      return a.position.distanceTo(botPos) - b.position.distanceTo(botPos);
    });

  log.info(`Найдено ${nearbyEntities.length} entity рядом:`);
  
  nearbyEntities.forEach((e, i) => {
    const dist = e.position.distanceTo(botPos).toFixed(1);
    const name = e.username || e.displayName || e.name || e.type;
    log.info(`  ${i+1}. [${e.type}] "${name}" (${dist} блоков, id:${e.id})`);
  });

  // Ищем NPC - обычно это player-type entity или villager
  let npc = nearbyEntities.find(e => 
    e.type === 'player' && e.username !== bot.username
  );

  // Если не нашли player-NPC, ищем другие entity
  if (!npc) {
    npc = nearbyEntities.find(e => 
      e.type === 'mob' || 
      e.type === 'other' ||
      e.entityType !== undefined
    );
  }

  // Если вообще ничего не нашли, берём ближайший entity
  if (!npc && nearbyEntities.length > 0) {
    npc = nearbyEntities[0];
  }

  if (!npc) {
    log.warn('NPC не найден! Пробую подойти к спавну и поискать снова...');
    
    // Пробуем походить и поискать
    await walkAround();
    await sleep(3000);
    
    // Повторный поиск
    return findAndClickNPC();
  }

  const npcName = npc.username || npc.displayName || npc.name || 'Unknown';
  const npcDist = npc.position.distanceTo(botPos).toFixed(1);
  log.ok(`Найден NPC: "${npcName}" (${npcDist} блоков)`);

  // Подходим к NPC
  await walkToEntity(npc);

  // Кликаем по NPC
  await sleep(1000);
  await clickEntity(npc);
}

// ===== ПОДХОД К ENTITY =====
async function walkToEntity(entity) {
  try {
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    movements.canDig = false;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);

    const goal = new goals.GoalNear(
      entity.position.x,
      entity.position.y,
      entity.position.z,
      2
    );

    log.info(`Иду к NPC...`);
    
    await bot.pathfinder.goto(goal).catch(err => {
      log.warn(`Pathfinder: ${err.message}. Пробую подойти вручную...`);
      manualWalkTo(entity.position);
    });

    log.ok('Подошёл к NPC!');
  } catch (err) {
    log.warn(`Ошибка pathfinder: ${err.message}. Пробую вручную...`);
    await manualWalkTo(entity.position);
  }
}

// ===== РУЧНОЕ ДВИЖЕНИЕ =====
async function manualWalkTo(targetPos) {
  const pos = bot.entity.position;
  const dir = targetPos.minus(pos);
  
  bot.lookAt(targetPos.offset(0, 1.6, 0));
  bot.setControlState('forward', true);
  
  await sleep(2000);
  
  bot.setControlState('forward', false);
}

// ===== СЛУЧАЙНОЕ ХОЖДЕНИЕ =====
async function walkAround() {
  log.info('Хожу вокруг в поисках NPC...');
  
  const directions = ['forward', 'back', 'left', 'right'];
  
  for (const dir of directions) {
    bot.setControlState(dir, true);
    await sleep(1500);
    bot.setControlState(dir, false);
    await sleep(500);
    
    // Проверяем, появился ли NPC
    const entities = Object.values(bot.entities);
    const nearby = entities.filter(e => 
      e !== bot.entity && 
      e.position.distanceTo(bot.entity.position) < config.npcSearchRadius
    );
    
    if (nearby.length > 0) {
      log.info('Нашёл entity при обходе!');
      return;
    }
  }
}

// ===== КЛИК ПО ENTITY =====
async function clickEntity(entity) {
  try {
    // Смотрим на NPC
    await bot.lookAt(entity.position.offset(0, 1.6, 0));
    await sleep(500);

    // Правый клик по entity (взаимодействие)
    log.info('Кликаю по NPC (правый клик)...');
    bot.useOn(entity);
    // Альтернативный метод — bot.activateEntity(entity)
    
    npcClicked = true;
    log.ok('✅ Клик по NPC выполнен! Жду открытия меню...');

    // Если меню не открылось через 3 секунды, пробуем другой метод
    await sleep(3000);
    
    if (!swordSelected) {
      log.warn('Меню не открылось. Пробую activateEntity...');
      try {
        bot.activateEntity(entity);
        log.info('activateEntity отправлен.');
      } catch (e) {
        log.warn(`activateEntity failed: ${e.message}`);
      }
      
      await sleep(3000);
      
      // Ещё одна попытка — атака (левый клик)
      if (!swordSelected) {
        log.warn('Пробую attack (левый клик)...');
        bot.attack(entity);
      }
    }
    
  } catch (err) {
    log.error(`Ошибка при клике: ${err.message}`);
    
    // Fallback — пробуем activateEntity
    try {
      bot.activateEntity(entity);
    } catch (e) {
      log.error(`activateEntity тоже не сработал: ${e.message}`);
    }
  }
}

// ===== ОБРАБОТКА ОТКРЫТИЯ ОКНА (МЕНЮ) =====
function onWindowOpen(window) {
  const title = window.title ? 
    (typeof window.title === 'string' ? window.title : JSON.stringify(window.title)) : 
    'Без названия';
    
  log.ok(`📦 Открылось меню: "${title}"`);
  log.info(`Тип: ${window.type}, Слотов: ${window.slots.length}`);

  // Выводим содержимое окна
  log.info('Содержимое меню:');
  window.slots.forEach((slot, i) => {
    if (slot) {
      const name = slot.name || 'unknown';
      const displayName = slot.displayName || slot.customName || name;
      const count = slot.count || 1;
      const nbt = slot.nbt ? JSON.stringify(slot.nbt).substring(0, 100) : '';
      log.info(`  Слот ${i}: ${displayName} (${name}) x${count} ${nbt}`);
    }
  });

  // Ищем незеритовый меч
  findAndClickSword(window);
}

// ===== ПОИСК И КЛИК ПО МЕЧУ =====
async function findAndClickSword(window) {
  await sleep(config.windowClickDelay);

  let targetSlot = -1;

  // Перебираем все слоты
  for (let i = 0; i < window.slots.length; i++) {
    const slot = window.slots[i];
    if (!slot) continue;

    const name = (slot.name || '').toLowerCase();
    const displayName = (slot.displayName || '').toLowerCase();
    const customName = slot.nbt?.value?.display?.value?.Name?.value || '';

    // Проверяем по имени предмета
    if (
      name.includes('netherite_sword') ||
      name.includes('netherite') ||
      displayName.includes('незерит') ||
      displayName.includes('netherite') ||
      customName.toLowerCase().includes('незерит') ||
      customName.toLowerCase().includes('netherite') ||
      customName.toLowerCase().includes('меч') ||
      customName.toLowerCase().includes('sword')
    ) {
      targetSlot = i;
      log.ok(`🗡️ Найден Незеритовый меч в слоте ${i}!`);
      break;
    }
  }

  // Если не нашли по имени, ищем любой меч
  if (targetSlot === -1) {
    for (let i = 0; i < window.slots.length; i++) {
      const slot = window.slots[i];
      if (!slot) continue;

      const name = (slot.name || '').toLowerCase();
      if (
        name.includes('sword') ||
        name.includes('меч')
      ) {
        targetSlot = i;
        log.warn(`Незеритовый меч не найден, но найден другой меч в слоте ${i}: ${slot.name}`);
        break;
      }
    }
  }

  // Если вообще ничего не нашли, кликаем по первому непустому слоту
  if (targetSlot === -1) {
    for (let i = 0; i < window.slots.length; i++) {
      if (window.slots[i]) {
        targetSlot = i;
        log.warn(`Меч не найден. Кликаю по первому предмету в слоте ${i}: ${window.slots[i].name}`);
        break;
      }
    }
  }

  if (targetSlot === -1) {
    log.error('Меню пустое! Нечего нажимать.');
    return;
  }

  // Кликаем по слоту
  try {
    log.info(`Кликаю по слоту ${targetSlot}...`);
    bot.clickWindow(targetSlot, 0, 0); // Левый клик
    swordSelected = true;
    log.ok('✅ Клик по мечу выполнен!');

    await sleep(2000);
    log.ok('🎮 Бот готов к игре!');

    // Закрываем окно если оно ещё открыто
    try {
      bot.closeWindow(window);
    } catch (e) {}

    // После входа — просто стоим или делаем что нужно
    afterSetup();

  } catch (err) {
    log.error(`Ошибка клика по слоту: ${err.message}`);
    
    // Альтернативный метод
    try {
      bot.clickWindow(targetSlot, 0, 0);
    } catch (e) {
      log.error(`Альтернативный клик тоже не сработал: ${e.message}`);
    }
  }
}

// ===== ПОСЛЕ НАСТРОЙКИ =====
function afterSetup() {
  log.ok('═══════════════════════════════════════');
  log.ok('  Бот полностью настроен и в игре!');
  log.ok('═══════════════════════════════════════');

  // Антиафк — периодическое движение
  setInterval(() => {
    if (bot && bot.entity) {
      // Прыгаем или крутимся чтобы не кикнуло за АФК
      const actions = ['jump', 'sneak'];
      const action = actions[Math.floor(Math.random() * actions.length)];
      
      bot.setControlState(action, true);
      setTimeout(() => {
        bot.setControlState(action, false);
      }, 500);
    }
  }, 30000); // Каждые 30 секунд
}

// ===== ЗДОРОВЬЕ =====
function onHealth() {
  if (bot.health < 5) {
    log.warn(`⚠️ Мало HP: ${bot.health.toFixed(1)} | Голод: ${bot.food}`);
  }
}

// ===== ОШИБКИ И РЕКОННЕКТ =====
function onKicked(reason) {
  const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
  log.error(`Кикнут: ${text}`);
  scheduleReconnect();
}

function onError(err) {
  log.error(`Ошибка: ${err.message}`);
}

function onEnd(reason) {
  log.warn(`Отключен: ${reason || 'неизвестная причина'}`);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (!config.autoReconnect) {
    log.info('Автореконнект выключен. Завершение.');
    process.exit(0);
    return;
  }
  
  if (reconnecting) return;
  reconnecting = true;

  log.info(`Переподключение через ${config.reconnectDelay/1000} сек...`);
  
  setTimeout(() => {
    reconnecting = false;
    createBot();
  }, config.reconnectDelay);
}

// ===== УТИЛИТЫ =====
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== ОБРАБОТКА CTRL+C =====
process.on('SIGINT', () => {
  log.info('Завершение...');
  if (bot) {
    bot.quit();
  }
  process.exit(0);
});

// ===== СТАРТ =====
log.info('═══════════════════════════════════════');
log.info('  LavaMine Bot v1.0');
log.info('═══════════════════════════════════════');
createBot();
