const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

app.use(express.static('./'));

const players = {};

io.on('connection', (socket) => {
  console.log('Игрок подключился: ' + socket.id);
  
  players[socket.id] = { x: 0, y: 0, angle: 0 };
  
  // Отправляем новому игроку список всех игроков
  socket.emit('currentPlayers', players);
  
  // Сообщаем всем остальным о новом игроке
  socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });
  
  // Когда игрок двигается
  socket.on('playerMove', (data) => {
    if (players[socket.id]) {
      players[socket.id] = data;
      socket.broadcast.emit('updatePlayer', { id: socket.id, ...data });
    }
  });
  
  // Когда игрок стреляет
  socket.on('playerShoot', (data) => {
    socket.broadcast.emit('playerShot', { id: socket.id, ...data });
  });
  
  // Когда игрок отключается
  socket.on('disconnect', () => {
    console.log('Игрок вышел: ' + socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

http.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Сервер мультиплеера запущен!');
});
