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
  maxHttpBufferSize: 65536,
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 10,
    chunkSize: 16
  }
});

// Rate limiter for events - bucket-based for O(1) cleanup
const rateLimitBuckets = new Map();

// Adaptive rate limits based on player count
function getAdaptiveRate(playerCount) {
  // Increased rates: 1-2 players: 40Hz, 3-6 players: 30Hz, 7+ players: 25Hz
  if (playerCount <= 2) return 40
  if (playerCount <= 6) return 30
  return 25
}

// Adaptive ball update rate based on velocity
function getBallUpdateRate(velocity) {
  if (!velocity || velocity.length !== 3) return 40;
  const speed = Math.sqrt(
    velocity[0] ** 2 +
    velocity[1] ** 2 +
    velocity[2] ** 2
  );
  if (speed < 0.5) return 20;  // Slow: 20 Hz (50ms)
  if (speed < 2.0) return 30; // Medium: 30 Hz (33ms)
  return 40;                  // Fast: 40 Hz (25ms)
}

function checkRateLimit(socket, event, maxPerSecond = 30) {
  const now = Date.now();
  const key = `${socket.id}-${event}`;
  const bucketTime = Math.floor(now / 1000);

  // Get or create bucket
  if (!rateLimitBuckets.has(bucketTime)) {
    rateLimitBuckets.set(bucketTime, new Map());
  }
  const bucket = rateLimitBuckets.get(bucketTime);

  if (!bucket.has(key)) {
    bucket.set(key, { count: 1, lastCheck: now });
    return true;
  }

  const data = bucket.get(key);
  const elapsed = (now - data.lastCheck) / 1000;

  if (elapsed > 1) {
    data.count = 1;
    data.lastCheck = now;
    return true;
  }

  if (data.count >= maxPerSecond) {
    // ADD: Track rate limit breach
    const breaches = (rateLimitBreaches.get(socket.id) || 0) + 1;
    rateLimitBreaches.set(socket.id, breaches);

    // Log if excessive
    if (breaches % 10 === 0) {
      console.warn(`Rate limit breach ${breaches} from ${socket.id} for ${event}`);
    }

    return false;
  }

  data.count++;
  return true;
}

