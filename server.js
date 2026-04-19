const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== КОНСТАНТЫ ====================
const LOBBY_STATES = { WAITING:'waiting', COUNTDOWN:'countdown', PLAYING:'playing', ENDED:'ended' };
const GAME_MODES   = { DEATHMATCH:'deathmatch', SURVIVAL:'survival', TEAM:'team', CTF:'ctf', KING:'king' };

const WEAPONS = {
  pistol:   { name:'Пистолет',   damage:25, speed:11, cd:280,  spread:0.05, bullets:1, color:'#ffcc00', range:90 },
  shotgun:  { name:'Дробовик',   damage:18, speed:9,  cd:700,  spread:0.35, bullets:5, color:'#ff8800', range:60 },
  sniper:   { name:'Снайперка',  damage:90, speed:16, cd:1200, spread:0.01, bullets:1, color:'#00ffff', range:120 },
  auto:     { name:'Автомат',    damage:18, speed:12, cd:120,  spread:0.12, bullets:1, color:'#ffff00', range:80 },
  launcher: { name:'Гранатомёт', damage:70, speed:7,  cd:1500, spread:0.08, bullets:1, color:'#ff4400', range:100, explosive:true },
  knife:    { name:'Нож',        damage:60, speed:0,  cd:500,  spread:0,    bullets:1, color:'#aaffaa', range:35,  melee:true },
};

const SAFE_SPAWNS = {
  deathmatch:[{x:160,y:160},{x:500,y:140},{x:800,y:260},{x:160,y:420},{x:500,y:470},{x:720,y:470},{x:420,y:310},{x:800,y:90}],
  survival:  [{x:160,y:110},{x:720,y:110},{x:160,y:420},{x:720,y:420},{x:450,y:280},{x:290,y:280},{x:610,y:280},{x:450,y:110}],
  team:      [{x:110,y:70},{x:110,y:340},{x:110,y:470},{x:790,y:70},{x:790,y:340},{x:790,y:470},{x:220,y:290},{x:660,y:290}],
  ctf:       [{x:100,y:200},{x:100,y:300},{x:100,y:400},{x:800,y:200},{x:800,y:300},{x:800,y:400},{x:100,y:150},{x:800,y:150}],
  king:      [{x:150,y:150},{x:750,y:150},{x:150,y:430},{x:750,y:430},{x:300,y:290},{x:600,y:290},{x:450,y:150},{x:450,y:430}],
};

const PICKUP_TYPES = ['health','shotgun','sniper','auto','launcher','knife'];

// ==================== ХРАНИЛИЩЕ ====================
const players = {};
const lobbies = {};
let lobbyCounter = 1;

// ==================== БОТ ====================
class Bot {
  constructor(id, lobbyId) {
    this.id=id; this.lobbyId=lobbyId;
    this.x=450; this.y=290;
    this.health=100; this.maxHealth=100;
    this.angle=0; this.speed=1.5;
    this.name=`BOT_${String(id).slice(-3)}`;
    this.isBot=true; this.score=0;
    this.weapon='auto'; this.lastShot=0;
    this.wave=1; this.wanderAngle=Math.random()*Math.PI*2;
    this.wanderTimer=0; this.state='wander';
    this.stuckTimer=0; this.lastX=450; this.lastY=290;
  }
  get shootCooldown() { return Math.max(400, 1400 - (this.wave||1)*80); }

