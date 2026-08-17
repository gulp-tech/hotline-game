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

    if (Math.hypot(this.x-this.lastX, this.y-this.lastY) < 0.5) {
      this.stuckTimer++;
      if (this.stuckTimer>30) { this.wanderAngle+=Math.PI*(0.5+Math.random()); this.stuckTimer=0; }
    } else { this.stuckTimer=0; }
    this.lastX=this.x; this.lastY=this.y;

    let action=null;
    if (closest && minDist<500) {
      this.state='chase';
      this.angle=Math.atan2(closest.y-this.y, closest.x-this.x);
      if (minDist>90) { 
        this.x+=Math.cos(this.angle)*this.speed; 
        this.y+=Math.sin(this.angle)*this.speed; 
      }
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
function createLobby(mode, name, isSolo = false) {
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
    kingTimer:{}, flags:{}, isSolo
  };
  return lobbies[id];
}

createLobby(GAME_MODES.DEATHMATCH,'⚔️ Deathmatch #1');
createLobby(GAME_MODES.SURVIVAL,  '🧟 Выживание #1');
createLobby(GAME_MODES.TEAM,      '🛡️ Команды #1');
createLobby(GAME_MODES.CTF,       '🏴 Захват флага #1');
createLobby(GAME_MODES.KING,      '👑 Король горы #1');

