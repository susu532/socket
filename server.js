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

let players = {};
let ball = { position: [0, 0.5, 0], velocity: [0, 0, 0] };
let scores = { red: 0, blue: 0 };
let lastGoalTime = 0;

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
  socket.emit('init', { id: socket.id, players, ball, scores });
  // Notify others
  socket.broadcast.emit('player-joined', players[socket.id]);

  // Handle player movement
  socket.on('move', (data) => {
    if (players[socket.id]) {
      players[socket.id].position = data.position;
      players[socket.id].rotation = data.rotation;
      players[socket.id].name = data.name;
      players[socket.id].team = data.team;
      players[socket.id].skin = data.skin;
      players[socket.id].color = data.color;
      players[socket.id].invisible = data.invisible; // Store invisible state
      players[socket.id].giant = data.giant; // Store giant state
      // Use volatile emit for smoother real-time updates (drops packets if behind)
      socket.volatile.broadcast.emit('player-move', { 
        id: socket.id, 
        position: data.position, 
        rotation: data.rotation,
        name: data.name,
        team: data.team,
        skin: data.skin,
        color: data.color,
        invisible: data.invisible, // Broadcast invisible state
        giant: data.giant // Broadcast giant state
      });
    }
  });

  // Handle ball update
  socket.on('ball-update', (data) => {
    ball.position = data.position;
    ball.velocity = data.velocity;
    // Use volatile for smoother ball sync (prioritize newest data)
    socket.volatile.broadcast.emit('ball-update', ball);
  });

  // Handle goal
  socket.on('goal', (teamScored) => {
    const now = Date.now();
    // Debounce: Ignore goals within 3 seconds of the last one
    if (now - lastGoalTime < 3000) {
      return;
    }

    if (scores[teamScored] !== undefined) {
      scores[teamScored]++;
      lastGoalTime = now;
      io.emit('score-update', scores);
      
      // Reset ball after delay
      setTimeout(() => {
        ball.position = [0, 0.5, 0];
        ball.velocity = [0, 0, 0];
        io.emit('ball-reset', ball);
      }, 2000);
    }
  });

  // Handle reset scores
  socket.on('reset-scores', () => {
    scores.red = 0;
    scores.blue = 0;
    io.emit('score-update', scores);
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    io.emit('chat-message', {
      playerId: socket.id,
      playerName: data.playerName || 'Anonymous',
      team: data.team || '',
      message: data.message,
      timestamp: Date.now()
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete players[socket.id];
    io.emit('player-left', socket.id);

    // Reset game state if no players are left
    if (Object.keys(players).length === 0) {
      console.log('No players left. Resetting game state.');
      ball = { position: [0, 0.5, 0], velocity: [0, 0, 0] };
      scores = { red: 0, blue: 0 };
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Socket.io server running on port', PORT);
});