  update(lobby) {
    let closest=null, minDist=Infinity;
    Object.values(lobby.players).forEach(p => {
      if (p.isDead) return;
      const d=Math.hypot(p.x-this.x, p.y-this.y);
      if (d<minDist) { minDist=d; closest=p; }
    });

    // Анти-застревание
    if (Math.hypot(this.x-this.lastX, this.y-this.lastY) < 0.5) {
      this.stuckTimer++;
      if (this.stuckTimer>30) { this.wanderAngle+=Math.PI*(0.5+Math.random()); this.stuckTimer=0; }
    } else { this.stuckTimer=0; }
    this.lastX=this.x; this.lastY=this.y;

    let action=null;
    if (closest && minDist<500) {
      this.state='chase';
      this.angle=Math.atan2(closest.y-this.y, closest.x-this.x);
      if (minDist>90) { this.x+=Math.cos(this.angle)*this.speed; this.y+=Math.sin(this.angle)*this.speed; }
      const now=Date.now();
      const w=WEAPONS[this.weapon]||WEAPONS.auto;
      if (minDist<(w.melee?40:450) && now-this.lastShot>this.shootCooldown) {
        this.lastShot=now;
        if (w.melee) {
          action={ type:'melee', targetId: closest.id, damage: w.damage };
        } else {
          const spread=(Math.random()-0.5)*0.3;
          action={ type:'shoot', bullet:{
            id:`bb_${now}_${Math.random().toString(36).slice(2,7)}`,
            ownerId:this.id, ownerName:this.name, isBot:true,
            x:this.x, y:this.y, angle:this.angle+spread,
            speed:w.speed, damage:w.damage, weapon:this.weapon,
            explosive:w.explosive||false
          }};
        }
      }
    } else {
      this.state='wander';
      this.wanderTimer--;
      if (this.wanderTimer<=0) { this.wanderAngle+=(Math.random()-0.5)*2; this.wanderTimer=40+Math.random()*80; }
      this.x+=Math.cos(this.wanderAngle)*this.speed*0.6;
      this.y+=Math.sin(this.wanderAngle)*this.speed*0.6;
    }
    this.x=Math.max(25,Math.min(875,this.x));
    this.y=Math.max(25,Math.min(555,this.y));
    return action;
  }
}

// ==================== ЛОББИ ====================
function createLobby(mode, name) {
  const id=`lobby_${lobbyCounter++}`;
  lobbies[id]={
    id, name, mode,
    state:LOBBY_STATES.WAITING,
    players:{}, spectators:{}, bots:{},
    bullets:[], pickups:[], explosions:[],
    barrels:[],
    wave:0, botIdCounter:0,
    countdownTimer:null, gameTimer:null, loopInterval:null,
    timeLeft:180, maxPlayers:8, minToStart:2, spawnIndex:0,
    kingTimer:{},  // king of the hill
    flags:{}       // ctf
  };
  return lobbies[id];
}

createLobby(GAME_MODES.DEATHMATCH,'⚔️ Deathmatch #1');
createLobby(GAME_MODES.SURVIVAL,  '🧟 Выживание #1');
createLobby(GAME_MODES.TEAM,      '🛡️ Команды #1');
createLobby(GAME_MODES.CTF,       '🏴 Захват флага #1');
createLobby(GAME_MODES.KING,      '👑 Король горы #1');

function broadcastLobbyList() {
  const list=Object.values(lobbies).map(l=>({
    id:l.id,name:l.name,mode:l.mode,state:l.state,
    playerCount:Object.keys(l.players).length,
    maxPlayers:l.maxPlayers,wave:l.wave
  }));
  io.emit('lobbyList',list);
}

function getSafeSpawn(mode,index) {
  const sp=SAFE_SPAWNS[mode]||SAFE_SPAWNS.deathmatch;
  return sp[index%sp.length];
}

// ==================== CTF / KING INIT ====================
function initCTF(lobby) {
  lobby.flags={
    red:  {x:100,y:290,ownerId:null,returned:true,baseX:100,baseY:290},
    blue: {x:800,y:290,ownerId:null,returned:true,baseX:800,baseY:290}
  };
}
function initKing(lobby) {
  lobby.kingZone={x:400,y:240,w:100,h:100};
  lobby.kingScore={red:0,blue:0};
}
function initBarrels(lobby) {
  lobby.barrels=[
    {id:'b1',x:250,y:200,hp:3},{id:'b2',x:650,y:200,hp:3},
    {id:'b3',x:250,y:380,hp:3},{id:'b4',x:650,y:380,hp:3},
    {id:'b5',x:450,y:290,hp:3},
  ];
}
function spawnPickups(lobby) {
  lobby.pickups=[];
  const positions=[
    {x:230,y:150},{x:670,y:150},{x:230,y:430},{x:670,y:430},
    {x:450,y:100},{x:450,y:480},{x:120,y:290},{x:780,y:290}
  ];
  positions.forEach((pos,i)=>{
    const type=PICKUP_TYPES[i%PICKUP_TYPES.length];
    lobby.pickups.push({id:`pk_${i}`,x:pos.x,y:pos.y,type,respawnTimer:0,active:true});
  });
}