function broadcastLobbyList() {
  const list=Object.values(lobbies).filter(l => !l.isSolo).map(l=>({
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

// ==================== ИНИЦИАЛИЗАЦИЯ РЕЖИМОВ ====================
function initCTF(lobby) {
  lobby.flags={
    red:  {x:100,y:290,ownerId:null,baseX:100,baseY:290},
    blue: {x:800,y:290,ownerId:null,baseX:800,baseY:290}
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
  let count = lobby.isSolo ? 3 : 20;
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

  Object.values(players).forEach(p=>{
    if (p.lobbyId===lobbyId&&!lobby.players[p.id]) {
      lobby.spectators[p.id]=p; io.to(p.id).emit('becameSpectator');
    }
  });

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

  if (lobby.mode===GAME_MODES.CTF)  initCTF(lobby);
  if (lobby.mode===GAME_MODES.KING) initKing(lobby);
  initBarrels(lobby);
  spawnPickups(lobby);

  io.to(lobbyId).emit('gameStarted',{
    mode:lobby.mode, wave:lobby.wave, 
    flags:lobby.flags||null, kingZone:lobby.kingZone||null
  });

  if (lobby.mode!==GAME_MODES.SURVIVAL) {
    lobby.gameTimer=setInterval(()=>{
      lobby.timeLeft--;
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
}

function spawnWave(lobbyId) {
  const lobby=lobbies[lobbyId]; if (!lobby) return;
  const count=3+lobby.wave*2;
  io.to(lobbyId).emit('waveStarted',{wave:lobby.wave,botCount:count});
  const weapons=['pistol','auto','shotgun','sniper'];
  for (let i=0;i<count;i++) {
    setTimeout(()=>{
      if (!lobbies[lobbyId] || lobby.state !== LOBBY_STATES.PLAYING) return;
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
      }
      if (action.type==='melee') {
        const target=lobby.players[action.targetId];
        if (target&&!target.isDead) {
          target.health-=action.damage;
          if (target.health<=0) killPlayer(lobby,lobbyId,target,bot.id,bot.name);
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
                if (shooter) { 
                  shooter.score=(shooter.score||0)+1; shooter.kills=(shooter.kills||0)+1; 
                  addXP(shooter,50+lobby.wave*10); 
                }
                delete lobby.bots[bot.id];
                if (Object.keys(lobby.bots).length===0&&lobby.mode===GAME_MODES.SURVIVAL) {
                  lobby.wave++; setTimeout(()=>spawnWave(lobbyId),3000);
                }
              }
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
        if (pk.respawnTimer<=0) pk.active=true; 
      }
    });

    // --- CTF: флаги ---
    if (lobby.mode===GAME_MODES.CTF&&lobby.flags) {
      Object.entries(lobby.flags).forEach(([team,flag])=>{
        if (flag.ownerId) {
          const carrier=lobby.players[flag.ownerId];
          if (!carrier||carrier.isDead) {
            if (carrier) { flag.x=carrier.x; flag.y=carrier.y; }
            flag.ownerId=null;
          } else {
            flag.x=carrier.x; flag.y=carrier.y;
            // Проверка доставки
            if (carrier.team === team && Math.hypot(carrier.x-flag.baseX, carrier.y-flag.baseY) < 40) {
                lobby.kingScore[team] = (lobby.kingScore[team]||0) + 1;
                flag.ownerId = null;
                flag.x = flag.baseX; flag.y = flag.baseY;
                carrier.hasFlag = false;
                if(lobby.kingScore[team] >= 3) endGame(lobbyId, `${team==='red'?'🔴':'🔵'} команда захватила 3 флага!`);
            }
          }
        }
      });
    }

    // --- ОТПРАВКА СОСТОЯНИЯ (ОПТИМИЗИРОВАНО) ---
    const state = {
      players: Object.values(lobby.players).map(p => ({id:p.id, x:p.x, y:p.y, angle:p.angle, health:p.health, isDead:p.isDead, score:p.score, kills:p.kills, weapon:p.weapon, team:p.team, name:p.name, hasFlag:p.hasFlag, level:p.level})),
      bots: Object.values(lobby.bots).map(b => ({id:b.id, x:b.x, y:b.y, angle:b.angle, health:b.health, weapon:b.weapon})),
      bullets: lobby.bullets.map(b => ({id:b.id, x:b.x, y:b.y, isBot:b.isBot})),
      explosions: lobby.explosions,
      barrels: lobby.barrels,
      pickups: lobby.pickups,
      flags: lobby.flags,
      kingScore: lobby.kingScore,
      wave: lobby.wave
    };
    io.to(lobbyId).emit('state', state);

  },50);
}

function createExplosion(lobby,lobbyId,x,y,radius,damage) {
  lobby.explosions.push({x,y,radius,life:20});
  Object.values(lobby.players).forEach(p=>{
    if (p.isDead) return;
    const d=Math.hypot(p.x-x,p.y-y);
    if (d<radius) {
      const dmg=Math.round(damage*(1-d/radius));
      p.health-=dmg;
      if (p.health<=0) killPlayer(lobby,lobbyId,p,'explosion','💥');
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
    Object.entries(lobby.flags||{}).forEach(([team,flag])=>{
      if (flag.ownerId===target.id) { flag.ownerId=null; flag.x=target.x; flag.y=target.y; }
    });
    target.hasFlag=false;
  }

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
    if (lobby.isSolo) { delete lobbies[lobbyId]; return; }
    Object.assign(lobby,{state:LOBBY_STATES.WAITING,players:{},spectators:{},bots:{},bullets:[],pickups:[],barrels:[],wave:0,spawnIndex:0,flags:{},kingScore:{}});
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
    xp:0, level:1, lastShot:0
  };

  socket.emit('lobbyList',Object.values(lobbies).filter(l => !l.isSolo).map(l=>({
    id:l.id,name:l.name,mode:l.mode,state:l.state,
    playerCount:Object.keys(l.players).length,maxPlayers:l.maxPlayers,wave:l.wave
  })));

  socket.on('setName', name=>{
    if (players[socket.id]) players[socket.id].name=String(name).substring(0,15).trim()||'Player';
  });

  socket.on('joinLobby', lobbyId=>{
    const lobby=lobbies[lobbyId], player=players[socket.id];
    if (!lobby||!player||lobby.isSolo) return;
    
    if (Object.keys(lobby.players).length >= lobby.maxPlayers) return;

    player.lobbyId=lobbyId;
    socket.join(lobbyId);
    lobby.players[socket.id]=player;

    if (lobby.state===LOBBY_STATES.WAITING && Object.keys(lobby.players).length >= lobby.minToStart) {
      startCountdown(lobbyId);
    }

    broadcastLobbyList();
    socket.emit('joinedLobby', {lobbyId: lobbyId, mode: lobby.mode, name: lobby.name});
  });

  socket.on('startSolo', () => {
    const player=players[socket.id]