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
  socket.on('join-room', ({ roomId, character }) => {
    if (!rooms[roomId]) return;

    // Leave previous room if any
    if (socket.roomId) {
      socket.leave(socket.roomId);
    }

    // Join new room
    socket.join(roomId);
    socket.roomId = roomId;

    // Add player to room with cached color
    rooms[roomId].players[socket.id] = {
      id: socket.id,
      position: [0, 1, 0],
      rotation: 0,
      character: character || 'cat',
      name: 'Player',
      team: null,
      color: getRandomPlayerColor(socket.id),
      lastGoalTime: Date.now()
    };

    // Update room last activity
    rooms[roomId].lastGoalTime = Date.now();

    // Send room state to new player
    socket.emit('init', { 
      id: socket.id, 
      players: rooms[roomId].players, 
      ball: rooms[roomId].ball, 
      scores: rooms[roomId].scores 
    });

    // Notify others in room
    socket.to(roomId).emit('player-joined', rooms[roomId].players[socket.id]);
    
    console.log(`Player ${socket.id} joined ${roomId} with character: ${character}`);
  });

  // Handle player movement with change detection and rate limiting
  socket.on('move', (data) => {
    if (!checkRateLimit(socket, 'move', 30)) {
      return;
    }
    
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
      const p = rooms[roomId].players[socket.id];
      
      // Validate input
      if (!validatePosition(data.position)) return;
      if (!validateRotation(data.rotation)) return;
      if (!validateTeam(data.team)) return;
      
      // Check if data changed (Hybrid: strict rotation, loose position)
      const rotationChanged = p.rotation !== data.rotation;
      const positionChanged = hasPositionChanged(p.position, data.position);
      const stateChanged = p.invisible !== data.invisible || p.giant !== data.giant;
      
      if (rotationChanged || positionChanged || stateChanged) {
        p.position = data.position;
        p.rotation = data.rotation;
        p.name = data.name;
        p.team = data.team;
        p.color = data.color;
        p.invisible = data.invisible;
        p.giant = data.giant;
        p.character = data.character;

        socket.volatile.to(roomId).emit('player-move', { 
          id: socket.id, 
          ...data
        });
      }
    }
  });

  // Handle ball update with change detection
  socket.on('ball-update', (data) => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      // Validate ball data
      if (!validatePosition(data.position) || !validatePosition(data.velocity)) return;
      
      const ball = rooms[roomId].ball;
      
      // Only update if ball data changed significantly
      if (hasBallDataChanged(ball, data)) {
        ball.position = data.position;
        ball.velocity = data.velocity;
        socket.volatile.to(roomId).emit('ball-update', ball);
      }
    }
  });

  // Handle goal
  socket.on('goal', (teamScored) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
 
    const room = rooms[roomId];
    const now = Date.now();
    
    // Goal cooldown: prevent rapid goal spamming
    if (now - room.lastGoalTime < 3000) return;
    
    // Validate that ball is actually in goal zone
    const ball = room.ball;
    const ballX = ball.position[0];
    const ballY = ball.position[1];
    const ballZ = ball.position[2];
    const blueGoalX = -11.2;
    const redGoalX = 11.2;
    const goalWidth = 2.2;
    const goalHeightLimit = 4;
    
    // Verify ball position is within goal boundaries
    const inGoalZone = (
      Math.abs(ballZ) < goalWidth &&
      ballY < goalHeightLimit &&
      ballY >= 0
    );
    
    // Check which goal was entered
    let validGoal = false;
    if (inGoalZone) {
      if (ballX < blueGoalX) {
        // Ball in blue goal zone (left)
        validGoal = teamScored === 'blue';
      } else if (ballX > redGoalX) {
        // Ball in red goal zone (right)
        validGoal = teamScored === 'red';
      }
    }
    
    // Only count goal if validation passes
    if (validGoal && room.scores[teamScored] !== undefined) {
      room.scores[teamScored]++;
      room.lastGoalTime = now;
      
      // Broadcast to room (exclude sender)
      socket.to(roomId).emit('score-update', room.scores);
      
      // Reset ball after 2 seconds
      setTimeout(() => {
        room.ball.position = [0, 0.5, 0];
        room.ball.velocity = [0, 0, 0];
        socket.to(roomId).emit('ball-reset', room.ball);
      }, 2000);
      
      console.log(`Goal scored for ${teamScored} in ${roomId} - validated by server`);
    } else {
      console.log(`Invalid goal attempt rejected: ball at [${ballX.toFixed(2)}, ${ballY.toFixed(2)}, ${ballZ.toFixed(2)}], claimed: ${teamScored}`);
    }
  });

  // Handle reset scores
  socket.on('reset-scores', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].scores.red = 0;
      rooms[roomId].scores.blue = 0;
      socket.to(roomId).emit('score-update', rooms[roomId].scores);
    }
  });

  // Handle chat messages with rate limiting
  socket.on('chat-message', (data) => {
    if (!checkRateLimit(socket, 'chat', 5)) {
      return;
    }
    
    const roomId = socket.roomId;
    if (roomId) {
      // Basic message validation
      if (!data.message || typeof data.message !== 'string') return;
      if (data.message.length > 500) return;
      
      io.to(roomId).emit('chat-message', {
        playerId: socket.id,
        playerName: data.playerName || 'Anonymous',
        team: data.team || '',
        message: data.message,
        timestamp: Date.now()
      });
    }
  });

  const handleLeaveRoom = () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
      delete rooms[roomId].players[socket.id];
      socket.to(roomId).emit('player-left', socket.id);
 
      // Delete empty rooms to free memory (not just reset)
      if (Object.keys(rooms[roomId].players).length === 0) {
        console.log(`Room ${roomId} empty. Deleting room to free memory.`);
        delete rooms[roomId];
      }
       
      socket.leave(roomId);
      socket.roomId = null;
    }
  };

  socket.on('leave-room', handleLeaveRoom);
 
  // Handle disconnect - clean up rate limits
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    // Clean up rate limits for this socket
    const now = Date.now();
    for (const key of rateLimits.keys()) {
      if (key.startsWith(`${socket.id}-`)) {
        rateLimits.delete(key);
      }
    }
    
    handleLeaveRoom();
  });
});

// Room cleanup system - clean up inactive rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of Object.entries(rooms)) {
    const playerCount = Object.keys(room.players).length;
    
    // Reset room if empty for > 5 minutes
    if (playerCount === 0 && now - room.lastGoalTime > 300000) {
      console.log(`Cleaned up empty room: ${roomId}`);
      rooms[roomId].ball = { position: [0, 0.5, 0], velocity: [0, 0, 0] };
      rooms[roomId].scores = { red: 0, blue: 0 };
      rooms[roomId].lastGoalTime = now;
    }
    
    // Reset scores if room has been inactive for 10 minutes
    if (playerCount > 0 && now - room.lastGoalTime > 600000) {
      console.log(`Reset scores for inactive room: ${roomId}`);
      rooms[roomId].scores = { red: 0, blue: 0 };
      io.to(roomId).emit('score-update', rooms[roomId].scores);
      rooms[roomId].lastGoalTime = now;
    }
  }
}, 300000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Socket.io server running on port', PORT);
});