// ==================== СТАРТ ====================
function startCountdown(lobbyId) {
  const lobby=lobbies[lobbyId];
  if (!lobby||lobby.state!==LOBBY_STATES.WAITING) return;
  lobby.state=LOBBY_STATES.COUNTDOWN;
  let count=20;
  io.to(lobbyId).emit('countdown',{seconds:count});
  lobby.countdownTimer=setInterval(()=>{
    count--;
    io.to(lobbyId).emit('countdown',{seconds:count});
    if (count<=0) { clearInterval(lobby.countdownTimer); startGame(lobbyId); }
  },1000);
}

function startGame(lobbyId) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  lobby.state=LOBBY_STATES.PLAYING;
  lobby.wave=1; lobby.timeLeft=180; lobby.spawnIndex=0;

  // Спектаторы
  Object.values(players).forEach(p=>{
    if (p.lobbyId===lobbyId&&!lobby.players[p.id]) {
      lobby.spectators[p.id]=p; io.to(p.id).emit('becameSpectator');
    }
  });

  // Расставить игроков
  let pi=0;
  Object.values(lobby.players).forEach(p=>{
    const sp=getSafeSpawn(lobby.mode,pi);
    p.x=sp.x; p.y=sp.y; p.health=100; p.isDead=false;
    p.score=0; p.weapon='pistol'; p.kills=0; p.deaths=0;
    p.hasFlag=false;
    if (lobby.mode===GAME_MODES.TEAM||lobby.mode===GAME_MODES.CTF||lobby.mode===GAME_MODES.KING)
      p.team=pi%2===0?'red':'blue';
    pi++;
  });

  // Инициализация режимов
  if (lobby.mode===GAME_MODES.CTF)  initCTF(lobby);
  if (lobby.mode===GAME_MODES.KING) initKing(lobby);
  initBarrels(lobby);
  spawnPickups(lobby);

  io.to(lobbyId).emit('gameStarted',{
    mode:lobby.mode, players:lobby.players,
    wave:lobby.wave, pickups:lobby.pickups,
    barrels:lobby.barrels,
    flags:lobby.flags||null,
    kingZone:lobby.kingZone||null
  });

  if (lobby.mode!==GAME_MODES.SURVIVAL) {
    lobby.gameTimer=setInterval(()=>{
      lobby.timeLeft--;
      io.to(lobbyId).emit('timerUpdate',{timeLeft:lobby.timeLeft});
      // Король горы — накапливаем очки
      if (lobby.mode===GAME_MODES.KING) updateKingScore(lobby,lobbyId);
      if (lobby.timeLeft<=0) { clearInterval(lobby.gameTimer); endGame(lobbyId,'⏱️ Время вышло!'); }
    },1000);
  }

  if (lobby.mode===GAME_MODES.SURVIVAL) spawnWave(lobbyId);
  startGameLoop(lobbyId);
}

function updateKingScore(lobby, lobbyId) {
  if (!lobby.kingZone) return;
  const z=lobby.kingZone;
  Object.values(lobby.players).forEach(p=>{
    if (p.isDead||!p.team) return;
    if (p.x>z.x&&p.x<z.x+z.w&&p.y>z.y&&p.y<z.y+z.h) {
      lobby.kingScore[p.team]=(lobby.kingScore[p.team]||0)+1;
      if (lobby.kingScore[p.team]>=30) endGame(lobbyId,`${p.team==='red'?'🔴':'🔵'} команда захватила гору!`);
    }
  });
  io.to(lobbyId).emit('kingScore',lobby.kingScore);
}

