import { Room } from 'colyseus'
import RAPIER from '@dimforge/rapier3d-compat'
import { GameState, PlayerState, PowerUpState } from '../schema/GameState.js'
import { registerPrivateRoom, unregisterRoom, getRoomIdByCode } from '../roomRegistry.js'
import { PHYSICS } from '../schema/PhysicsConstants.js'

const PHYSICS_TICK_RATE = 1000 / PHYSICS.TICK_RATE 
const GOAL_COOLDOWN = 5000          // 5 seconds
const EMPTY_DISPOSE_DELAY = 30000   // 30 seconds

export class SoccerRoom extends Room {
  maxClients = 4

  isPublic = true
  privateCode = null
  codeSent = false
  emptyDisposeTimeout = null

  roomCreatedAt = Date.now()

  // Physics world
  world = null
  playerBodies = new Map()
  bots = new Map() // Store bot AI state
  ballBody = null

  // Timers
  lastGoalTime = 0
  timerInterval = null
  powerUpInterval = null
  currentTick = 0
  
  // Stats tracking
  lastTouchSessionId = null
  secondLastTouchSessionId = null
  
  // Power-up types
  POWER_UP_TYPES = {
    speed: { duration: 15000 },
    kick: { duration: 15000 },
    jump: { duration: 15000 },
    invisible: { duration: 15000 },
    giant: { duration: 15000 }
  }

  async onCreate(options) {
    await RAPIER.init()
    this.setState(new GameState())
    
    // Set patch rate to 30Hz (33ms) to reduce bandwidth usage
    this.setPatchRate(33)


    this.roomCreatedAt = Date.now()

    this.isPublic = options?.isPublic !== false
    this.setPrivate(!this.isPublic)

    if (!this.isPublic) {
      const requestedCode = options?.code ? String(options.code).trim().toUpperCase() : null
      this.privateCode = requestedCode || this.generateUniqueJoinCode()
      registerPrivateRoom(this.roomId, this.privateCode)
    }

    // Set public/private state
    this.isPublic = options.isPublic !== false
    
    this.setMetadata({
      isPublic: this.isPublic,
      map: options?.map || this.state.selectedMap || null,
      createdAt: this.roomCreatedAt,
      redCount: 0,
      blueCount: 0,
      mode: options?.mode || 'standard'
    })

    // Set map from options if provided (Host's choice)
    if (options.map) {
      this.state.selectedMap = options.map
    }

    // Handle Training Mode
    if (options.mode === 'training') {
      this.maxClients = 1 // Strict 1 player limit (Offline mode)
      this.isPublic = false
      this.setMetadata({ ...this.metadata, isPublic: false })
      
      this.clock.setTimeout(() => {
        this.createBot(options.difficulty || 'medium')
      }, 1000)
    }

    // Physics world
    this.world = new RAPIER.World({ x: 0, y: -PHYSICS.WORLD_GRAVITY, z: 0 })

    // Create arena colliders
    this.createArena()

    // Create ball rigid body
    this.createBall()

    // Physics loop
    this.setSimulationInterval((deltaTime) => this.physicsUpdate(deltaTime), PHYSICS_TICK_RATE)

    // Power-up spawning (every 20 seconds)
    this.powerUpInterval = this.clock.setInterval(() => this.spawnPowerUp(), 20000)

    // Message handlers
    this.onMessage('input', (client, data) => this.handleInput(client, data))
    this.onMessage('kick', (client, data) => this.handleKick(client, data))
    this.onMessage('join-team', (client, data) => this.handleJoinTeam(client, data))
    this.onMessage('chat', (client, data) => this.handleChat(client, data))
    this.onMessage('start-game', (client) => this.handleStartGame(client))
    this.onMessage('end-game', (client) => this.handleEndGame(client))
    this.onMessage('update-state', (client, data) => this.handleUpdateState(client, data))
    this.onMessage('ping', (client) => {
      client.send('pong', {})
    })
  }

  getTeamCounts(excludeSessionId = null) {
    let red = 0
    let blue = 0
    this.state.players.forEach((p, id) => {
      if (excludeSessionId && id === excludeSessionId) return
      if (p.team === 'blue') blue += 1
      else red += 1
    })
    return { red, blue }
  }

  chooseTeam(requestedTeam, excludeSessionId = null) {
    const desired = requestedTeam === 'blue' ? 'blue' : 'red'
    const other = desired === 'red' ? 'blue' : 'red'
    const counts = this.getTeamCounts(excludeSessionId)

    if (counts[desired] < 2) return desired
    if (counts[other] < 2) return other
    return desired
  }

  updateRoomMetadataCounts() {
    const counts = this.getTeamCounts()
    this.setMetadata({
      isPublic: this.isPublic,
      map: this.state.selectedMap || this.metadata?.map || null,
      createdAt: this.roomCreatedAt,
      redCount: counts.red,
      blueCount: counts.blue
    })
  }

