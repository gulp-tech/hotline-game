const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Хранилище игроков
const players = {};
const bullets = {};
let bulletId = 0;

io.on('connection', (socket) => {
  console.log(`✅ Игрок подключился: ${socket.id}`);

  // Создаём нового игрока
  players[socket.id] = {
    id: socket.id,
    x: Math.floor(Math.random() * 700) + 50,
    y: Math.floor(Math.random() * 500) + 50,
    angle: 0,
    health: 100,
    score: 0,
    name: `Player_${socket.id.substring(0, 4)}`,
    color: `hsl(${Math.random() * 360}, 70%, 60%)`
  };

  // Отправляем новому игроку текущее состояние
  socket.emit('init', {
    myId: socket.id,
    players: players
  });

  // Сообщаем всем остальным о новом игроке
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // Движение игрока
  socket.on('move', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].angle = data.angle;
      socket.broadcast.emit('playerMoved', {
        id: socket.id,
        x: data.x,
        y: data.y,
        angle: data.angle
      });
    }
  });

  // Выстрел
  socket.on('shoot', (data) => {
    const bullet = {
      id: bulletId++,
      ownerId: socket.id,
      x: data.x,
      y: data.y,
      angle: data.angle,
      speed: 10
    };
    io.emit('bulletCreated', bullet);
  });

  // Попадание
  socket.on('hit', (data) => {
    const target = players[data.targetId];
    if (target) {
      target.health -= 25;
      if (target.health <= 0) {
        target.health = 100;
        target.x = Math.floor(Math.random() * 700) + 50;
        target.y = Math.floor(Math.random() * 500) + 50;
        if (players[socket.id]) {
          players[socket.id].score += 1;
        }
        io.emit('playerDied', {
          deadId: data.targetId,
          killerId: socket.id,
          respawnX: target.x,
          respawnY: target.y
        });
        io.emit('updateScore', {
          id: socket.id,
          score: players[socket.id]?.score || 0
        });
      } else {
        io.emit('playerHurt', {
          id: data.targetId,
          health: target.health
        });
      }
    }
  });

  // Смена имени
  socket.on('setName', (name) => {
    if (players[socket.id]) {
      players[socket.id].name = name.substring(0, 15);
      io.emit('nameUpdated', {
        id: socket.id,
        name: players[socket.id].name
      });
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log(`❌ Игрок отключился: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
