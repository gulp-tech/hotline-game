module.exports = {
  // ===== НАСТРОЙКИ ПОДКЛЮЧЕНИЯ =====
  host: 'lavamine.rustix.su',
  port: 25565,
  version: '1.16.5',
  
  // ===== АККАУНТ =====
  username: 'MyBot123',          // Ник бота (поменяй на свой)
  password: 'MySecurePass123',   // Пароль для /register и /login (поменяй!)
  
  // ===== НАСТРОЙКИ ПОВЕДЕНИЯ =====
  registerDelay: 3000,           // Задержка перед регистрацией (мс)
  npcSearchDelay: 5000,          // Задержка перед поиском NPC (мс)
  npcSearchRadius: 20,           // Радиус поиска NPC (блоков)
  windowClickDelay: 1500,        // Задержка перед кликом в меню (мс)
  
  // ===== ПРЕДМЕТ В МЕНЮ =====
  // Незеритовый меч = netherite_sword
  targetItem: 'netherite_sword',
  
  // ===== АВТОРЕКОННЕКТ =====
  autoReconnect: true,
  reconnectDelay: 10000,         // 10 секунд между попытками
};
