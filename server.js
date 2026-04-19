const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== КОНСТАНТЫ ====================
const GAME_MODES = {
  DEATHMATCH: 'deathmatch',
  SURVIVAL: 'survival',
  TEAM: 'team'
};

const LOBBY_STATES = {
  WAITING: 'waiting',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ENDED: 'ended'
};

// ==================== ХРАНИЛИЩЕ ====================
const players = {};    // все подключённые
const lobbies = {};    // все лобби
let lobbyCounter = 1;

// ==================== БОТЫ ====================
class Bot {
  constructor(id, lobbyId) {
    this.id = id;
    this.lobbyId = lobbyId;
    this.x = Math.random() * 800 + 50;
    this.y = Math.random() * 500 + 50;
    this.health = 100;
    this.maxHealth = 100;
    this.angle = 0;
    this.speed = 1.5 + Math.random() * 1;
    this.name = `BOT_${id}`;
    this.color = '#ff4444';
    this.isBot = true;
    this.score = 0;
    this.targetId = null;
    this.lastShot = 0;
    this.shootCooldown = 1500 + Math.random() * 1000;
    this.wave = 1;
  }

  update(lobby) {
    // Найти ближайшего живого игрока
    let closest = null;
    let minDist = Infinity;
    Object.values(lobby.players).forEach(p => {
      if (!p.isDead) {
        const dx = p.x - this.x;
        const dy = p.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) {
          minDist = dist;
          closest = p;
        }
      }
    });

    if (closest) {
      this.angle = Math.atan2(closest.y - this.y, closest.x - this.x);
      // Двигаться к игроку
      if (minDist > 80) {
        this.x += Math.cos(this.angle) * this.speed;
        this.y += Math.sin(this.angle) * this.speed;
      }
      // Стрельба
      const now = Date.now();
      if (minDist < 400 && now - this.lastShot > this.shootCooldown) {
        this.lastShot = now;
        return {
          type: 'shoot',
          bullet: {
            id: `bot_bullet_${Date.now()}_${Math.random()}`,
            ownerId: this.id,
            ownerName: this.name,
            isBot: true,
            x: this.x,
            y: this.y,
            angle: this.angle + (Math.random() - 0.5) * 0.3,
            speed: 7
          }
        };
      }
    }

    // Границы
    this.x = Math.max(20, Math.min(880, this.x));
    this.y = Math.max(20, Math.min(580, this.y));
    return null;
  }
}

// ==================== СОЗДАНИЕ ЛОББИ ====================
function createLobby(mode, name) {
  const id = `lobby_${lobbyCounter++}`;
  lobbies[id] = {
    id,
    name: name || `Лобби #${lobbyCounter - 1}`,
    mode,
    state: LOBBY_STATES.WAITING,
    players: {},
    spectators: {},
    bots: {},
    bullets: [],
    wave: 0,
    countdownTimer: null,
    gameTimer: null,
    botSpawnTimer: null,
    botIdCounter: 0,
    timeLeft: mode === GAME_MODES.SURVIVAL ? 0 : 180,
    maxPlayers: 8,
    minToStart: 2,
    createdAt: Date.now()
  };
  return lobbies[id];
}

// Создаём дефолтные лобби
createLobby(GAME_MODES.DEATHMATCH, '⚔️ Deathmatch #1');
createLobby(GAME_MODES.SURVIVAL, '🧟 Выживание #1');
createLobby(GAME_MODES.TEAM, '🛡️ Команды #1');