// Clean up old rate limit buckets every 10 seconds (O(1) cleanup)
setInterval(() => {
  const now = Date.now();
  const currentBucket = Math.floor(now / 1000);

  // Delete buckets older than 2 minutes
  for (const [bucketTime] of rateLimitBuckets.entries()) {
    if (currentBucket - bucketTime > 120) {
      rateLimitBuckets.delete(bucketTime);
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
  const threshold = 0.005; // Reduced from 0.01 to 0.005 for more sensitive detection
  return (
    Math.abs(oldPos[0] - newPos[0]) > threshold ||
    Math.abs(oldPos[1] - newPos[1]) > threshold ||
    Math.abs(oldPos[2] - newPos[2]) > threshold
  );
}

function hasBallDataChanged(oldData, newData) {
  const posThreshold = 0.02; // Reduced from 0.05 to 0.02 (2cm precision)
  const velThreshold = 0.005; // Reduced from 0.01 to 0.005

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
  ball: {
    position: [0, 0.5, 0], // Regular array for network serialization
    velocity: [0, 0, 0]
  },
  scores: { red: 0, blue: 0 },
  lastGoalTime: 0,
  ballAuthority: null // Track which player has ball authority
};

// Cached player count for performance (avoid O(n) on every move)
let cachedPlayerCount = 0;

// Track per-client connection quality for adaptive rates
const clientQuality = new Map(); // socketId -> { ping: number, quality: string }

// Track rate limit breaches per player
const rateLimitBreaches = new Map(); // socketId -> count

// Validate player movement to prevent speed hacks/teleportation
function validatePlayerMovement(oldPos, newPos, deltaTime) {
  const dx = newPos[0] - oldPos[0];
  const dy = newPos[1] - oldPos[1];
  const dz = newPos[2] - oldPos[2];
  const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

  // Max speed: 15 m/s with power-ups (generous allowance)
  const maxSpeed = 15;
  const maxDistance = maxSpeed * deltaTime;

  // Allow movement if within reasonable distance or small errors (< 0.5 units)
  return distance <= maxDistance || distance < 0.5;
}

// Get adaptive update rate based on client connection quality
function getClientUpdateRate(socketId) {
  const qualityData = clientQuality.get(socketId);
  if (!qualityData) return 30;

  const quality = qualityData.quality;
  switch(quality) {
    case 'poor': return 10;  // 10 Hz for poor connections
    case 'fair': return 20;  // 20 Hz for fair
    case 'good': return 25;  // 25 Hz for good
    case 'excellent': return 30; // 30 Hz for excellent
    default: return 20;
  }
}

// Ball authority management
function getBallAuthority() {
  if (!gameState.ballAuthority || !gameState.players[gameState.ballAuthority]) {
    const playerIds = Object.keys(gameState.players);
    if (playerIds.length === 0) {
      gameState.ballAuthority = null;
      return null;
    }
    gameState.ballAuthority = playerIds.sort()[0];
  }
  return gameState.ballAuthority;
}

function reassignBallAuthority() {
  const playerIds = Object.keys(gameState.players);
  if (playerIds.length === 0) {
    gameState.ballAuthority = null;
    return null;
  }
  const oldAuthority = gameState.ballAuthority;
  gameState.ballAuthority = playerIds.sort()[0];
  console.log(`Ball authority reassigned from ${oldAuthority} to ${gameState.ballAuthority}`);
  io.emit('ball-authority', gameState.ballAuthority);
  return gameState.ballAuthority;
}

// Periodic full state sync to fix desync
setInterval(() => {
  if (cachedPlayerCount > 0) {
    io.emit('full-state-sync', {
      players: gameState.players,
      ball: gameState.ball,
      scores: gameState.scores,
      ballAuthority: getBallAuthority(),
      timestamp: Date.now()
    });
  }
}, 2500); // Every 2.5 seconds

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Ping-pong for latency measurement
  socket.on('ping', (timestamp) => {
    const pingTime = Date.now() - timestamp;
    socket.emit('pong', timestamp);

    // ADD: Track and categorize connection quality
    const quality = pingTime < 100 ? 'excellent' :
                   pingTime < 200 ? 'good' :
                   pingTime < 300 ? 'fair' : 'poor';

    clientQuality.set(socket.id, { ping: pingTime, quality });
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

    // Update cached player count
    cachedPlayerCount = Object.keys(gameState.players).length;

    // Update ball authority if this is first player
    if (!gameState.ballAuthority) {
      reassignBallAuthority();
    }

    // Send game state to new player
    socket.emit('init', {
      id: socket.id,
      players: gameState.players,
      ball: gameState.ball,
      scores: gameState.scores,
      ballAuthority: getBallAuthority()
    });

    // Notify others
    socket.broadcast.emit('player-joined', gameState.players[socket.id]);

    console.log(`Player ${socket.id} joined game with character: ${character}`);
  });

  // Handle player movement with change detection and rate limiting
  socket.on('m', (data) => {
    // ADD: Use minimum of player-wide rate and client-specific rate
    const playerRate = getAdaptiveRate(cachedPlayerCount);
    const clientRate = getClientUpdateRate(socket.id);
    const maxRate = Math.min(playerRate, clientRate);

    if (!checkRateLimit(socket, 'm', maxRate)) {
      return;
    }
    
    if (gameState.players[socket.id]) {
      const p = gameState.players[socket.id];
      
      // Validate input - data.p is position, data.r is rotation
      if (!validatePosition(data.p)) return;
      if (!validateRotation(data.r)) return;

      // ADD: Validate movement is within reasonable speed limits
      const deltaTime = 0.033; // Approx 30 Hz update rate
      if (!validatePlayerMovement(p.position, data.p, deltaTime)) {
        // Log warning but don't kick (may be legitimate lag)
        const distance = Math.sqrt(
          Math.pow(data.p[0] - p.position[0], 2) +
          Math.pow(data.p[1] - p.position[1], 2) +
          Math.pow(data.p[2] - p.position[2], 2)
        );
        console.warn(`Suspicious movement from ${socket.id}: ${distance.toFixed(2)} units in ${deltaTime}s`);
        return; // Reject invalid movement
      }

      // Check if data changed (Hybrid: strict rotation, loose position)
      const rotationChanged = p.rotation !== data.r;
      const positionChanged = hasPositionChanged(p.position, data.p);
      const stateChanged = p.invisible !== data.i || p.giant !== data.g;
      
      if (rotationChanged || positionChanged || stateChanged) {
        p.position = data.p;
        p.rotation = data.r;
        p.invisible = data.i;
        p.giant = data.g;

        socket.broadcast.emit('m', {
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

  // Handle ball update with change detection and rate limiting
  socket.on('b', (data) => {
    // Validate ball data first to calculate velocity-based rate
    if (!validatePosition(data.p) || !validatePosition(data.v)) return;

    // ADD: Adaptive server-side rate limit for ball updates based on velocity
    const adaptiveRate = getBallUpdateRate(data.v);
    if (!checkRateLimit(socket, 'b', adaptiveRate)) return;

    // Validate ball data
    if (!validatePosition(data.p) || !validatePosition(data.v)) return;
    
    const ball = gameState.ball;
    
    // Only update if ball data changed significantly
    // We need to adapt hasBallDataChanged to work with new format or just inline check
    // Let's inline for clarity with new keys
    const posThreshold = 0.05; // Increased from 0.01 to 0.05 (5cm precision)
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
      socket.broadcast.emit('b', { p: data.p, v: data.v });
    }
  });

  // Handle goal
  socket.on('goal', (teamScored) => {
    const now = Date.now();

    if (now - gameState.lastGoalTime < 3000) return;

    if (gameState.scores[teamScored] !== undefined) {
      // ADD: Validate ball is actually in goal area
      const ball = gameState.ball;
      const goalXThreshold = 11.2; // Goals at X = ±11, allow slight margin

      const isInGoal = (teamScored === 'red' && ball.position[0] > goalXThreshold) ||
                     (teamScored === 'blue' && ball.position[0] < -goalXThreshold);

      if (!isInGoal) {
        console.warn(`Invalid goal attempt from ${socket.id}: Ball not in goal area (X=${ball.position[0].toFixed(2)})`);
        return; // Reject fake goal
      }

      gameState.scores[teamScored]++;
      gameState.lastGoalTime = now;

      // ADD: Combine score update and ball reset into single event
      setTimeout(() => {
        gameState.ball.position = [0, 0.5, 0];
        gameState.ball.velocity = [0, 0, 0];
        io.emit('goal-scored', {
          scores: gameState.scores,
          ball: gameState.ball,
          team: teamScored,
          timestamp: Date.now()
        });
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
      // ADD: Check for rate limit abuse before disconnect
      const breaches = rateLimitBreaches.get(socket.id);
      if (breaches && breaches > 50) {
        console.log(`Kicking ${socket.id} for rate limit abuse (${breaches} breaches)`);
        socket.disconnect();
        // Cleanup abusive player data
        rateLimitBreaches.delete(socket.id);
        clientQuality.delete(socket.id);
        return;
      }

      delete gameState.players[socket.id];

      // Update cached player count
      cachedPlayerCount = Object.keys(gameState.players).length;

      // ADD: Cleanup client quality tracking
      clientQuality.delete(socket.id);
      rateLimitBreaches.delete(socket.id);

      // Reassign ball authority if the authority player left
      if (gameState.ballAuthority === socket.id) {
        reassignBallAuthority();
      }

      io.emit('player-left', socket.id);

      // Reset game if empty
      if (Object.keys(gameState.players).length === 0) {
        console.log(`Game empty. Resetting state.`);
        gameState.ball.position = [0, 0.5, 0];
        gameState.ball.velocity = [0, 0, 0];
        gameState.scores = { red: 0, blue: 0 };
        gameState.ballAuthority = null;
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

  // Reset game if empty for > 5 minutes
  if (cachedPlayerCount === 0 && now - gameState.lastGoalTime > 300000) {
    console.log(`Cleaned up empty game state`);
    gameState.ball.position = [0, 0.5, 0];
    gameState.ball.velocity = [0, 0, 0];
    gameState.scores = { red: 0, blue: 0 };
    gameState.lastGoalTime = now;
  }

  // Reset scores if game has been inactive for 10 minutes
  if (cachedPlayerCount > 0 && now - gameState.lastGoalTime > 600000) {
    console.log(`Reset scores for inactive game`);
    gameState.scores = { red: 0, blue: 0 };
    io.emit('score-update', gameState.scores);
    gameState.lastGoalTime = now;
  }

  // ADD: Clean up playerColors for disconnected players (memory leak fix)
  for (const [socketId] of playerColors.entries()) {
    if (!gameState.players[socketId]) {
      playerColors.delete(socketId);
    }
  }
}, 300000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Socket.io server running on port', PORT);
});