function spawnWave(lobbyId) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  const count=3+lobby.wave*2;
  io.to(lobbyId).emit('waveStarted',{wave:lobby.wave,botCount:count});
  const weapons=['pistol','auto','shotgun','sniper'];
  for (let i=0;i<count;i++) {
    setTimeout(()=>{
      if (!lobbies[lobbyId]) return;
      const botId=`bot_${lobbyId}_${lobby.botIdCounter++}`;
      const bot=new Bot(botId,lobbyId);
      const side=Math.floor(Math.random()*4);
      if (side===0){bot.x=Math.random()*860+20;bot.y=20;}
      else if(side===1){bot.x=875;bot.y=Math.random()*540+20;}
      else if(side===2){bot.x=Math.random()*860+20;bot.y=555;}
      else{bot.x=20;bot.y=Math.random()*540+20;}
      bot.wave=lobby.wave;
      bot.health=bot.maxHealth=80+lobby.wave*20;
      bot.speed=Math.min(3.8,1.2+lobby.wave*0.22);
      bot.weapon=weapons[Math.min(lobby.wave-1,weapons.length-1)];
      lobby.bots[botId]=bot;
      io.to(lobbyId).emit('botSpawned',{
        id:botId,x:bot.x,y:bot.y,health:bot.health,
        maxHealth:bot.maxHealth,name:bot.name,wave:bot.wave,weapon:bot.weapon
      });
    },i*500);
  }
}

// ==================== ИГРОВОЙ ЦИКЛ ====================
function startGameLoop(lobbyId) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  let lastTick=Date.now();

  lobby.loopInterval=setInterval(()=>{
    if (!lobbies[lobbyId]||lobby.state!==LOBBY_STATES.PLAYING) return;
    const now=Date.now();
    const dt=Math.min((now-lastTick)/16.67,3);
    lastTick=now;

    // --- Боты ---
    Object.values(lobby.bots).forEach(bot=>{
      const action=bot.update(lobby);
      if (!action) return;
      if (action.type==='shoot') {
        const b={...action.bullet,
          velX:Math.cos(action.bullet.angle)*action.bullet.speed,
          velY:Math.sin(action.bullet.angle)*action.bullet.speed,
          life:90};
        lobby.bullets.push(b);
        io.to(lobbyId).emit('bulletCreated',action.bullet);
      }
      if (action.type==='melee') {
        const target=lobby.players[action.targetId];
        if (target&&!target.isDead) {
          target.health-=action.damage;
          if (target.health<=0) killPlayer(lobby,lobbyId,target,bot.id,bot.name);
          else io.to(lobbyId).emit('playerHurt',{id:target.id,health:target.health});
        }
      }
    });

    // --- Пули ---
    for (let i=lobby.bullets.length-1;i>=0;i--) {
      const b=lobby.bullets[i];
      b.x+=b.velX*dt; b.y+=b.velY*dt; b.life-=dt;
      if (b.life<=0||b.x<0||b.x>900||b.y<0||b.y>600) { lobby.bullets.splice(i,1); continue; }

      let removed=false;

      // Попадание в бочку
      for (let bi=0;bi<lobby.barrels.length;bi++) {
        const bar=lobby.barrels[bi];
        if (Math.hypot(b.x-bar.x,b.y-bar.y)<22) {
          bar.hp--;
          if (bar.hp<=0) {
            createExplosion(lobby,lobbyId,bar.x,bar.y,80,50);
            lobby.barrels.splice(bi,1);
            io.to(lobbyId).emit('barrelDestroyed',{id:bar.id,x:bar.x,y:bar.y});
          } else {
            io.to(lobbyId).emit('barrelHurt',{id:bar.id,hp:bar.hp});
          }
          lobby.bullets.splice(i,1); removed=true; break;
        }
      }
      if (removed) continue;

      // Пули ботов → игроки
      if (b.isBot) {
        let hit=false;
        Object.values(lobby.players).forEach(p=>{
          if (hit||p.isDead) return;
          if (Math.hypot(b.x-p.x,b.y-p.y)<20) {
            hit=true;
            if (b.explosive) { createExplosion(lobby,lobbyId,b.x,b.y,60,b.damage); }
            else {
              p.health-=b.damage||20;
              if (p.health<=0) killPlayer(lobby,lobbyId,p,b.ownerId,b.ownerName);
              else io.to(lobbyId).emit('playerHurt',{id:p.id,health:p.health});
            }
          }
        });
        if (hit) { lobby.bullets.splice(i,1); continue; }
      }

      // Пули игроков → боты
      if (!b.isBot) {
        let hit=false;
        Object.values(lobby.bots).forEach(bot=>{
          if (hit) return;
          if (Math.hypot(b.x-bot.x,b.y-bot.y)<20) {
            hit=true;
            if (b.explosive) { createExplosion(lobby,lobbyId,b.x,b.y,70,b.damage); }
            else {
              bot.health-=b.damage||25;
              if (bot.health<=0) {
                const shooter=lobby.players[b.ownerId];
                if (shooter) { shooter.score=(shooter.score||0)+1; shooter.kills=(shooter.kills||0)+1; addXP(shooter,50+lobby.wave*10); io.to(lobbyId).emit('updateScore',{id:shooter.id,score:shooter.score,kills:shooter.kills,xp:shooter.xp,level:shooter.level}); }
                io.to(lobbyId).emit('botDied',{id:bot.id,x:bot.x,y:bot.y});
                delete lobby.bots[bot.id];
                if (Object.keys(lobby.bots).length===0&&lobby.mode===GAME_MODES.SURVIVAL) {
                  lobby.wave++; setTimeout(()=>spawnWave(lobbyId),3000);
                }
              } else io.to(lobbyId).emit('botHurt',{id:bot.id,health:bot.health});
            }
          }
        });
        if (hit) { lobby.bullets.splice(i,1); continue; }
      }
    }

    // --- Взрывы ---
    for (let i=lobby.explosions.length-1;i>=0;i--) {
      lobby.explosions[i].life-=dt;
      if (lobby.explosions[i].life<=0) lobby.explosions.splice(i,1);
    }

    // --- Пикапы рестарт ---
    lobby.pickups.forEach(pk=>{
      if (!pk.active) {
        pk.respawnTimer-=dt;
        if (pk.respawnTimer<=0) { pk.active=true; io.to(lobbyId).emit('pickupRespawned',{id:pk.id}); }
      }
    });

    // --- CTF: флаги ---
    if (lobby.mode===GAME_MODES.CTF&&lobby.flags) {
      Object.entries(lobby.flags).forEach(([team,flag])=>{
        if (flag.ownerId) {
          const carrier=lobby.players[flag.ownerId];
          if (!carrier||carrier.isDead) {
            // Бросить флаг
            if (carrier) { flag.x=carrier.x; flag.y=carrier.y; }
            flag.ownerId=null;
            io.to(lobbyId).emit('flagDropped',{team,x:flag.x,y:flag.y});
          } else {
            flag.x=carrier.x; flag.y=carrier.y;
          }
        }
      });
    }

    // --- Позиции ботов ---
    const botData={};
    Object.values(lobby.bots).forEach(b=>{
      botData[b.id]={x:Math.round(b.x),y:Math.round(b.y),angle:+b.angle.toFixed(3),health:b.health};
    });
    if (Object.keys(botData).length) io.to(lobbyId).emit('botsUpdate',botData);

  },50);
}

