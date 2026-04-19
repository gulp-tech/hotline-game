const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],       // только WS — меньше задержка
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e5
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== КАРТЫ (спауны) ====================
const SAFE_SPAWNS = {
  deathmatch: [
    {x:160,y:160},{x:500,y:140},{x:800,y:260},
    {x:160,y:420},{x:500,y:470},{x:720,y:470},
    {x:420,y:310},{x:800,y:90}
  ],
  survival: [
    {x:160,y:110},{x:720,y:110},{x:160,y:420},
    {x:720,y:420},{x:450,y:280},{x:290,y:280},
    {x:610,y:280},{x:450,y:110}
  ],
  team: [
    {x:110,y:70},  {x:110,y:340},{x:110,y:470},
    {x:790,y:70},  {x:790,y:340},{x:790,y:470},
    {x:220,y:290}, {x:660,y:290}
  ]
};

function getSafeSpawn(mode, index) {
  const spawns = SAFE_SPAWNS[mode] || SAFE_SPAWNS.deathmatch;
  return spawns[index % spawns.length];
}

// ==================== СОСТОЯНИЕ ====================
const LOBBY_STATES = { WAITING:'waiting', COUNTDOWN:'countdown', PLAYING:'playing', ENDED:'ended' };
const GAME_MODES   = { DEATHMATCH:'deathmatch', SURVIVAL:'survival', TEAM:'team' };

const players = {};
const lobbies = {};
let lobbyCounter = 1;

// ==================== БОТ ====================
class Bot {
  constructor(id, lobbyId) {
    this.id = id; this.lobbyId = lobbyId;
    this.x = 450; this.y = 290;
    this.health = 100; this.maxHealth = 100;
    this.angle = 0; this.speed = 1.5;
    this.name = `BOT_${String(id).slice(-3)}`;
    this.color = '#ff4444'; this.isBot = true;
    this.score = 0; this.targetId = null;
    this.lastShot = 0; this.shootCooldown = 1400;
    this.wave = 1;
    this.wanderAngle = Math.random()*Math.PI*2;
    this.wanderTimer = 0;
  }

  update(lobby) {
    let closest = null, minDist = Infinity;
    Object.values(lobby.players).forEach(p => {
      if (p.isDead) return;
      const d = Math.hypot(p.x-this.x, p.y-this.y);
      if (d < minDist) { minDist=d; closest=p; }
    });

    if (closest) {
      this.angle = Math.atan2(closest.y-this.y, closest.x-this.x);
      if (minDist > 90) {
        this.x += Math.cos(this.angle) * this.speed;
        this.y += Math.sin(this.angle) * this.speed;
      }
      // Стрельба
      const now = Date.now();
      if (minDist < 420 && now-this.lastShot > this.shootCooldown) {
        this.lastShot = now;
        const spread = (Math.random()-0.5)*0.25;
        return {
          type: 'shoot',
          bullet: {
            id: `bb_${now}_${Math.random().toString(36).slice(2)}`,
            ownerId: this.id, ownerName: this.name, isBot: true,
            x: this.x, y: this.y,
            angle: this.angle + spread,
            speed: 7
          }
        };
      }
    } else {
      // Брожение
      this.wanderTimer--;
      if (this.wanderTimer<=0) {
        this.wanderAngle += (Math.random()-0.5)*1.5;
        this.wanderTimer = 60+Math.random()*60;
      }
      this.x += Math.cos(this.wanderAngle)*this.speed*0.6;
      this.y += Math.sin(this.wanderAngle)*this.speed*0.6;
    }

    this.x = Math.max(30, Math.min(870, this.x));
    this.y = Math.max(30, Math.min(550, this.y));
    return null;
  }
}

// ==================== ЛОББИ ====================
function createLobby(mode, name) {
  const id = `lobby_${lobbyCounter++}`;
  lobbies[id] = {
    id, name, mode,
    state: LOBBY_STATES.WAITING,
    players: {}, spectators: {},
    bots: {}, bullets: [],
    wave: 0, botIdCounter: 0,
    countdownTimer: null, gameTimer: null,
    loopInterval: null,
    timeLeft: 180,
    maxPlayers: 8, minToStart: 2,
    spawnIndex: 0
  };
  return lobbies[id];
}

createLobby(GAME_MODES.DEATHMATCH, '⚔️ Deathmatch #1');
createLobby(GAME_MODES.SURVIVAL,   '🧟 Выживание #1');
createLobby(GAME_MODES.TEAM,       '🛡️ Команды #1');

function broadcastLobbyList() {
  const list = Object.values(lobbies).map(l => ({
    id: l.id, name: l.name, mode: l.mode,
    state: l.state,
    playerCount: Object.keys(l.players).length,
    maxPlayers: l.maxPlayers, wave: l.wave
  }));
  io.emit('lobbyList', list);
}

