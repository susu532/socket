const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://soccer-2025.vercel.app"],
    methods: ["GET", "POST"],
    credentials: true
  },
  // Performance optimizations
  pingTimeout: 10000,
  pingInterval: 8000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 10,
    chunkSize: 16
  }
});

// Rate limiter for events
const rateLimits = new Map();

// Adaptive rate limits based on player count
function getAdaptiveRate(playerCount) {
  // 1-2 players: 30Hz, 3-6 players: 20Hz, 7+ players: 15Hz
  if (playerCount <= 2) return 30
  if (playerCount <= 6) return 20
  return 15
}

function checkRateLimit(socket, event, maxPerSecond = 30) {
  const now = Date.now();
  const key = `${socket.id}-${event}`;
  
  if (!rateLimits.has(key)) {
    rateLimits.set(key, { count: 1, lastCheck: now });
    return true;
  }
  
  const data = rateLimits.get(key);
  const elapsed = (now - data.lastCheck) / 1000;
  
  if (elapsed > 1) {
    data.count = 1;
    data.lastCheck = now;
    return true;
  }
  
  if (data.count >= maxPerSecond) {
    return false;
  }
  
  data.count++;
  return true;
}

// Clean up old rate limits every 10 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimits.entries()) {
    if (now - data.lastCheck > 60000) {
      rateLimits.delete(key);
    }
  }
}, 10000);

// Input validation functions
function validatePosition(pos) {
  if (!Array.isArray(pos) || pos.length !== 3) return false;
  if (pos.some(n => typeof n !== 'number' || isNaN(n))) return false;
  if (Math.abs(pos[0]) > 50 || Math.abs(pos[2]) > 50) return false;
  if (pos[1] < -10 || pos[1] > 20) return false;
  return true;
}

function validateRotation(rot) {
  return typeof rot === 'number' && rot >= -Math.PI * 2 && rot <= Math.PI * 2;
}

function validateTeam(team) {
  return team === 'red' || team === 'blue' || team === null;
}

function hasPositionChanged(oldPos, newPos) {
  const threshold = 0.01;
  return (
    Math.abs(oldPos[0] - newPos[0]) > threshold ||
    Math.abs(oldPos[1] - newPos[1]) > threshold ||
    Math.abs(oldPos[2] - newPos[2]) > threshold
  );
}

function hasBallDataChanged(oldData, newData) {
  const posThreshold = 0.01;
  const velThreshold = 0.01;
  
  if (!oldData) return true;
  
  return (
    Math.abs(oldData.position[0] - newData.position[0]) > posThreshold ||
    Math.abs(oldData.position[1] - newData.position[1]) > posThreshold ||
    Math.abs(oldData.position[2] - newData.position[2]) > posThreshold ||
    Math.abs(oldData.velocity[0] - newData.velocity[0]) > velThreshold ||
    Math.abs(oldData.velocity[1] - newData.velocity[1]) > velThreshold ||
    Math.abs(oldData.velocity[2] - newData.velocity[2]) > velThreshold
  );
}

// Cache of random colors for consistent colors on reconnection
const playerColors = new Map();

function getRandomPlayerColor(socketId) {
  if (playerColors.has(socketId)) {
    return playerColors.get(socketId);
  }
  const color = '#' + Math.floor(Math.random()*16777215).toString(16);
  playerColors.set(socketId, color);
  return color;
}

