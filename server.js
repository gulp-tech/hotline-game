const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public')); // Твоя игра лежит в папке public

io.on('connection', (socket) => {
  console.log('Игрок подключился: ' + socket.id);
  socket.on('player-move', (data) => {
    socket.broadcast.emit('player-update', data); // Рассылаем всем остальным
  });
});

http.listen(process.env.PORT || 3000, () => {
  console.log('Сервер запущен');
});
