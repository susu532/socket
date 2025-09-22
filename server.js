const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

let players = {};
let ball = { position: [0, 0.3, 0], velocity: [0, 0, 0] };

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  // Add new player
  players[socket.id] = {
    id: socket.id,
    position: [0, 1, 0],
    rotation: 0,
    color: '#' + Math.floor(Math.random()*16777215).toString(16),
  };
  // Send current state to new player
  socket.emit('init', { id: socket.id, players, ball });
  // Notify others
  socket.broadcast.emit('player-joined', players[socket.id]);

  // Handle player movement
  socket.on('move', (data) => {
    if (players[socket.id]) {
      players[socket.id].position = data.position;
      players[socket.id].rotation = data.rotation;
      io.emit('player-move', { id: socket.id, position: data.position, rotation: data.rotation });
    }
  });

  // Handle ball update
  socket.on('ball-update', (data) => {
    ball.position = data.position;
    ball.velocity = data.velocity;
    socket.broadcast.emit('ball-update', ball);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete players[socket.id];
    io.emit('player-left', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Socket.io server running on port', PORT);
});
