const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://soccer-2025.vercel.app"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Room state
const rooms = {};
for (let i = 1; i <= 13; i++) {
  rooms[`room${i}`] = {
    players: {},
    ball: { position: [0, 0.5, 0], velocity: [0, 0, 0] },
    scores: { red: 0, blue: 0 },
    lastGoalTime: 0
  };
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Handle joining a room
  socket.on('join-room', ({ roomId }) => {
    if (!rooms[roomId]) return; // Invalid room

    // Leave previous room if any
    if (socket.roomId) {
      socket.leave(socket.roomId);
    }

    // Join new room
    socket.join(roomId);
    socket.roomId = roomId;

    // Add player to room
    rooms[roomId].players[socket.id] = {
      id: socket.id,
      position: [0, 1, 0],
      rotation: 0,
      color: '#' + Math.floor(Math.random()*16777215).toString(16),
    };

    // Send room state to new player
    socket.emit('init', { 
      id: socket.id, 
      players: rooms[roomId].players, 
      ball: rooms[roomId].ball, 
      scores: rooms[roomId].scores 
    });

    // Notify others in the room
    socket.to(roomId).emit('player-joined', rooms[roomId].players[socket.id]);
    
    console.log(`Player ${socket.id} joined ${roomId}`);
  });

  // Handle player movement
  socket.on('move', (data) => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
      // Update state
      p.position = data.position;
      p.rotation = data.rotation;
      
      // Only update static props if provided (initial sync or change)
      if (data.name) p.name = data.name;
      if (data.team) p.team = data.team;
      if (data.model) p.model = data.model;
      if (data.color) p.color = data.color;
      if (data.invisible !== undefined) p.invisible = data.invisible;
      if (data.giant !== undefined) p.giant = data.giant;

      // Broadcast lightweight update
      socket.volatile.to(roomId).emit('player-move', { 
        id: socket.id, 
        position: data.position,
        rotation: data.rotation,
        invisible: data.invisible,
        giant: data.giant
      });
    }
  });

  // Handle ball update
  socket.on('ball-update', (data) => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].ball.position = data.position;
      rooms[roomId].ball.velocity = data.velocity;
      socket.volatile.to(roomId).emit('ball-update', rooms[roomId].ball);
    }
  });

  // Handle goal
  socket.on('goal', (teamScored) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const now = Date.now();

    if (now - room.lastGoalTime < 3000) return;

    if (room.scores[teamScored] !== undefined) {
      room.scores[teamScored]++;
      room.lastGoalTime = now;
      io.to(roomId).emit('score-update', room.scores);
      
      setTimeout(() => {
        room.ball.position = [0, 0.5, 0];
        room.ball.velocity = [0, 0, 0];
        io.to(roomId).emit('ball-reset', room.ball);
      }, 2000);
    }
  });

  // Handle reset scores
  socket.on('reset-scores', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].scores.red = 0;
      rooms[roomId].scores.blue = 0;
      io.to(roomId).emit('score-update', rooms[roomId].scores);
    }
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      io.to(roomId).emit('chat-message', {
        playerId: socket.id,
        playerName: data.playerName || 'Anonymous',
        team: data.team || '',
        message: data.message,
        timestamp: Date.now()
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const roomId = socket.roomId;
    
    if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
      delete rooms[roomId].players[socket.id];
      io.to(roomId).emit('player-left', socket.id);

      // Reset room if empty
      if (Object.keys(rooms[roomId].players).length === 0) {
        console.log(`Room ${roomId} empty. Resetting state.`);
        rooms[roomId].ball = { position: [0, 0.5, 0], velocity: [0, 0, 0] };
        rooms[roomId].scores = { red: 0, blue: 0 };
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Socket.io server running on port', PORT);
});