// ==================== ОТСЧЁТ / СТАРТ ====================
function startCountdown(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.state !== LOBBY_STATES.WAITING) return;
  lobby.state = LOBBY_STATES.COUNTDOWN;
  let count = 20;
  io.to(lobbyId).emit('countdown', { seconds: count });
  lobby.countdownTimer = setInterval(() => {
    count--;
    io.to(lobbyId).emit('countdown', { seconds: count });
    if (count <= 0) { clearInterval(lobby.countdownTimer); startGame(lobbyId); }
  }, 1000);
}

function startGame(lobbyId) {
  const lobby = lobbies[lobbyId]; if (!lobby) return;
  lobby.state = LOBBY_STATES.PLAYING;
  lobby.wave  = 1;
  lobby.timeLeft = 180;
  lobby.spawnIndex = 0;

  Object.values(players).forEach(p => {
    if (p.lobbyId===lobbyId && !lobby.players[p.id]) {
      lobby.spectators[p.id]=p;
      io.to(p.id).emit('becameSpectator');
    }
  });

  let pi = 0;
  Object.values(lobby.players).forEach(p => {
    const sp = getSafeSpawn(lobby.mode, pi++);
    p.x=sp.x; p.y=sp.y; p.health=100; p.isDead=false; p.score=0;
    if (lobby.mode===GAME_MODES.TEAM) p.team = pi%2===1?'red':'blue';
  });

  io.to(lobbyId).emit('gameStarted', {
    mode: lobby.mode, players: lobby.players, wave: lobby.wave
  });

  if (lobby.mode !== GAME_MODES.SURVIVAL) {
    lobby.gameTimer = setInterval(() => {
      lobby.timeLeft--;
      io.to(lobbyId).emit('timerUpdate', { timeLeft: lobby.timeLeft });
      if (lobby.timeLeft<=0) { clearInterval(lobby.gameTimer); endGame(lobbyId,'⏱️ Время вышло!'); }
    }, 1000);
  }

  if (lobby.mode === GAME_MODES.SURVIVAL) spawnWave(lobbyId);
  startGameLoop(lobbyId);
}

function spawnWave(lobbyId) {
  const lobby = lobbies[lobbyId]; if (!lobby) return;
  const count = 3 + lobby.wave*2;
  io.to(lobbyId).emit('waveStarted', { wave: lobby.wave, botCount: count });
  for (let i=0; i<count; i++) {
    setTimeout(() => {
      if (!lobbies[lobbyId]) return;
      const botId = `bot_${lobbyId}_${lobby.botIdCounter++}`;
      const bot   = new Bot(botId, lobbyId);
      // Спаун по краям
      const side = Math.floor(Math.random()*4);
      if (side===0) { bot.x=Math.random()*880+10; bot.y=10; }
      else if (side===1) { bot.x=880; bot.y=Math.random()*560+10; }
      else if (side===2) { bot.x=Math.random()*880+10; bot.y=560; }
      else  { bot.x=10; bot.y=Math.random()*560+10; }
      bot.wave = lobby.wave;
      bot.health = bot.maxHealth = 80 + lobby.wave*20;
      bot.speed  = Math.min(3.5, 1.2 + lobby.wave*0.2);
      bot.shootCooldown = Math.max(500, 1400 - lobby.wave*80);
      lobby.bots[botId] = bot;
      io.to(lobbyId).emit('botSpawned', {
        id:botId, x:bot.x, y:bot.y, health:bot.health,
        maxHealth:bot.maxHealth, name:bot.name, wave:bot.wave
      });
    }, i*600);
  }
}