  createArena() {
    const pitchWidth = PHYSICS.ARENA_WIDTH
    const pitchDepth = PHYSICS.ARENA_DEPTH
    const wallHeight = PHYSICS.WALL_HEIGHT
    const wallThickness = PHYSICS.WALL_THICKNESS

    // Ground
    const groundDesc = RAPIER.ColliderDesc.cuboid(PHYSICS.ARENA_WIDTH / 2, 0.25, PHYSICS.ARENA_DEPTH / 2)
      .setTranslation(0, -0.25, 0)
      .setFriction(2.0)
      .setRestitution(PHYSICS.GROUND_RESTITUTION)
    this.world.createCollider(groundDesc)

    // Back walls (Z axis)
    const backWall1 = RAPIER.ColliderDesc.cuboid((pitchWidth + wallThickness * 2) / 2, wallHeight / 2, wallThickness / 2)
      .setTranslation(0, wallHeight / 2, -pitchDepth / 2 - wallThickness / 2)
      .setRestitution(PHYSICS.WALL_RESTITUTION)
    this.world.createCollider(backWall1)

    const backWall2 = RAPIER.ColliderDesc.cuboid((pitchWidth + wallThickness * 2) / 2, wallHeight / 2, wallThickness / 2)
      .setTranslation(0, wallHeight / 2, pitchDepth / 2 + wallThickness / 2)
      .setRestitution(PHYSICS.WALL_RESTITUTION)
    this.world.createCollider(backWall2)

    // Side walls with goal gaps
    const sideWallHalfDepth = 7 / 2
    const sideWallPositions = [
      [-pitchWidth / 2 - wallThickness / 2, -6.5],
      [-pitchWidth / 2 - wallThickness / 2, 6.5],
      [pitchWidth / 2 + wallThickness / 2, -6.5],
      [pitchWidth / 2 + wallThickness / 2, 6.5]
    ]

    sideWallPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cuboid(wallThickness / 2, wallHeight / 2, sideWallHalfDepth)
        .setTranslation(x, wallHeight / 2, z)
        .setRestitution(PHYSICS.WALL_RESTITUTION)
      this.world.createCollider(desc)
    })

    // Goal back walls (The "Net" back)
    // Matching "big wall" thickness (2m) and height (10m)
    const goalBackWallPositions = [[-17.2, 0], [17.2, 0]]
    goalBackWallPositions.forEach(([x, z]) => {
      // halfX=1 (2m thick), halfY=5 (10m high), halfZ=5 (10m wide to overlap sides)
      const desc = RAPIER.ColliderDesc.cuboid(1, 5, 5)
        .setTranslation(x, 5, z)
        .setRestitution(PHYSICS.GOAL_RESTITUTION)
      this.world.createCollider(desc)
    })

    // Goal posts (approximated as boxes)
    const postPositions = [
      [-10.8, -2.5], [-10.8, 2.5], [10.8, -2.5], [10.8, 2.5]
    ]
    postPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cylinder(2, 0.06)
        .setTranslation(x, 2, z)
        .setRestitution(PHYSICS.POST_RESTITUTION)
      this.world.createCollider(desc)
    })

    // Crossbars
    const crossbarPositions = [[-10.8, 0], [10.8, 0]]
    crossbarPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cylinder(3, 0.02)
        .setTranslation(x, 4, z)
        .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) })
        .setRestitution(PHYSICS.POST_RESTITUTION)
      this.world.createCollider(desc)
    })

    // Goal net side walls (prevent ball from escaping between posts and net sides)
    // These walls connect the goal posts to the back of the net on each side
    // Goal net side walls (prevent ball from escaping between posts and net sides)
    // Thin walls positioned just OUTSIDE the goal mouth (inner face at z=±2.5)
    const goalNetSideWalls = [
      // Left goal (x = -10.8 to -17.2)
      { x: (-10.8 - 17.2) / 2, z: 2.6, halfX: (17.2 - 10.8) / 2, halfZ: 0.1 }, // Top side (z=2.5 to 2.7)
      { x: (-10.8 - 17.2) / 2, z: -2.6, halfX: (17.2 - 10.8) / 2, halfZ: 0.1 }, // Bottom side (z=-2.7 to -2.5)
      // Right goal (x = 10.8 to 17.2)
      { x: (10.8 + 17.2) / 2, z: 2.6, halfX: (17.2 - 10.8) / 2, halfZ: 0.1 }, // Top side
      { x: (10.8 + 17.2) / 2, z: -2.6, halfX: (17.2 - 10.8) / 2, halfZ: 0.1 } // Bottom side
    ]
    goalNetSideWalls.forEach(({ x, z, halfX, halfZ }) => {
      const desc = RAPIER.ColliderDesc.cuboid(halfX, 13, halfZ)
        .setTranslation(x, 13, z)
        .setRestitution(PHYSICS.GOAL_RESTITUTION)
      this.world.createCollider(desc)
    })

    // Goal net ceiling (prevent ball from escaping over crossbar)
    const goalNetCeilingPositions = [-14.0, 14.0] // ±(10.8 + 17.2) / 2
    goalNetCeilingPositions.forEach(x => {
      const desc = RAPIER.ColliderDesc.cuboid(3.2, 5, 2.5) // halfX=3.2, halfY=5 (10m tall), halfZ=2.5
        .setTranslation(x, 9.1, 0) // Starts at 4.1, extends to 14.1
        .setRestitution(PHYSICS.GOAL_RESTITUTION)
      this.world.createCollider(desc)
    })

    // Ceiling
    const ceiling = RAPIER.ColliderDesc.cuboid(pitchWidth / 2, 0.1, pitchDepth / 2)
      .setTranslation(0, wallHeight, 0)
    this.world.createCollider(ceiling)

  }

  createBall() {
    const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 2, 0)
      .setCcdEnabled(true)
      .setLinearDamping(PHYSICS.BALL_LINEAR_DAMPING)
      .setAngularDamping(PHYSICS.BALL_ANGULAR_DAMPING)

    this.ballBody = this.world.createRigidBody(ballBodyDesc)

    const ballCollider = RAPIER.ColliderDesc.ball(PHYSICS.BALL_RADIUS)
      .setMass(PHYSICS.BALL_MASS)
      .setRestitution(PHYSICS.BALL_RESTITUTION)
      .setFriction(0.5)

    this.world.createCollider(ballCollider, this.ballBody)
  }

  createPlayerBody(sessionId, team) {
    const spawnX = team === 'red' ? -6 : 6
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spawnX, 0.1, 0)

    const body = this.world.createRigidBody(bodyDesc)

    const collider = RAPIER.ColliderDesc.ball(PHYSICS.PLAYER_RADIUS)
      .setTranslation(0, PHYSICS.PLAYER_RADIUS, 0)
      .setFriction(2.0)
      .setRestitution(0.0)

    this.world.createCollider(collider, body)
    this.playerBodies.set(sessionId, body)

    return { x: spawnX, y: 0.1, z: 0 }
  }

  spawnPowerUp() {
    if (this.state.powerUps.size >= 3) return // Limit power-ups on field

    const id = Math.random().toString(36).substr(2, 9)
    const types = Object.keys(this.POWER_UP_TYPES)
    const type = types[Math.floor(Math.random() * types.length)]
    
    const p = new PowerUpState()
    p.id = id
    p.type = type
    p.x = (Math.random() - 0.5) * 28
    p.y = 0.5
    p.z = (Math.random() - 0.5) * 18
    
    this.state.powerUps.set(id, p)

    // Despawn after 15 seconds if not collected
    this.clock.setTimeout(() => {
      if (this.state.powerUps.has(id)) {
        this.state.powerUps.delete(id)
      }
    }, 15000)
  }

  onJoin(client, options) {
    console.log(`Player ${client.sessionId} joined`)

    if (this.emptyDisposeTimeout) {
      try {
        this.emptyDisposeTimeout.clear()
      } catch (e) {
        // ignore
      }
      this.emptyDisposeTimeout = null
    }

    if (this.privateCode) {
      client.send('room-code', { code: this.privateCode })
    }

    const player = new PlayerState()
    player.name = options.name || 'Player'
    player.team = this.chooseTeam(options.team || 'red')
    player.character = options.character || 'cat'

    const spawn = this.createPlayerBody(client.sessionId, player.team)
    player.x = spawn.x
    player.y = spawn.y
    player.z = spawn.z
    player.sessionId = client.sessionId
    player.lastProcessedJumpRequestId = 0 // Track processed jumps

    this.state.players.set(client.sessionId, player)

    this.updateRoomMetadataCounts()

    // Notify all about new player
    this.broadcast('player-joined', {
      sessionId: client.sessionId,
      name: player.name,
      team: player.team
    })
  }

  onLeave(client, consented) {
    console.log(`Player ${client.sessionId} left`)

    // Remove physics body
    const body = this.playerBodies.get(client.sessionId)
    if (body) {
      this.world.removeRigidBody(body)
      this.playerBodies.delete(client.sessionId)
    }

    this.state.players.delete(client.sessionId)

    this.updateRoomMetadataCounts()

    this.broadcast('player-left', { sessionId: client.sessionId })

    if (this.clients.length === 0 && !this.emptyDisposeTimeout) {
      this.emptyDisposeTimeout = this.clock.setTimeout(() => {
        if (this.clients.length === 0) {
          this.disconnect()
        }
      }, EMPTY_DISPOSE_DELAY)
    }
  }

  onDispose() {
    unregisterRoom(this.roomId)
  }

  generateUniqueJoinCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    for (let i = 0; i < 50; i++) {
      let code = ''
      for (let j = 0; j < 4; j++) {
        code += chars[Math.floor(Math.random() * chars.length)]
      }
      if (!getRoomIdByCode(code)) return code
    }
    // fallback (very unlikely)
    return Math.random().toString(36).slice(2, 6).toUpperCase()
  }

  handleInput(client, data) {
    const player = this.state.players.get(client.sessionId)
    if (!player) return

    // Initialize queue if needed
    if (!player.inputQueue) player.inputQueue = []
    if (player.lastReceivedTick === undefined) player.lastReceivedTick = 0

    // Helper to process a single input
    const processInput = (input) => {
      // Deduplicate: Only accept newer inputs
      if (input.tick > player.lastReceivedTick) {
        player.inputQueue.push(input)
        player.lastReceivedTick = input.tick
      }
    }

    // Handle batched inputs
    if (data.inputs && Array.isArray(data.inputs)) {
      // Sort batch by tick to ensure correct order processing
      data.inputs.sort((a, b) => a.tick - b.tick)
      data.inputs.forEach(processInput)
      
      // Safety: Cap queue size to prevent memory leaks or speed hacks
      if (player.inputQueue.length > 60) {
        player.inputQueue = player.inputQueue.slice(-60)
      }
    } else {
      // Legacy/Single input fallback
      processInput(data)
    }
  }

  handleKick(client, data) {
    const player = this.state.players.get(client.sessionId)
    const body = this.playerBodies.get(client.sessionId)
    if (!player || !body || !this.ballBody) return

    const playerPos = body.translation()
    const ballPos = this.ballBody.translation()

    // Distance check
    const dx = ballPos.x - playerPos.x
    const dy = ballPos.y - playerPos.y
    const dz = ballPos.z - playerPos.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

    if (dist < PHYSICS.KICK_RANGE) {
      const { impulseX, impulseY, impulseZ } = data
      const kickMult = player.kickMult || 1

      // Apply impulse with a slight vertical boost for better feel
      // Note: impulse is already scaled by kickMult from client
      this.ballBody.applyImpulse({ 
        x: impulseX, 
        y: impulseY + PHYSICS.KICK_VERTICAL_BOOST, // Base vertical boost (not scaled by kickMult again)
        z: impulseZ 
      }, true)

      // Broadcast kick visual to all clients with impulse for prediction
      this.broadcast('ball-kicked', { 
        playerId: client.sessionId,
        impulse: { 
          x: impulseX, 
          y: impulseY + PHYSICS.KICK_VERTICAL_BOOST * kickMult, // Visual boost scaled
          z: impulseZ 
        }
      })

      // Set ball ownership to kicker
      this.state.ball.ownerSessionId = client.sessionId

      // Update stats and touch history
      player.shots++
      if (this.lastTouchSessionId !== client.sessionId) {
        this.secondLastTouchSessionId = this.lastTouchSessionId
        this.lastTouchSessionId = client.sessionId
      }
    }
  }

  handleJoinTeam(client, data) {
    const player = this.state.players.get(client.sessionId)
    if (!player) return

    player.name = data.name || player.name
    player.team = this.chooseTeam(data.team || player.team, client.sessionId)
    player.character = data.character || player.character

    this.updateRoomMetadataCounts()

    // Respawn at correct position
    const body = this.playerBodies.get(client.sessionId)
    if (body) {
      const spawnX = player.team === 'red' ? -6 : 6
      body.setNextKinematicTranslation({ x: spawnX, y: 0.1, z: 0 })
      player.x = spawnX
      player.y = 0.1
      player.z = 0
    }
  }

  handleChat(client, data) {
    const player = this.state.players.get(client.sessionId)
    if (!player) return

    this.broadcast('chat-message', {
      playerName: player.name,
      team: player.team,
      message: data.message,
      time: Date.now()
    })
  }

  handleUpdateState(client, data) {
    const player = this.state.players.get(client.sessionId)
    if (!player) return

    const { key, value } = data
    // Only allow specific keys to be updated by client
    if (['invisible', 'giant'].includes(key)) {
      player[key] = value
    }
  }

  handleStartGame(client) {
    // Check if this client is "host" (first to join)
    const keys = [...this.state.players.keys()]
    if (keys[0] !== client.sessionId) return

    this.resetGame()
    this.state.gamePhase = 'playing'

    // Start timer
    if (this.timerInterval) clearInterval(this.timerInterval)
    this.timerInterval = this.clock.setInterval(() => {
      if (this.state.gamePhase === 'playing') {
        this.state.timer--
        if (this.state.timer <= 0) {
          this.endGame()
        }
      }
    }, 1000)

    this.broadcast('game-started', {})
  }

  handleEndGame(client) {
    const keys = [...this.state.players.keys()]
    if (keys[0] !== client.sessionId) return

    this.endGame()
  }

  endGame() {
    this.state.gamePhase = 'ended'
    if (this.timerInterval) {
      this.timerInterval.clear()
      this.timerInterval = null
    }

    let winner = 'draw'
    if (this.state.redScore > this.state.blueScore) winner = 'red'
    else if (this.state.blueScore > this.state.redScore) winner = 'blue'

    this.broadcast('game-over', {
      winner,
      scores: { red: this.state.redScore, blue: this.state.blueScore }
    })

    // Reset positions after delay
    this.clock.setTimeout(() => {
      this.resetGame()
    }, 5000)
  }

  resetGame() {
    this.state.redScore = 0
    this.state.blueScore = 0
    this.state.timer = 300
    this.state.gamePhase = 'waiting'

    this.resetPositions()
    this.broadcast('game-reset', {})
  }

  resetPositions() {
    // Reset ball
    if (this.ballBody) {
      this.ballBody.setTranslation({ x: 0, y: 2, z: 0 }, true)
      this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
      this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
      this.state.ball.ownerSessionId = ''
      this.lastTouchSessionId = null
      this.secondLastTouchSessionId = null
    }

    // Reset player positions
    this.state.players.forEach((player, sessionId) => {
      const body = this.playerBodies.get(sessionId)
      if (body) {
        const spawnX = player.team === 'red' ? -6 : 6
        // Set flag for physics loop to handle
        player.resetPosition = true
        player.x = spawnX
        player.y = 0.1
        player.z = 0
        player.vx = 0
        player.vy = 0
        player.vz = 0
      }
    })
  }

  physicsUpdate(deltaTimeMs) {
    // Jitter Fix: Enforce fixed timestep for deterministic physics
    // We ignore the actual variable deltaTimeMs and assume a perfect 120Hz step
    // This matches the client's prediction loop exactly.
    const deltaTime = PHYSICS.FIXED_TIMESTEP
    this.currentTick++
    this.state.currentTick = this.currentTick

      // 1. Update players from Input Queue
      this.state.players.forEach((player, sessionId) => {
        const body = this.playerBodies.get(sessionId)
        if (!body) return

        // Initialize input queue if needed
        if (!player.inputQueue) player.inputQueue = []

        // Get next input from queue
        // We process ONE input per physics tick to match client rate (1:1)
        let input = player.inputQueue.shift()

        // If no input, use last known input (Prediction/Lag Compensation)
        // But we must be careful not to drift.
        // For now, just hold the last button state but zero out movement if queue is empty for too long?
        // No, standard is to repeat last input.
        if (!input) {
           input = player.lastInput || { x: 0, z: 0, jump: false, rotY: player.rotY }
        } else {
           player.lastInput = input
        }

        const x = input.x || 0
        const z = input.z || 0
        const jumpRequestId = input.jumpRequestId || 0
        const rotY = input.rotY || 0

        // Handle forced reset
        if (player.resetPosition) {
          const spawnX = player.team === 'red' ? -6 : 6
          body.setNextKinematicTranslation({ x: spawnX, y: 0.1, z: 0 })
          player.vx = 0
          player.vy = 0
          player.vz = 0
          player.resetPosition = false
          return // Skip physics for this frame
        }

        const speed = PHYSICS.MOVE_SPEED * (player.speedMult || 1)
        const currentPos = body.translation()

        // Check for power-up collection
        this.state.powerUps.forEach((p, id) => {
          const dx = currentPos.x - p.x
          const dz = currentPos.z - p.z
          const dist = Math.sqrt(dx * dx + dz * dz)
          
          if (dist < 1.5) {
            this.applyPowerUp(player, p.type)
            this.state.powerUps.delete(id)
            this.broadcast('powerup-collected', { sessionId, type: p.type })
          }
        })
      
      // Smooth horizontal velocity
      // Instant stop when no input, smooth otherwise
      player.vx = player.vx || 0
      player.vz = player.vz || 0
      
      if (x === 0 && z === 0) {
        // Instant stop to prevent sliding
        player.vx = 0
        player.vz = 0
      } else {
        const smoothing = PHYSICS.VELOCITY_SMOOTHING
        player.vx = player.vx + (x * speed - player.vx) * smoothing
        player.vz = player.vz + (z * speed - player.vz) * smoothing
      }


      let newX = currentPos.x + player.vx * deltaTime
      let newZ = currentPos.z + player.vz * deltaTime

      // Vertical movement
      player.vy = (player.vy || 0) - PHYSICS.GRAVITY * deltaTime

      if (currentPos.y <= PHYSICS.GROUND_Y + PHYSICS.GROUND_CHECK_EPSILON && player.vy <= 0) {
        player.jumpCount = 0
      }

      // Jump Request ID Logic: Only jump if we see a NEW request ID
      if (jumpRequestId > (player.lastProcessedJumpRequestId || 0) && player.jumpCount < PHYSICS.MAX_JUMPS) {
        const jumpForce = PHYSICS.JUMP_FORCE * (player.jumpMult || 1)
        player.vy = player.jumpCount === 0 ? jumpForce : jumpForce * PHYSICS.DOUBLE_JUMP_MULTIPLIER
        player.jumpCount++
        player.lastProcessedJumpRequestId = jumpRequestId
      }

      let newY = currentPos.y + player.vy * deltaTime
      if (newY < PHYSICS.GROUND_Y) {
        newY = PHYSICS.GROUND_Y
        player.vy = 0
        player.jumpCount = 0
      }

      // Bounds
      newX = Math.max(-PHYSICS.ARENA_HALF_WIDTH, Math.min(PHYSICS.ARENA_HALF_WIDTH, newX))
      newZ = Math.max(-PHYSICS.ARENA_HALF_DEPTH, Math.min(PHYSICS.ARENA_HALF_DEPTH, newZ))

      // Update physics body
      body.setNextKinematicTranslation({ x: newX, y: newY, z: newZ })

      // Update state for sync (rounded to 3 decimal places)
          // Update state for sync
      player.x = newX
      player.y = newY
      player.z = newZ
      player.rotY = rotY
      player.tick = this.currentTick

      
    })



    // 2. Step physics world
    this.world.step()

    // 2.5 Update Bots
    this.updateBots(deltaTime)

    // 3. Handle player-ball collisions with momentum transfer
    this.handlePlayerBallCollisions()

    // 4. EXPLICIT BALL BOUNDARY ENFORCEMENT (run before AND after goal check for redundancy)
    // This is a safety net to prevent ball from ever escaping the arena
    this.enforceBallBoundaries()

    // Check goal
    this.checkGoal()

    // Update ball state from physics
    if (this.ballBody) {
      const pos = this.ballBody.translation()
      const vel = this.ballBody.linvel()
      const rot = this.ballBody.rotation()

            this.state.ball.x = pos.x
      this.state.ball.y = pos.y
      this.state.ball.z = pos.z
      this.state.ball.vx = vel.x
      this.state.ball.vy = vel.y
      this.state.ball.vz = vel.z
      this.state.ball.rx = rot.x
      this.state.ball.ry = rot.y
      this.state.ball.rz = rot.z
      this.state.ball.rw = rot.w
      this.state.ball.tick = this.currentTick


      // Limit angular velocity
      const angvel = this.ballBody.angvel()
      const maxAv = 15.0
      const avSq = angvel.x ** 2 + angvel.y ** 2 + angvel.z ** 2
      if (avSq > maxAv ** 2) {
        const scale = maxAv / Math.sqrt(avSq)
        this.ballBody.setAngvel({ x: angvel.x * scale, y: angvel.y * scale, z: angvel.z * scale }, true)
      }
    }
  }

  // --- BOT LOGIC ---

  createBot(difficulty) {
    const id = `bot-${Date.now()}`
    const team = 'blue' // Bots are always blue (enemy) for now
    
    const player = new PlayerState()
    player.name = `Bot (${difficulty})`
    player.team = team
    player.character = 'car' // Bots use car model
    player.sessionId = id
    player.isBot = true
    
    // Bot stats based on difficulty
    player.difficulty = difficulty
    player.reactionDelay = difficulty === 'easy' ? 20 : (difficulty === 'medium' ? 10 : 0)
    player.moveSpeedMult = difficulty === 'easy' ? 0.6 : (difficulty === 'medium' ? 0.8 : 1.0)

    const spawn = this.createPlayerBody(id, team)
    player.x = spawn.x
    player.y = spawn.y
    player.z = spawn.z

    this.state.players.set(id, player)
    this.bots.set(id, { 
      targetX: 0, 
      targetZ: 0, 
      state: 'chase', // 'chase', 'kick', 'idle'
      lastActionTime: 0 
    })
  }

  updateBots(deltaTime) {
    if (!this.ballBody) return

    const ballPos = this.ballBody.translation()
    const ballVel = this.ballBody.linvel()

    this.bots.forEach((botData, botId) => {
      const player = this.state.players.get(botId)
      const body = this.playerBodies.get(botId)
      if (!player || !body) return

      const pos = body.translation()
      const difficulty = player.difficulty || 'medium'

      // --- AI DECISION MAKING ---

      // 1. Calculate Target Position
      let targetX = ballPos.x
      let targetZ = ballPos.z

      // Goal Targets (Bot is Blue, attacking Red goal at X = -17)
      const attackGoalX = -17
      const defendGoalX = 17

      if (difficulty === 'easy') {
        // Easy: Just chase the ball directly
        targetX = ballPos.x
        targetZ = ballPos.z
      } else if (difficulty === 'medium') {
        // Medium: Try to get slightly behind the ball to push it towards goal
        // Vector from ball to goal
        const dx = attackGoalX - ballPos.x
        const dz = 0 - ballPos.z // Center of goal
        const len = Math.sqrt(dx*dx + dz*dz)
        
        // Position 1m behind ball
        if (len > 0) {
          targetX = ballPos.x - (dx / len) * 1.0
          targetZ = ballPos.z - (dz / len) * 1.0
        }
      } else {
        // Hard: Predictive positioning & "Sweet Spot"
        // Predict ball position in 0.5s
        const predX = ballPos.x + ballVel.x * 0.5
        const predZ = ballPos.z + ballVel.z * 0.5
        
        // Vector from predicted ball to goal
        const dx = attackGoalX - predX
        const dz = 0 - predZ
        const len = Math.sqrt(dx*dx + dz*dz)

        // Sweet spot: 1.5m behind predicted ball position
        if (len > 0) {
          targetX = predX - (dx / len) * 1.5
          targetZ = predZ - (dz / len) * 1.5
        }

        // Defensive override: If ball is on our side (X > 0) and behind us, get between ball and goal
        if (ballPos.x > 5 && ballPos.x > pos.x) {
           targetX = ballPos.x + 2 // Stay between ball and our goal
           targetZ = ballPos.z * 0.5 // Shadow Z
        }
      }

      // 2. Move Logic
      const dx = targetX - pos.x
      const dz = targetZ - pos.z
      const distToTarget = Math.sqrt(dx*dx + dz*dz)
      
      let moveX = 0
      let moveZ = 0

      if (distToTarget > 0.5) {
        moveX = dx / distToTarget
        moveZ = dz / distToTarget
      }

      // Speed settings
      let speedMult = 0.6
      if (difficulty === 'medium') speedMult = 0.85
      if (difficulty === 'hard') speedMult = 1.1

      const speed = PHYSICS.MOVE_SPEED * speedMult
      
      // Smooth velocity
      const smoothing = PHYSICS.VELOCITY_SMOOTHING
      player.vx = (player.vx || 0) + (moveX * speed - (player.vx || 0)) * smoothing
      player.vz = (player.vz || 0) + (moveZ * speed - (player.vz || 0)) * smoothing

      // Update position
      let newX = pos.x + player.vx * deltaTime
      let newZ = pos.z + player.vz * deltaTime
      
      // Bounds
      newX = Math.max(-PHYSICS.ARENA_HALF_WIDTH, Math.min(PHYSICS.ARENA_HALF_WIDTH, newX))
      newZ = Math.max(-PHYSICS.ARENA_HALF_DEPTH, Math.min(PHYSICS.ARENA_HALF_DEPTH, newZ))

      body.setNextKinematicTranslation({ x: newX, y: pos.y, z: newZ })

      // Update state
      player.x = newX
      player.z = newZ
      player.rotY = Math.atan2(ballPos.x - pos.x, ballPos.z - pos.z) // Always look at ball

      // 3. Action Logic (Jump & Kick)
      const distToBall = Math.sqrt(Math.pow(ballPos.x - pos.x, 2) + Math.pow(ballPos.z - pos.z, 2))

      // Jump Logic
      if (difficulty !== 'easy') {
        // Jump if ball is high and close (Header)
        if (ballPos.y > 1.5 && ballPos.y < 4 && distToBall < 2.0 && player.jumpCount < 2) {
           // Simple jump simulation (server-side only for now, ideally needs physics impulse)
           // For kinematic body, we need to handle Y movement in physics loop or just trigger the flag
           // Here we'll just "cheat" and say if we are close and it's high, we hit it.
           // But properly, we should set a jump flag that the physics loop handles.
           // Let's reuse the jump logic in physics loop by simulating an input? 
           // Or just direct velocity manipulation since we are authoritative.
           
           // Only jump if not already jumping
           if (pos.y < 0.2) {
             player.vy = PHYSICS.JUMP_FORCE
             player.jumpCount = 1
           }
        }
      }

      // Kick Logic
      if (distToBall < 2.5 && Date.now() - botData.lastActionTime > (difficulty === 'hard' ? 500 : 1000)) {
        // Aiming
        let aimX = -1 // Towards Red Goal
        let aimZ = 0
        let power = 1.0

        if (difficulty === 'hard') {
           // Aim at goal corners
           aimZ = (Math.random() > 0.5 ? 2.5 : -2.5)
           power = 1.2
        } else if (difficulty === 'medium') {
           aimZ = (Math.random() - 0.5) * 2
        } else {
           aimZ = (Math.random() - 0.5) * 5 // Wild aiming
        }

        // Calculate impulse vector
        // Normalize aim direction
        const aimLen = Math.sqrt(aimX*aimX + aimZ*aimZ)
        const impX = (aimX / aimLen) * 15 * power
        const impZ = (aimZ / aimLen) * 15 * power
        const impY = 5 + (difficulty === 'hard' ? 2 : 0) // Higher arc for hard

        this.handleKick({ sessionId: botId }, {
          impulseX: impX,
          impulseY: impY,
          impulseZ: impZ
        })
        botData.lastActionTime = Date.now()
      }
      
      // Handle Gravity for Bot (since we manually set Y in physics loop usually, but here we need to update it)
      // Actually, the main physics loop handles gravity for ALL players in playerBodies.
      // We just need to ensure we don't overwrite Y with 0.1 constantly if jumping.
      // In the code above: body.setNextKinematicTranslation({ x: newX, y: pos.y, z: newZ })
      // pos.y comes from body.translation(), which is updated by physics loop?
      // Wait, the main loop iterates all players. We are in `updateBots` which is called AFTER step?
      // Or inside physicsUpdate?
      // It's called inside physicsUpdate.
      // The main loop does:
      // 1. Update players (velocity, gravity, bounds) -> sets next translation
      // 2. Step world
      // 3. Update Bots
      
      // If we setNextKinematicTranslation HERE, we override the main loop's gravity update for this frame?
      // Yes. We should integrate bot movement INTO the main loop or ensure we respect Y.
      // The main loop calculates `newY` with gravity.
      // We should probably just set `player.vx` and `player.vz` and let the main loop handle the integration?
      // BUT, the main loop iterates `this.state.players`. Bots ARE in `this.state.players`.
      // So the main loop IS processing them.
      // The main loop uses `player.inputQueue`. Bots don't have inputs.
      // So the main loop might just be applying gravity and friction?
      // Let's check the main loop.
      // It says: `if (!input) input = player.lastInput ...`
      // Bots don't have inputs. So they might be stuck repeating 0,0.
      
      // BETTER APPROACH:
      // Just set `player.vx` and `player.vz` here.
      // And let the main loop (next frame) or a second pass handle the integration?
      // Actually, `updateBots` is called at step 2.5.
      // If we set `player.vx/vz` here, they will be used in the NEXT frame's main loop.
      // That is fine.
      // BUT, we also want to turn them.
      // And we want to ensure they don't just stop.
      
      // Let's just update the velocities here and let the main loop handle the physics integration in the next tick.
      // That ensures gravity and collisions work consistently.
      // We just need to ensure the main loop doesn't overwrite our velocities with "no input" 0s.
      // In main loop: `if (x === 0 && z === 0) { player.vx = 0 ... }`
      // We need to simulate "Input" for the bot.
      
      // REVISION:
      // Instead of manually setting position, let's generate a "fake input" for the bot
      // and push it to `player.inputQueue`.
      // This is the cleanest way to integrate with existing physics.
      
      const input = {
        tick: this.currentTick + 1,
        x: moveX, // Normalized direction
        z: moveZ,
        rotY: Math.atan2(ballPos.x - pos.x, ballPos.z - pos.z),
        jump: false // We handle jump via direct velocity or separate flag
      }
      
      // Push to queue
      if (!player.inputQueue) player.inputQueue = []
      player.inputQueue.push(input)
      
      // Handle Jump (Direct velocity set is easier for now as input doesn't support "trigger" well without state)
      if (difficulty !== 'easy' && ballPos.y > 1.5 && ballPos.y < 4 && distToBall < 2.0 && player.jumpCount < 2 && pos.y < 0.2) {
         player.vy = PHYSICS.JUMP_FORCE
         player.jumpCount = 1
      }
      
    })
  }

  checkGoal() {
    if (!this.ballBody) return
    if (Date.now() - this.lastGoalTime < GOAL_COOLDOWN) return

    const pos = this.ballBody.translation()

    // Goal detection: Ball fully past goal line and within posts
    // We check if X is past the line + radius (fully in)
    // And Z is within the goal width (minus a small margin to avoid post collisions triggering)
    const goalLineX = PHYSICS.GOAL_LINE_X
    const goalZ = PHYSICS.GOAL_WIDTH / 2
    
    if (Math.abs(pos.x) > goalLineX + PHYSICS.BALL_RADIUS && 
        Math.abs(pos.z) < goalZ && 
        pos.y < PHYSICS.GOAL_HEIGHT) {
      this.lastGoalTime = Date.now()

      const scoringTeam = pos.x > 0 ? 'red' : 'blue'
      if (scoringTeam === 'red') {
        this.state.redScore++
      } else {
        this.state.blueScore++
      }

      this.broadcast('goal-scored', { team: scoringTeam })

      // Award goal and assist
      if (this.lastTouchSessionId) {
        const scorer = this.state.players.get(this.lastTouchSessionId)
        if (scorer) {
          scorer.goals++
          
          // Award assist if the second last touch was from a teammate
          if (this.secondLastTouchSessionId) {
            const assistant = this.state.players.get(this.secondLastTouchSessionId)
            if (assistant && assistant.team === scorer.team && assistant.sessionId !== scorer.sessionId) {
              assistant.assists++
            }
          }
        }
      }

      // Reset positions after delay
      this.clock.setTimeout(() => {
        this.resetPositions()
        this.broadcast('game-reset', {})
      }, 3000)
    }
  }



  handlePlayerBallCollisions() {
    if (!this.ballBody) return

    const ballPos = this.ballBody.translation()
    const ballVel = this.ballBody.linvel()
    const ballRadius = PHYSICS.BALL_RADIUS

    this.state.players.forEach((player, sessionId) => {
      const body = this.playerBodies.get(sessionId)
      if (!body) return

      const playerPos = body.translation()
      const playerRadius = player.giant ? 2.0 : PHYSICS.PLAYER_RADIUS
      const combinedRadius = ballRadius + playerRadius

      const dx = ballPos.x - playerPos.x
      const dy = ballPos.y - playerPos.y
      const dz = ballPos.z - playerPos.z
      const distSq = dx * dx + dy * dy + dz * dz

      // Check for collision
      if (distSq < combinedRadius * combinedRadius) {
        const dist = Math.sqrt(distSq)
        const nx = dx / (dist || 0.1)
        const ny = dy / (dist || 0.1)
        const nz = dz / (dist || 0.1)

        // Relative velocity
        const relVx = (player.vx || 0) - ballVel.x
        const relVy = (player.vy || 0) - ballVel.y
        const relVz = (player.vz || 0) - ballVel.z
        const relSpeed = Math.sqrt(relVx * relVx + relVy * relVy + relVz * relVz)

        // Approach speed (dot product of relative velocity and normal)
        const approachSpeed = relVx * nx + relVy * ny + relVz * nz

        // Check for ball stability mode (ball resting on top of player)
        const isOnHead = dy > PHYSICS.BALL_STABILITY_HEIGHT_MIN && ny > 0.5
        const isLowVelocity = relSpeed < PHYSICS.BALL_STABILITY_VELOCITY_THRESHOLD
        const playerSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vz || 0) ** 2)
        const isStationary = playerSpeed < 0.5

        if (isOnHead && isLowVelocity && isStationary) {
          // STABILITY MODE: Ball is resting on player's head
          // Apply damping instead of impulse to keep ball stable
          const dampedVx = ballVel.x * PHYSICS.BALL_STABILITY_DAMPING
          const dampedVy = ballVel.y * PHYSICS.BALL_STABILITY_DAMPING
          const dampedVz = ballVel.z * PHYSICS.BALL_STABILITY_DAMPING
          
          this.ballBody.setLinvel({ x: dampedVx, y: dampedVy, z: dampedVz }, true)
          
          // Gently push ball up to prevent sinking through player
          const penetration = combinedRadius - dist
          if (penetration > 0.01) {
            const correction = {
              x: ballPos.x + nx * penetration * 0.5,
              y: ballPos.y + ny * penetration * 0.5,
              z: ballPos.z + nz * penetration * 0.5
            }
            this.ballBody.setTranslation(correction, true)
          }
          
          // Set ball ownership
          this.state.ball.ownerSessionId = sessionId
          return // Skip normal impulse logic
        }

        // Only apply impulse if player is moving toward the ball
        if (approachSpeed > 0) {
          const isRunning = playerSpeed > PHYSICS.COLLISION_VELOCITY_THRESHOLD

          // Momentum transfer calculation
          const momentumFactor = isRunning ? 
            (playerSpeed / 8) * PHYSICS.PLAYER_BALL_VELOCITY_TRANSFER : 0.5
          
          // Approach boost for head-on collisions
          const approachDot = ((player.vx || 0) * nx + (player.vz || 0) * nz) / (playerSpeed + 0.001)
          const approachBoost = approachDot > 0.5 ? PHYSICS.PLAYER_BALL_APPROACH_BOOST : 1.0

          // Calculate impulse magnitude
          let impulseMag = approachSpeed * PHYSICS.BALL_MASS * (1 + PHYSICS.PLAYER_BALL_RESTITUTION) * momentumFactor * approachBoost
          
          // If ball is on head but player is moving, cap impulse to prevent launching
          if (isOnHead) {
            impulseMag = Math.min(impulseMag, PHYSICS.BALL_STABILITY_IMPULSE_CAP * playerSpeed)
          } else {
            // Ensure a minimum impulse for responsiveness (only for non-head collisions)
            impulseMag = Math.max(PHYSICS.PLAYER_BALL_IMPULSE_MIN, impulseMag)
          }

          // Apply impulse to ball
          const lift = player.giant ? PHYSICS.COLLISION_LIFT_GIANT : PHYSICS.COLLISION_LIFT
          const impulse = {
            x: nx * impulseMag,
            y: Math.max(0.5, ny * impulseMag) + lift, // Add some lift
            z: nz * impulseMag
          }

          this.ballBody.applyImpulse(impulse, true)

          // Broadcast touch event for client prediction sync
          this.broadcast('ball-touched', {
            playerId: sessionId,
            velocity: this.ballBody.linvel(),
            position: this.ballBody.translation()
          })

          // Update touch history
          if (this.lastTouchSessionId !== sessionId) {
            this.secondLastTouchSessionId = this.lastTouchSessionId
            this.lastTouchSessionId = sessionId
          }
          
          // Set ball ownership
          this.state.ball.ownerSessionId = sessionId
        }
      }
    })
  }

  applyPowerUp(player, type) {
    const duration = this.POWER_UP_TYPES[type].duration
    
    if (type === 'speed') {
      // Smooth speed ramp-up over 0.5 seconds (500ms)
      const targetSpeed = 2
      const rampUpTime = 500
      const rampDownTime = 1000
      const rampUpSteps = 10
      const rampDownSteps = 20
      
      // Ramp up
      let currentStep = 0
      const rampUpInterval = this.clock.setInterval(() => {
        currentStep++
        player.speedMult = 1 + (targetSpeed - 1) * (currentStep / rampUpSteps)
        if (currentStep >= rampUpSteps) {
          player.speedMult = targetSpeed
          rampUpInterval.clear()
        }
      }, rampUpTime / rampUpSteps)
      
      // Schedule ramp down near end of duration
      this.clock.setTimeout(() => {
        let downStep = 0
        const rampDownInterval = this.clock.setInterval(() => {
          downStep++
          player.speedMult = targetSpeed - (targetSpeed - 1) * (downStep / rampDownSteps)
          if (downStep >= rampDownSteps) {
            player.speedMult = 1
            rampDownInterval.clear()
          }
        }, rampDownTime / rampDownSteps)
      }, duration - rampDownTime)
    } else if (type === 'jump') {
      player.jumpMult = 1.5
      this.clock.setTimeout(() => player.jumpMult = 1, duration)
    } else if (type === 'kick') {
      player.kickMult = 2
      this.clock.setTimeout(() => player.kickMult = 1, duration)
    } else if (type === 'invisible') {
      player.invisible = true
      this.clock.setTimeout(() => player.invisible = false, duration)
    } else if (type === 'giant') {
      player.giant = true
      
      // Handle physics body change for giant
      const body = this.playerBodies.get(player.sessionId)
      if (body) {
        // Remove existing collider (index 0)
        if (body.numColliders() > 0) {
          const collider = body.collider(0)
          this.world.removeCollider(collider, false)
        }

        // Create GIANT collider (Sphere Radius 2.0 - matches client's 5x scale)
        const giantCollider = RAPIER.ColliderDesc.ball(2.0)
          .setTranslation(0, 2.0, 0) // Shift up so it doesn't clip ground
          .setFriction(2.0)
          .setRestitution(0.0)
        
        // SAFETY: Push ball away if it's too close to prevent crushing
        if (this.ballBody) {
          const ballPos = this.ballBody.translation()
          const playerPos = body.translation()
          const dx = ballPos.x - playerPos.x
          const dz = ballPos.z - playerPos.z
          const dist = Math.sqrt(dx * dx + dz * dz)
          
          // If ball is within the new giant radius (2.0) + ball radius (0.8) + buffer
          if (dist < 3.5) {
            // Calculate push direction
            let pushX = dx
            let pushZ = dz
            if (dist < 0.1) { pushX = 1; pushZ = 0 } // Handle perfect overlap
            
            // Normalize
            const len = Math.sqrt(pushX * pushX + pushZ * pushZ)
            pushX /= len
            pushZ /= len
            
            // Teleport ball to safety (4.0m away)
            const safeX = playerPos.x + pushX * 4.0
            const safeZ = playerPos.z + pushZ * 4.0
            
            // Wake up and move
            this.ballBody.setTranslation({ x: safeX, y: 2, z: safeZ }, true)
            this.ballBody.setLinvel({ x: pushX * 10, y: 5, z: pushZ * 10 }, true)
          }
        }

        this.world.createCollider(giantCollider, body)
      }

      this.clock.setTimeout(() => {
        player.giant = false
        
        // Restore normal collider
        const body = this.playerBodies.get(player.sessionId)
        if (body) {
          if (body.numColliders() > 0) {
            const collider = body.collider(0)
            this.world.removeCollider(collider, false)
          }

          const normalCollider = RAPIER.ColliderDesc.cuboid(PHYSICS.PLAYER_RADIUS, 0.2, PHYSICS.PLAYER_RADIUS)
            .setTranslation(0, 0.2, 0)
            .setFriction(2.0)
            .setRestitution(0.0)
          
          this.world.createCollider(normalCollider, body)
        }
      }, duration)
    }
  }

  // COMPREHENSIVE BALL BOUNDARY ENFORCEMENT
  // Ensures ball can NEVER escape the arena or goal net area
  enforceBallBoundaries() {
    if (!this.ballBody) return

    const pos = this.ballBody.translation()
    const vel = this.ballBody.linvel()
    const ballR = PHYSICS.BALL_RADIUS
    let needsCorrection = false
    let correctedPos = { x: pos.x, y: pos.y, z: pos.z }
    let correctedVel = { x: vel.x, y: vel.y, z: vel.z }

    // Boundary constants
    const ARENA_HALF_WIDTH = PHYSICS.ARENA_HALF_WIDTH  // 14.5
    const ARENA_HALF_DEPTH = PHYSICS.ARENA_HALF_DEPTH  // 9.5
    const GOAL_POST_Z = 2.5  // Goal posts at z = ±2.5
    const GOAL_LINE_X = PHYSICS.GOAL_LINE_X  // 10.8
    const GOAL_BACK_X = 17.0  // Back of goal net
    const GOAL_HEIGHT = PHYSICS.GOAL_HEIGHT  // 4.0
    const WALL_HEIGHT = PHYSICS.WALL_HEIGHT  // 10

    // Effective boundaries (accounting for ball radius)
    const maxX = ARENA_HALF_WIDTH - ballR
    const maxZ = ARENA_HALF_DEPTH - ballR

    // Zone detection - more robust
    const absX = Math.abs(pos.x)
    const absZ = Math.abs(pos.z)
    
    // Is the ball past the goal line (inside goal area)?
    const isPastGoalLine = absX > GOAL_LINE_X
    // Is the ball DEEP in the goal net (past the arena wall)?
    const isDeepInGoal = absX > ARENA_HALF_WIDTH
    // Is the ball within the goal opening (between the posts)?
    const isInGoalOpening = absZ < GOAL_POST_Z && pos.y < GOAL_HEIGHT && isPastGoalLine

    // === Z AXIS ENFORCEMENT ===
    if (isDeepInGoal) {
      // Ball is deep in the goal extension (x > 14.5)
      // Check if it's actually inside the net width
      const goalSideLimit = GOAL_POST_Z - ballR
      
      if (Math.abs(pos.z) > goalSideLimit) {
        // Ball is deep in X but OUTSIDE the net in Z.
        // This means it has penetrated the arena back wall (at x=14.5).
        // Instead of clamping Z (which sucks it into the net), we clamp X back to the arena.
        correctedPos.x = (pos.x > 0 ? maxX : -maxX)
        correctedVel.x = -Math.abs(vel.x) * PHYSICS.WALL_RESTITUTION
        needsCorrection = true
      } else {
        // Ball is inside the net width - enforce side walls
        if (pos.z > goalSideLimit) {
          correctedPos.z = goalSideLimit
          correctedVel.z = -Math.abs(vel.z) * PHYSICS.GOAL_RESTITUTION
          needsCorrection = true
        } else if (pos.z < -goalSideLimit) {
          correctedPos.z = -goalSideLimit
          correctedVel.z = Math.abs(vel.z) * PHYSICS.GOAL_RESTITUTION
          needsCorrection = true
        }
      }
    } else {
      // Ball is in main arena (or corner) - enforce arena walls
      if (pos.z > maxZ) {
        correctedPos.z = maxZ
        correctedVel.z = -Math.abs(vel.z) * PHYSICS.WALL_RESTITUTION
        needsCorrection = true
      } else if (pos.z < -maxZ) {
        correctedPos.z = -maxZ
        correctedVel.z = Math.abs(vel.z) * PHYSICS.WALL_RESTITUTION
        needsCorrection = true
      }
    }

    // === X AXIS ENFORCEMENT ===
    if (isInGoalOpening || isDeepInGoal) {
      // Ball is allowed in goal area, but clamp to goal back wall
      const goalBackLimit = GOAL_BACK_X - ballR
      if (pos.x > goalBackLimit) {
        correctedPos.x = goalBackLimit
        correctedVel.x = -Math.abs(vel.x) * PHYSICS.GOAL_RESTITUTION
        needsCorrection = true
      } else if (pos.x < -goalBackLimit) {
        correctedPos.x = -goalBackLimit
        correctedVel.x = Math.abs(vel.x) * PHYSICS.GOAL_RESTITUTION
        needsCorrection = true
      }
    } else {
      // Ball is in main arena - enforce arena walls
      if (pos.x > maxX) {
        correctedPos.x = maxX
        correctedVel.x = -Math.abs(vel.x) * PHYSICS.WALL_RESTITUTION
        needsCorrection = true
      } else if (pos.x < -maxX) {
        correctedPos.x = -maxX
        correctedVel.x = Math.abs(vel.x) * PHYSICS.WALL_RESTITUTION
        needsCorrection = true
      }
    }

    // === Y AXIS ENFORCEMENT (floor and ceiling) ===
    if (pos.y < ballR) {
      correctedPos.y = ballR
      correctedVel.y = Math.abs(vel.y) * PHYSICS.GROUND_RESTITUTION
      needsCorrection = true
    } else if (pos.y > WALL_HEIGHT - ballR) {
      correctedPos.y = WALL_HEIGHT - ballR
      correctedVel.y = -Math.abs(vel.y) * 0.1
      needsCorrection = true
    }

    // Apply corrections
    if (needsCorrection) {
      this.ballBody.setTranslation(correctedPos, true)
      this.ballBody.setLinvel(correctedVel, true)
    }
  }


  onDispose() {
    console.log('SoccerRoom disposed')
    if (this.timerInterval) this.timerInterval.clear()
    if (this.powerUpInterval) this.powerUpInterval.clear()
  }
}