function createExplosion(lobby,lobbyId,x,y,radius,damage) {
  io.to(lobbyId).emit('explosion',{x,y,radius});
  // Урон по зоне
  Object.values(lobby.players).forEach(p=>{
    if (p.isDead) return;
    const d=Math.hypot(p.x-x,p.y-y);
    if (d<radius) {
      const dmg=Math.round(damage*(1-d/radius));
      p.health-=dmg;
      if (p.health<=0) killPlayer(lobby,lobbyId,p,'explosion','💥');
      else io.to(lobbyId).emit('playerHurt',{id:p.id,health:p.health});
    }
  });
  Object.values(lobby.bots).forEach(bot=>{
    const d=Math.hypot(bot.x-x,bot.y-y);
    if (d<radius) { bot.health-=Math.round(damage*(1-d/radius)); }
  });
}

function killPlayer(lobby,lobbyId,target,killerId,killerName) {
  target.health=0; target.isDead=true; target.deaths=(target.deaths||0)+1;
  if (target.hasFlag) {
    // Бросить флаг CTF
    Object.entries(lobby.flags||{}).forEach(([team,flag])=>{
      if (flag.ownerId===target.id) { flag.ownerId=null; flag.x=target.x; flag.y=target.y; io.to(lobbyId).emit('flagDropped',{team,x:flag.x,y:flag.y}); }
    });
    target.hasFlag=false;
  }
  io.to(lobbyId).emit('playerDied',{deadId:target.id,killerId,killerName});

  if (lobby.mode!==GAME_MODES.SURVIVAL) setTimeout(()=>respawnPlayer(lobbyId,target.id),3000);
  else checkSurvivalEnd(lobby,lobbyId);

  if (lobby.mode===GAME_MODES.TEAM) checkTeamEnd(lobby,lobbyId);
}