// Single Game State
const gameState = {
  players: {},
  ball: { position: [0, 0.5, 0], velocity: [0, 0, 0] },
  scores: { red: 0, blue: 0 },
  lastGoalTime: 0
};

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Ping-pong for latency measurement
  socket.on('ping', (timestamp) => {
    socket.emit('pong', timestamp)
  })

  // Handle joining the game
  socket.on('join-game', ({ character }) => {
    // Add player to game with cached color
    gameState.players[socket.id] = {
      id: socket.id,
      position: [0, 1, 0],
      rotation: 0,
      character: character || 'cat',
      name: 'Player',
      team: null,
      color: getRandomPlayerColor(socket.id),
      lastGoalTime: Date.now()
    };

    // Update last activity
    gameState.lastGoalTime = Date.now();

    // Send game state to new player
    socket.emit('init', { 
      id: socket.id, 
      players: gameState.players, 
      ball: gameState.ball, 
      scores: gameState.scores 
    });

    // Notify others
    socket.broadcast.emit('player-joined', gameState.players[socket.id]);
    
    console.log(`Player ${socket.id} joined game with character: ${character}`);
  });

  // Handle player movement with change detection and rate limiting
  socket.on('m', (data) => {
    const playerCount = Object.keys(gameState.players).length;
    const maxRate = getAdaptiveRate(playerCount);
    
    if (!checkRateLimit(socket, 'm', maxRate)) {
      return;
    }
    
    if (gameState.players[socket.id]) {
      const p = gameState.players[socket.id];
      
      // Validate input - data.p is position, data.r is rotation
      if (!validatePosition(data.p)) return;
      if (!validateRotation(data.r)) return;
      
      // Check if data changed (Hybrid: strict rotation, loose position)
      const rotationChanged = p.rotation !== data.r;
      const positionChanged = hasPositionChanged(p.position, data.p);
      const stateChanged = p.invisible !== data.i || p.giant !== data.g;
      
      if (rotationChanged || positionChanged || stateChanged) {
        p.position = data.p;
        p.rotation = data.r;
        p.invisible = data.i;
        p.giant = data.g;

        socket.volatile.broadcast.emit('m', { 
          id: socket.id, 
          p: data.p,
          r: data.r,
          i: data.i,
          g: data.g
        });
      }
    }
  });

  // Handle player metadata updates (name, team, character, color)
  socket.on('player-info', (data) => {
    if (gameState.players[socket.id]) {
      const p = gameState.players[socket.id];
      
      // Update fields if present
      if (data.name) p.name = data.name;
      if (validateTeam(data.team)) p.team = data.team;
      if (data.character) p.character = data.character;
      if (data.color) p.color = data.color;

      // Broadcast full info update
      socket.broadcast.emit('player-info', {
        id: socket.id,
        name: p.name,
        team: p.team,
        character: p.character,
        color: p.color
      });
    }
  });

  // Handle ball update with change detection
  socket.on('b', (data) => {
    // Validate ball data
    if (!validatePosition(data.p) || !validatePosition(data.v)) return;
    
    const ball = gameState.ball;
    
    // Only update if ball data changed significantly
    // We need to adapt hasBallDataChanged to work with new format or just inline check
    // Let's inline for clarity with new keys
    const posThreshold = 0.01;
    const velThreshold = 0.01;

    const changed = 
      Math.abs(ball.position[0] - data.p[0]) > posThreshold ||
      Math.abs(ball.position[1] - data.p[1]) > posThreshold ||
      Math.abs(ball.position[2] - data.p[2]) > posThreshold ||
      Math.abs(ball.velocity[0] - data.v[0]) > velThreshold ||
      Math.abs(ball.velocity[1] - data.v[1]) > velThreshold ||
      Math.abs(ball.velocity[2] - data.v[2]) > velThreshold;
    
    if (changed) {
      ball.position = data.p;
      ball.velocity = data.v;
      socket.volatile.broadcast.emit('b', { p: data.p, v: data.v });
    }
  });

  // Handle goal
  socket.on('goal', (teamScored) => {
    const now = Date.now();

    if (now - gameState.lastGoalTime < 3000) return;

    if (gameState.scores[teamScored] !== undefined) {
      gameState.scores[teamScored]++;
      gameState.lastGoalTime = now;
      io.emit('score-update', gameState.scores);
      
      setTimeout(() => {
        gameState.ball.position = [0, 0.5, 0];
        gameState.ball.velocity = [0, 0, 0];
        io.emit('ball-reset', gameState.ball);
      }, 2000);
    }
  });

  // Handle reset scores
  socket.on('reset-scores', () => {
    gameState.scores.red = 0;
    gameState.scores.blue = 0;
    io.emit('score-update', gameState.scores);
  });

  // Handle chat messages with rate limiting
  socket.on('chat-message', (data) => {
    if (!checkRateLimit(socket, 'chat', 5)) {
      return;
    }
    
    // Basic message validation
    if (!data.message || typeof data.message !== 'string') return;
    if (data.message.length > 500) return;
    
    io.emit('chat-message', {
      playerId: socket.id,
      playerName: data.playerName || 'Anonymous',
      team: data.team || '',
      message: data.message,
      timestamp: Date.now()
    });
  });

  const handleLeaveGame = () => {
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      io.emit('player-left', socket.id);

      // Reset game if empty
      if (Object.keys(gameState.players).length === 0) {
        console.log(`Game empty. Resetting state.`);
        gameState.ball = { position: [0, 0.5, 0], velocity: [0, 0, 0] };
        gameState.scores = { red: 0, blue: 0 };
      }
    }
  };

  socket.on('leave-game', handleLeaveGame);

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    handleLeaveGame();
  });
});

// Game cleanup system - clean up inactive game state every 5 minutes
setInterval(() => {
  const now = Date.now();
  const playerCount = Object.keys(gameState.players).length;
  
  // Reset game if empty for > 5 minutes
  if (playerCount === 0 && now - gameState.lastGoalTime > 300000) {
    console.log(`Cleaned up empty game state`);
    gameState.ball = { position: [0, 0.5, 0], velocity: [0, 0, 0] };
    gameState.scores = { red: 0, blue: 0 };
    gameState.lastGoalTime = now;
  }
  
  // Reset scores if game has been inactive for 10 minutes
  if (playerCount > 0 && now - gameState.lastGoalTime > 600000) {
    console.log(`Reset scores for inactive game`);
    gameState.scores = { red: 0, blue: 0 };
    io.emit('score-update', gameState.scores);
    gameState.lastGoalTime = now;
  }
}, 300000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Socket.io server running on port', PORT);
});