// ==================== УПРАВЛЕНИЕ ЛОББИ ====================
function startCountdown(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.state !== LOBBY_STATES.WAITING) return;

  lobby.state = LOBBY_STATES.COUNTDOWN;
  let count = 20;

  io.to(lobbyId).emit('countdown', { seconds: count });

  lobby.countdownTimer = setInterval(() => {
    count--;
    io.to(lobbyId).emit('countdown', { seconds: count });
    if (count <= 0) {
      clearInterval(lobby.countdownTimer);
      startGame(lobbyId);
    }
  }, 1000);
}

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  lobby.state = LOBBY_STATES.PLAYING;
  lobby.wave = 1;
  lobby.timeLeft = lobby.mode === GAME_MODES.SURVIVAL ? 0 : 180;

  // Спектаторы — игроки которые не успели
  Object.values(players).forEach(p => {
    if (p.lobbyId === lobbyId && !lobby.players[p.id]) {
      lobby.spectators[p.id] = p;
      io.to(p.id).emit('becameSpectator');
    }
  });

  // Расставить игроков
  Object.values(lobby.players).forEach((p, i) => {
    p.x = 100 + (i % 4) * 200;
    p.y = 100 + Math.floor(i / 4) * 200;
    p.health = 100;
    p.isDead = false;
    p.score = 0;
    if (lobby.mode === GAME_MODES.TEAM) {
      p.team = i % 2 === 0 ? 'red' : 'blue';
    }
  });

  io.to(lobbyId).emit('gameStarted', {
    mode: lobby.mode,
    players: lobby.players,
    wave: lobby.wave
  });

  // Таймер игры (для deathmatch/team)
  if (lobby.mode !== GAME_MODES.SURVIVAL) {
    lobby.gameTimer = setInterval(() => {
      lobby.timeLeft--;
      io.to(lobbyId).emit('timerUpdate', { timeLeft: lobby.timeLeft });
      if (lobby.timeLeft <= 0) {
        clearInterval(lobby.gameTimer);
        endGame(lobbyId);
      }
    }, 1000);
  }

  // Боты для выживания
  if (lobby.mode === GAME_MODES.SURVIVAL) {
    spawnWave(lobbyId);
  }

  // Игровой цикл
  startGameLoop(lobbyId);
}

function spawnWave(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const botCount = 3 + lobby.wave * 2;
  io.to(lobbyId).emit('waveStarted', { wave: lobby.wave, botCount });

  for (let i = 0; i < botCount; i++) {
    setTimeout(() => {
      if (!lobbies[lobbyId]) return;
      const botId = `bot_${lobbyId}_${lobby.botIdCounter++}`;
      const bot = new Bot(botId, lobbyId);
      bot.wave = lobby.wave;
      bot.health = 80 + lobby.wave * 20;
      bot.maxHealth = bot.health;
      bot.speed = 1.2 + lobby.wave * 0.2;
      bot.shootCooldown = Math.max(600, 1500 - lobby.wave * 100);
      lobby.bots[botId] = bot;
      io.to(lobbyId).emit('botSpawned', {
        id: botId,
        x: bot.x, y: bot.y,
        health: bot.health,
        maxHealth: bot.maxHealth,
        name: bot.name,
        wave: lobby.wave
      });
    }, i * 800);
  }
}

