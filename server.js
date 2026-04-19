const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('./'));

let players = {};

io.on('connection', (socket) => {
  console.log('Игрок подключился: ' + socket.id);
  players[socket.id] = { x: 0, y: 0, angle: 0 };
  
  socket.on('playerMove', (data) => {
    players[socket.id] = data;
    socket.broadcast.emit('updatePlayer', { id: socket.id, ...data });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

http.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Сервер запущен'));