function checkTeamEnd(lobby,lobbyId) {
  const ra=Object.values(lobby.players).filter(p=>p.team==='red'&&!p.isDead).length;
  const ba=Object.values(lobby.players).filter(p=>p.team==='blue'&&!p.isDead).length;
  if (!ra) endGame(lobbyId,'🔵 Синяя команда победила!');
  else if (!ba) endGame(lobbyId,'🔴 Красная команда победила!');
}

function checkSurvivalEnd(lobby,lobbyId) {
  if (Object.values(lobby.players).every(p=>p.isDead))
    setTimeout(()=>endGame(lobbyId,`💀 Все пали на волне ${lobby.wave}`),1000);
}

function respawnPlayer(lobbyId,pid) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  const p=lobby.players[pid]; if (!p||!p.isDead) return;
  const sp=getSafeSpawn(lobby.mode,lobby.spawnIndex++);
  p.health=100; p.isDead=false; p.x=sp.x; p.y=sp.y; p.weapon='pistol';
  io.to(lobbyId).emit('playerRespawned',{id:pid,x:p.x,y:p.y});
}

function addXP(player, amount) {
  player.xp=(player.xp||0)+amount;
  const nextLevel=((player.level||1))*100;
  if (player.xp>=nextLevel) { player.xp-=nextLevel; player.level=(player.level||1)+1; }
}

function endGame(lobbyId,reason) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  if (lobby.state===LOBBY_STATES.ENDED) return;
  lobby.state=LOBBY_STATES.ENDED;
  clearInterval(lobby.gameTimer);
  clearInterval(lobby.loopInterval);

  const scores=Object.values(lobby.players)
    .sort((a,b)=>(b.score||0)-(a.score||0))
    .map(p=>({name:p.name,score:p.score||0,kills:p.kills||0,deaths:p.deaths||0,team:p.team||null,level:p.level||1}));

  io.to(lobbyId).emit('gameEnded',{reason,scores,wave:lobby.wave});

  setTimeout(()=>{
    if (!lobbies[lobbyId]) return;
    Object.assign(lobby,{state:LOBBY_STATES.WAITING,players:{},spectators:{},bots:{},bullets:[],pickups:[],barrels:[],wave:0,spawnIndex:0,flags:{},kingScore:{}});
    io.to(lobbyId).emit('lobbyReset');
    broadcastLobbyList();
  },12000);
}