function startGameLoop(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  lobby.loopInterval = setInterval(() => {
    if (!lobbies[lobbyId] || lobby.state !== LOBBY_STATES.PLAYING) {
      clearInterval(lobby.loopInterval);
      return;
    }

    // Обновляем ботов
    Object.values(lobby.bots).forEach(bot => {
      const action = bot.update(lobby);
      if (action && action.type === 'shoot') {
        lobby.bullets.push({
          ...action.bullet,
          velX: Math.cos(action.bullet.angle) * action.bullet.speed,
          velY: Math.sin(action.bullet.angle) * action.bullet.speed,
          life: 80
        });
        io.to(lobbyId).emit('bulletCreated', action.bullet);
      }
    });

    // Обновляем пули
    const toRemove = [];
    lobby.bullets.forEach((b, idx) => {
      b.x += b.velX;
      b.y += b.velY;
      b.life--;

      if (b.life <= 0 || b.x < 0 || b.x > 900 || b.y < 0 || b.y > 600) {
        toRemove.push(idx);
        return;
      }

      // Пули ботов бьют по игрокам
      if (b.isBot) {
        Object.values(lobby.players).forEach(p => {
          if (p.isDead) return;
          const dx = b.x - p.x;
          const dy = b.y - p.y;
          if (Math.sqrt(dx * dx + dy * dy) < 20) {
            toRemove.push(idx);
            p.health -= 20;
            if (p.health <= 0) {
              p.isDead = true;
              p.health = 0;
              io.to(lobbyId).emit('playerDied', {
                deadId: p.id,
                killerId: b.ownerId,
                killerName: b.ownerName
              });
              // Проверить — все мертвы?
              checkSurvivalEnd(lobbyId);
            } else {
              io.to(lobbyId).emit('playerHurt', { id: p.id, health: p.health });
            }
          }
        });
      }

      // Пули игроков бьют по ботам
      if (!b.isBot) {
        Object.values(lobby.bots).forEach(bot => {
          const dx = b.x - bot.x;
          const dy = b.y - bot.y;
          if (Math.sqrt(dx * dx + dy * dy) < 20) {
            toRemove.push(idx);
            bot.health -= 25;
            if (bot.health <= 0) {
              // Начислить очко стрелку
              const shooter = lobby.players[b.ownerId];
              if (shooter) {
                shooter.score = (shooter.score || 0) + 1;
                io.to(lobbyId).emit('updateScore', { id: shooter.id, score: shooter.score });
              }
              io.to(lobbyId).emit('botDied', { id: bot.id, x: bot.x, y: bot.y });
              delete lobby.bots[bot.id];

              // Все боты убиты?
              if (Object.keys(lobby.bots).length === 0 && lobby.mode === GAME_MODES.SURVIVAL) {
                lobby.wave++;
                setTimeout(() => spawnWave(lobbyId), 3000);
              }
            } else {
              io.to(lobbyId).emit('botHurt', { id: bot.id, health: bot.health });
            }
          }
        });
      }
    });

    // Удаляем использованные пули
    toRemove.reverse().forEach(i => lobby.bullets.splice(i, 1));

    // Отправляем позиции ботов
    const botPositions = {};
    Object.values(lobby.bots).forEach(b => {
      botPositions[b.id] = { x: b.x, y: b.y, angle: b.angle, health: b.health };
    });
    if (Object.keys(botPositions).length > 0) {
      io.to(lobbyId).emit('botsUpdate', botPositions);
    }

  }, 50); // 20 FPS серверный цикл
}

function checkSurvivalEnd(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const alivePlayers = Object.values(lobby.players).filter(p => !p.isDead);
  if (alivePlayers.length === 0) {
    setTimeout(() => endGame(lobbyId, `💀 Все погибли на волне ${lobby.wave}`), 1000);
  }
}

function endGame(lobbyId, reason) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  lobby.state = LOBBY_STATES.ENDED;
  clearInterval(lobby.gameTimer);
  clearInterval(lobby.loopInterval);

  const scores = Object.values(lobby.players)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map(p => ({ name: p.name, score: p.score || 0, team: p.team }));

  io.to(lobbyId).emit('gameEnded', {
    reason: reason || '⏱️ Время вышло',
    scores,
    wave: lobby.wave
  });

  // Сбросить лобби через 10 сек
  setTimeout(() => {
    if (!lobbies[lobbyId]) return;
    lobby.state = LOBBY_STATES.WAITING;
    lobby.players = {};
    lobby.spectators = {};
    lobby.bots = {};
    lobby.bullets = [];
    lobby.wave = 0;
    io.to(lobbyId).emit('lobbyReset');
    broadcastLobbyList();
  }, 10000);
}

function broadcastLobbyList() {
  const list = Object.values(lobbies).map(l => ({
    id: l.id,
    name: l.name,
    mode: l.mode,
    state: l.state,
    playerCount: Object.keys(l.players).length,
    maxPlayers: l.maxPlayers,
    wave: l.wave
  }));
  io.emit('lobbyList', list);
}

// ==================== SOCKET EVENTS ====================
io.on('connection', (socket) => {
  console.log(`✅ Подключился: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    name: 'Player',
    x: 400, y: 300,
    angle: 0,
    health: 100,
    score: 0,
    color: `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`,
    lobbyId: null,
    isDead: false,
    team: null
  };

  
