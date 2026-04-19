const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('./'));

// Состояние лобби
let lobby = {
  players: {},
  state: 'waiting', // waiting / countdown / playing
  countdown: 10,
  timer: null
};

function startCountdown() {
  if (lobby.timer) return;
  lobby.state = 'countdown';
  lobby.countdown = 10;
  io.emit('lobbyState', lobby.state, lobby.countdown, lobby.players);

  lobby.timer = setInterval(() => {
    lobby.countdown--;
    io.emit('lobbyState', lobby.state, lobby.countdown, lobby.players);

    if (lobby.countdown <= 0) {
      clearInterval(lobby.timer);
      lobby.timer = null;
      lobby.state = 'playing';
      io.emit('gameStart', lobby.players);
    }
  }, 1000);
}

function stopCountdown() {
  if (lobby.timer) {
    clearInterval(lobby.timer);
    lobby.timer = null;
  }
  lobby.state = 'waiting';
  lobby.countdown = 10;
  io.emit('lobbyState', lobby.state, lobby.countdown, lobby.players);
}

io.on('connection', (socket) => {
  console.log('Игрок подключился: ' + socket.id);

  // Добавляем игрока в лобби
  lobby.players[socket.id] = {
    id: socket.id,
    name: 'Player ' + Object.keys(lobby.players).length + 1,
    ready: false,
    x: 0, y: 0, angle: 0
  };

  // Отправляем новому игроку текущее состояние
  socket.emit('lobbyState', lobby.state, lobby.countdown, lobby.players);
  socket.emit('yourId', socket.id);

  // Сообщаем всем о новом игроке
  io.emit('playerJoined', lobby.players[socket.id]);
  io.emit('playerCount', Object.keys(lobby.players).length);

  // Если игроков >= 2 и не идет отсчет — запускаем
  if (Object.keys(lobby.players).length >= 2 && lobby.state === 'waiting') {
    startCountdown();
  }

  // Движение игрока
  socket.on('playerMove', (data) => {
    if (lobby.players[socket.id]) {
      lobby.players[socket.id].x = data.x;
      lobby.players[socket.id].y = data.y;
      lobby.players[socket.id].angle = data.angle;
      socket.broadcast.emit('updatePlayer', {
        id: socket.id, ...lobby.players[socket.id]
      });
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('Игрок вышел: ' + socket.id);
    delete lobby.players[socket.id];
    io.emit('playerLeft', socket.id);
    io.emit('playerCount', Object.keys(lobby.players).length);

    // Если игроков меньше 2 — останавливаем отсчет
    if (Object.keys(lobby.players).length < 2 && lobby.state === 'countdown') {
      stopCountdown();
    }

    // Если никого нет — сбрасываем всё
    if (Object.keys(lobby.players).length === 0) {
      lobby.state = 'waiting';
      lobby.countdown = 10;
    }
  });
});

http.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Сервер запущен!');
});