// ==================== SOCKET.IO ====================
io.on('connection', socket => {
  console.log('+', socket.id);

  players[socket.id]={
    id:socket.id, name:'Player',
    x:450, y:290, angle:0,
    health:100, score:0, kills:0, deaths:0,
    color:`hsl(${Math.floor(Math.random()*360)},65%,60%)`,
    lobbyId:null, isDead:false, team:null,
    weapon:'pistol', hasFlag:false,
    xp:0, level:1
  };

  socket.emit('lobbyList',Object.values(lobbies).map(l=>({
    id:l.id,name:l.name,mode:l.mode,state:l.state,
    playerCount:Object.keys(l.players).length,maxPlayers:l.maxPlayers,wave:l.wave
  })));

  socket.on('setName', name=>{
    if (players[socket.id]) players[socket.id].name=String(name).substring(0,15).trim()||'Player';
  });

  socket.on('joinLobby', lobbyId=>{
    const lobby=lobbies[lobbyId], player=players[socket.id];
    if (!lobby||!player) return;
    if (player.lobbyId) leaveCurrentLobby(socket);
    player.lobbyId=lobbyId;
    socket.join(lobbyId);

    if (lobby.state===LOBBY_STATES.PLAYING) {
      lobby.spectators[socket.id]=player;
      socket.emit('becameSpectator');
      socket.emit('gameStarted',{mode:lobby.mode,players:lobby.players,wave:lobby.wave,pickups:lobby.pickups,barrels:lobby.barrels,flags:lobby.flags||null,kingZone:lobby.kingZone||null});
    } else {
      const sp=getSafeSpawn(lobby.mode,Object.keys(lobby.players).length);
      player.x=sp.x; player.y=sp.y; player.health=100; player.isDead=false; player.weapon='pistol';
      lobby.players[socket.id]=player;
      socket.emit('joinedLobby',{lobbyId,myId:socket.id,lobby:{mode:lobby.mode,state:lobby.state,name:lobby.name,players:lobby.players}});
      socket.to(lobbyId).emit('playerJoined',player);
      if (Object.keys(lobby.players).length>=lobby.minToStart&&lobby.state===LOBBY_STATES.WAITING) startCountdown(lobbyId);
    }
    broadcastLobbyList();
  });

  socket.on('leaveLobby',()=>leaveCurrentLobby(socket));

  socket.on('move', data=>{
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING||p.isDead) return;
    p.x=Math.max(20,Math.min(880,+data.x||p.x));
    p.y=Math.max(20,Math.min(560,+data.y||p.y));
    p.angle=+data.angle||0;
    socket.to(p.lobbyId).emit('playerMoved',{id:socket.id,x:p.x,y:p.y,angle:p.angle,weapon:p.weapon});

    // Подбор пикапов
    const lobby2=lobbies[p.lobbyId];
    lobby2.pickups.forEach(pk=>{
      if (!pk.active) return;
      if (Math.hypot(pk.x-p.x,pk.y-p.y)<24) {
        pk.active=false; pk.respawnTimer=15*20; // 15 сек
        if (pk.type==='health') { p.health=Math.min(100,p.health+40); io.to(p.lobbyId).emit('playerHurt',{id:p.id,health:p.health}); }
        else { p.weapon=pk.type; }
        io.to(p.lobbyId).emit('pickupTaken',{id:pk.id,playerId:p.id,type:pk.type});
      }
    });

    // CTF: подбор / возврат флага
    if (lobby2.mode===GAME_MODES.CTF&&lobby2.flags) {
      Object.entries(lobby2.flags).forEach(([team,flag])=>{
        if (!flag.ownerId&&flag.returned===false&&Math.hypot(flag.x-p.x,flag.y-p.y)<28) {
          // Вернуть свой флаг
          if (p.team===team) {
            flag.x=flag.baseX; flag.y=flag.baseY; flag.returned=true;
            io.to(p.lobbyId).emit('flagReturned',{team,byId:p.id});
          }
        }
        if (!flag.ownerId&&p.team!==team&&Math.hypot(flag.x-p.x,flag.y-p.y)<28) {
          flag.ownerId=p.id; p.hasFlag=true; flag.returned=false;
          io.to(p.lobbyId).emit('flagPickup',{team,byId:p.id,byName:p.name});
        }
        // Доставка флага
        if (flag.ownerId===p.id) {
          const myFlag=lobby2.flags[p.team];
          if (myFlag&&myFlag.returned&&Math.hypot(myFlag.baseX-p.x,myFlag.baseY-p.y)<40) {
            p.score=(p.score||0)+3; p.kills=(p.kills||0)+1; p.hasFlag=false;
            flag.ownerId=null; flag.x=flag.baseX; flag.y=flag.baseY; flag.returned=true;
            addXP(p,150);
            io.to(p.lobbyId).emit('flagCaptured',{team,byId:p.id,byName:p.name});
            io.to(p.lobbyId).emit('updateScore',{id:p.id,score:p.score,kills:p.kills,xp:p.xp,level:p.level});
            if (p.score>=3) endGame(p.lobbyId,`${p.team==='red'?'🔴':'🔵'} команда захватила 3 флага!`);
          }
        }
      });
    }
  });

  socket.on('shoot', data=>{
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING||p.isDead) return;
    const w=WEAPONS[p.weapon]||WEAPONS.pistol;
    if (w.melee) return;

    const bulletBase={ownerId:socket.id,ownerName:p.name,ownerTeam:p.team,isBot:false,speed:w.speed,damage:w.damage,weapon:p.weapon,explosive:w.explosive||false};
    for (let i=0;i<w.bullets;i++) {
      const spread=(Math.random()-0.5)*w.spread*2;
      const bullet={...bulletBase,id:`${socket.id}_${Date.now()}_${i}`,x:+data.x||p.x,y:+data.y||p.y,angle:(+data.angle||0)+spread};
      lobby.bullets.push({...bullet,velX:Math.cos(bullet.angle)*bullet.speed,velY:Math.sin(bullet.angle)*bullet.speed,life:90});
      io.to(p.lobbyId).emit('bulletCreated',bullet);
    }
  });

  socket.on('meleeAttack', ()=>{
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING||p.isDead) return;
    const w=WEAPONS[p.weapon]; if (!w?.melee) return;
    Object.values(lobby.players).forEach(t=>{
      if (t.id===socket.id||t.isDead) return;
      if (lobby.mode===GAME_MODES.TEAM&&t.team===p.team) return;
      if (Math.hypot(t.x-p.x,t.y-p.y)<w.range) {
        t.health-=w.damage;
        if (t.health<=0) killPlayer(lobby,p.lobbyId,t,socket.id,p.name);
        else io.to(p.lobbyId).emit('playerHurt',{id:t.id,health:t.health});
      }
    });
    io.to(p.lobbyId).emit('meleeEffect',{x:p.x,y:p.y,angle:p.angle});
  });

  socket.on('hitPlayer', data=>{
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobby=lobbies[p.lobbyId]; if (!lobby||lobby.state!==LOBBY_STATES.PLAYING) return;
    const target=lobby.players[data.targetId]; if (!target||target.isDead) return;
    if (lobby.mode===GAME_MODES.TEAM&&target.team===p.team) return;
    const w=WEAPONS[p.weapon]||WEAPONS.pistol;
    target.health-=data.damage||w.damage;
    if (target.health<=0) {
      p.score=(p.score||0)+1; p.kills=(p.kills||0)+1; addXP(p,100);
      io.to(p.lobbyId).emit('updateScore',{id:p.id,score:p.score,kills:p.kills,xp:p.xp,level:p.level});
      killPlayer(lobby,p.lobbyId,target,socket.id,p.name);
    } else io.to(p.lobbyId).emit('playerHurt',{id:target.id,health:target.health});
  });

  socket.on('chatMessage', msg=>{
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const text=String(msg).substring(0,80).trim(); if (!text) return;
    io.to(p.lobbyId).emit('chatMessage',{name:p.name,text,color:p.color,team:p.team});
  });

  socket.on('quickPhrase', idx=>{
    const phrases=['👍 GG!','🔥 Nice!','🆘 Help!','😂 LOL','💀 RIP','🎯 Headshot!'];
    const p=players[socket.id]; if (!p?.lobbyId) return;
    io.to(p.lobbyId).emit('quickPhrase',{id:socket.id,text:phrases[idx]||'👍'});
  });

  socket.on('disconnect',()=>{
    console.log('-',socket.id);
    leaveCurrentLobby(socket);
    delete players[socket.id];
    broadcastLobbyList();
  });

  function leaveCurrentLobby(socket) {
    const p=players[socket.id]; if (!p?.lobbyId) return;
    const lobbyId=p.lobbyId, lobby=lobbies[lobbyId];
    if (lobby) {
      delete lobby.players[socket.id]; delete lobby.spectators[socket.id];
      socket.to(lobbyId).emit('playerLeft',socket.id);
      if (lobby.state===LOBBY_STATES.COUNTDOWN&&Object.keys(lobby.players).length<lobby.minToStart) {
        clearInterval(lobby.countdownTimer); lobby.state=LOBBY_STATES.WAITING;
        io.to(lobbyId).emit('countdownCancelled');
      }
    }
    socket.leave(lobbyId); p.lobbyId=null;
    broadcastLobbyList();
  }
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`🚀 Порт ${PORT}`));