// ==================== ИГРОВОЙ ЦИКЛ (сервер 20 FPS) ====================
function startGameLoop(lobbyId) {
  const lobby = lobbies[lobbyId]; if (!lobby) return;

  let lastTick = Date.now();
  lobby.loopInterval = setInterval(() => {
    if (!lobbies[lobbyId] || lobby.state!==LOBBY_STATES.PLAYING) return;

    const now = Date.now();
    const dt  = (now-lastTick)/16.67;
    lastTick  = now;

    // Боты
    const newBullets = [];
    Object.values(lobby.bots).forEach(bot => {
      const action = bot.update(lobby);
      if (action?.type==='shoot') newBullets.push({
        ...action.bullet,
        velX: Math.cos(action.bullet.angle)*action.bullet.speed,
        velY: Math.sin(action.bullet.angle)*action.bullet.speed,
        life: 90
      });
    });
    newBullets.forEach(b => {
      lobby.bullets.push(b);
      io.to(lobbyId).emit('bulletCreated', b);
    });

    // Пули
    for (let i=lobby.bullets.length-1; i>=0; i--) {
      const b = lobby.bullets[i];
      b.x += b.velX*dt; b.y += b.velY*dt; b.life -= dt;
      if (b.life<=0||b.x<0||b.x>900||b.y<0||b.y>600) { lobby.bullets.splice(i,1); continue; }

      // Пули ботов → игроки
      if (b.isBot) {
        let hit=false;
        Object.values(lobby.players).forEach(p => {
          if (hit||p.isDead) return;
          if (Math.hypot(b.x-p.x,b.y-p.y)<20) {
            hit=true; lobby.bullets.splice(i,1);
            p.health -= 20;
            if (p.health<=0) {
              p.health=0; p.isDead=true;
              io.to(lobbyId).emit('playerDied',{ deadId:p.id,killerId:b.ownerId,killerName:b.ownerName });
              if (lobby.mode!==GAME_MODES.SURVIVAL) {
                setTimeout(()=>respawnPlayer(lobbyId,p.id), 3000);
              } else checkSurvivalEnd(lobbyId);
            } else {
              io.to(lobbyId).emit('playerHurt',{ id:p.id, health:p.health });
            }
          }
        });
        if (hit) continue;
      }

      // Пули игроков → боты (доп. проверка на сервере)
      if (!b.isBot) {
        let hit=false;
        Object.values(lobby.bots).forEach(bot => {
          if (hit) return;
          if (Math.hypot(b.x-bot.x,b.y-bot.y)<20) {
            hit=true; lobby.bullets.splice(i,1);
            bot.health -= 25;
            if (bot.health<=0) {
              const shooter=lobby.players[b.ownerId];
              if (shooter) {
                shooter.score=(shooter.score||0)+1;
                io.to(lobbyId).emit('updateScore',{id:shooter.id,score:shooter.score});
              }
              io.to(lobbyId).emit('botDied',{id:bot.id,x:bot.x,y:bot.y});
              delete lobby.bots[bot.id];
              if (Object.keys(lobby.bots).length===0&&lobby.mode===GAME_MODES.SURVIVAL) {
                lobby.wave++;
                setTimeout(()=>spawnWave(lobbyId), 3000);
              }
            } else {
              io.to(lobbyId).emit('botHurt',{id:bot.id,health:bot.health});
            }
          }
        });
        if (hit) continue;
      }
    }

    // Позиции ботов (батч)
    const botData = {};
    Object.values(lobby.bots).forEach(b => {
      botData[b.id]={x:Math.round(b.x),y:Math.round(b.y),angle:+b.angle.toFixed(3),health:b.health};
    });
    if (Object.keys(botData).length) io.to(lobbyId).emit('botsUpdate', botData);

  }, 50); // 20 FPS
}

function respawnPlayer(lobbyId, pid) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  const p=lobby.players[pid];   if (!p||!p.isDead) return;
  const sp = getSafeSpawn(lobby.mode, lobby.spawnIndex++);
  p.health=100; p.isDead=false; p.x=sp.x; p.y=sp.y;
  io.to(lobbyId).emit('playerRespawned',{id:pid,x:p.x,y:p.y});
}

function checkSurvivalEnd(lobbyId) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  if (Object.values(lobby.players).every(p=>p.isDead))
    setTimeout(()=>endGame(lobbyId,`💀 Все пали на волне ${lobby.wave}`), 1000);
}

function endGame(lobbyId, reason) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  lobby.state=LOBBY_STATES.ENDED;
  clearInterval(lobby.gameTimer);
  clearInterval(lobby.loopInterval);

  const scores = Object.values(lobby.players)
    .sort((a,b)=>(b.score||0)-(a.score||0))
    .map(p=>({name:p.name,score:p.score||0,team:p.team||null}));

  io.to(lobbyId).emit('gameEnded',{reason,scores,wave:lobby.wave});

  setTimeout(()=>{
    if (!lobbies[lobbyId]) return;
    Object.assign(lobby,{
      state:LOBBY_STATES.WAITING,players:{},spectators:{},
      bots:{},bullets:[],wave:0,spawnIndex:0
    });
    io.to(lobbyId).emit('lobbyReset');
    broadcastLobbyList();
  }, 10000);
}

// ==================== SOCKETS ====================
io.on('connection', socket => {
  console.log('+ ' + socket.id);

  players[socket.id] = {
    id: socket.id, name: 'Player',
    x: 450, y: 290, angle: 0,
    health: 100, score: 0,
    color: `hsl(${Math.floor(Math.random()*360)},65%,60%)`,
    lobbyId: null, isDead: false, team: null
  };

  socket.emit('lobbyList', Object.values(lobbies).map(l=>({
    id:l.id,name:l.name,mode:l.mode,state:l.state,
    playerCount:Object.keys(l.players).length,
    maxPlayers:l.maxPlayers,wave:l.wave
  })));

  socket.on('setName', name => {
    if (players[socket.id]) players[socket.id].name = String(name).substring(0,15).trim()||'Player';
  });

  socket.on('joinLobby', lobbyId => {
    const lobby=lobbies[lobbyId], player=players[socket.id];
    if (!lobby||!player) return;

    if (player.lobbyId) leaveCurrentLobby(socket);

    player.lobbyId=lobbyId;
    socket.join(lobbyId);

    if (lobby.state===LOBBY_STATES.PLAYING) {
      lobby.spectators[socket.id]=player;
      socket.emit('becameSpectator');
      socket.emit('gameStarted',{mode:lobby.mode,players:lobby.players,wave:lobby.wave});
    } else {
      const sp=getSafeSpawn(lobby.mode, Object.keys(lobby.players).length);
      player.x=sp.x; player.y=sp.y; player.health=100; player.isDead=false;
      lobby.players[socket.id]=player;

      socket.emit('joinedLobby',{
        lobbyId, myId:socket.id,
        lobby:{ mode:lobby.mode, state:lobby.state, name:lobby.name, players:lobby.players }
      });
      socket.to(lobbyId).emit('playerJoined', player);

      if (Object.keys(lobby.players).length>=lobby.minToStart&&lobby.state===LOBBY_STATES.WAITING)
        startCountdown(lobbyId);
    }
    broadcastLobbyList();
  });

  socket.on('leaveLobby', () => leaveCurrentLobby(socket));

  socket.on('move', data => {
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING||p.isDead) return;
    // Санитизация
    p.x = Math.max(20, Math.min(880, +data.x||p.x));
    p.y = Math.max(20, Math.min(560, +data.y||p.y));
    p.angle = +data.angle||0;
    socket.to(p.lobbyId).emit('playerMoved',{id:socket.id,x:p.x,y:p.y,angle:p.angle});
  });

  socket.on('shoot', data => {
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING||p.isDead) return;

    const bullet = {
      id:`${socket.id}_${Date.now()}`,
      ownerId:socket.id, ownerName:p.name,
      ownerTeam:p.team, isBot:false,
      x:+data.x||p.x, y:+data.y||p.y,
      angle:+data.angle||0, speed:10
    };
    lobby.bullets.push({
      ...bullet,
      velX:Math.cos(bullet.angle)*bullet.speed,
      velY:Math.sin(bullet.angle)*bullet.speed,
      life:90
    });
    io.to(p.lobbyId).emit('bulletCreated', bullet);
  });

  socket.on('hitPlayer', data => {
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING) return;
    const target=lobby.players[data.targetId]; if (!target||target.isDead) return;
    if (lobby.mode===GAME_MODES.TEAM&&target.team===p.team) return;

    target.health -= 25;
    if (target.health<=0) {
      target.health=0; target.isDead=true;
      p.score=(p.score||0)+1;
      io.to(p.lobbyId).emit('playerDied',{deadId:target.id,killerId:socket.id,killerName:p.name});
      io.to(p.lobbyId).emit('updateScore',{id:socket.id,score:p.score});

      if (lobby.mode!==GAME_MODES.SURVIVAL) setTimeout(()=>respawnPlayer(p.lobbyId,target.id),3000);
      else checkSurvivalEnd(p.lobbyId);

      if (lobby.mode===GAME_MODES.TEAM) {
        const ra=Object.values(lobby.players).filter(x=>x.team==='red'&&!x.isDead).length;
        const ba=Object.values(lobby.players).filter(x=>x.team==='blue'&&!x.isDead).length;
        if (!ra) endGame(p.lobbyId,'🔵 Синяя команда победила!');
        else if (!ba) endGame(p.lobbyId,'🔴 Красная команда победила!');
      }
    } else {
      io.to(p.lobbyId).emit('playerHurt',{id:target.id,health:target.health});
    }
  });

  socket.on('disconnect', () => {
    console.log('- ' + socket.id);
    leaveCurrentLobby(socket);
    delete players[socket.id];
    broadcastLobbyList();
  });

  function leaveCurrentLobby(socket) {
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobbyId=p.lobbyId, lobby=lobbies[lobbyId];
    if (lobby) {
      delete lobby.players[socket.id];
      delete lobby.spectators[socket.id];
      socket.to(lobbyId).emit('playerLeft', socket.id);
      if (lobby.state===LOBBY_STATES.COUNTDOWN&&Object.keys(lobby.players).length<lobby.minToStart) {
        clearInterval(lobby.countdownTimer);
        lobby.state=LOBBY_STATES.WAITING;
        io.to(lobbyId).emit('countdownCancelled');
      }
    }
    socket.leave(lobbyId);
    p.lobbyId=null;
    broadcastLobbyList();
  }
});

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`🚀 Порт ${PORT}`));
