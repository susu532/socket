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
    
    // Set patch rate to 60Hz (16ms) for smoother updates with 120Hz physics
    this.setPatchRate(16)

    this.roomCreatedAt = Date.now()

    this.isPublic = options?.isPublic !== false
    this.setPrivate(!this.isPublic)

    if (!this.isPublic) {
      const requestedCode = options?.code ? String(options.code).trim().toUpperCase() : null
      this.privateCode = requestedCode || this.generateUniqueJoinCode()
      registerPrivateRoom(this.roomId, this.privateCode)
    }

    this.setMetadata({
      isPublic: this.isPublic,
      map: options?.map || this.state.selectedMap || null,
      createdAt: this.roomCreatedAt,
      redCount: 0,
      blueCount: 0
    })

    // Set map from options if provided (Host's choice)
    if (options.map) {
      this.state.selectedMap = options.map
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
    const pitchWidth = 30
    const pitchDepth = 20
    const wallHeight = 10
    const wallThickness = 2

    // Ground
    const groundDesc = RAPIER.ColliderDesc.cuboid(PHYSICS.ARENA_WIDTH / 2, 0.25, PHYSICS.ARENA_DEPTH / 2)
      .setTranslation(0, -0.25, 0)
      .setFriction(2.0)
      .setRestitution(0.7)
    this.world.createCollider(groundDesc)

    // Back walls (Z axis)
    const backWall1 = RAPIER.ColliderDesc.cuboid((pitchWidth + wallThickness * 2) / 2, wallHeight / 2, wallThickness / 2)
      .setTranslation(0, wallHeight / 2, -pitchDepth / 2 - wallThickness / 2)
      .setRestitution(0.8)
    this.world.createCollider(backWall1)

    const backWall2 = RAPIER.ColliderDesc.cuboid((pitchWidth + wallThickness * 2) / 2, wallHeight / 2, wallThickness / 2)
      .setTranslation(0, wallHeight / 2, pitchDepth / 2 + wallThickness / 2)
      .setRestitution(0.8)
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
        .setRestitution(0.8)
      this.world.createCollider(desc)
    })

    // Goal back walls (The "Net" back)
    // Matching "big wall" thickness (2m) and height (10m)
    const goalBackWallPositions = [[-17.2, 0], [17.2, 0]]
    goalBackWallPositions.forEach(([x, z]) => {
      // halfX=1 (2m thick), halfY=5 (10m high), halfZ=5 (10m wide to overlap sides)
      const desc = RAPIER.ColliderDesc.cuboid(1, 5, 5)
        .setTranslation(x, 5, z)
        .setRestitution(1.2)
      this.world.createCollider(desc)
    })

    // Goal posts (approximated as boxes)
    const postPositions = [
      [-10.8, -2.5], [-10.8, 2.5], [10.8, -2.5], [10.8, 2.5]
    ]
    postPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cylinder(2, 0.06)
        .setTranslation(x, 2, z)
        .setRestitution(0.8)
      this.world.createCollider(desc)
    })

    // Crossbars
    const crossbarPositions = [[-10.8, 0], [10.8, 0]]
    crossbarPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cylinder(3, 0.02)
        .setTranslation(x, 4, z)
        .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) })
        .setRestitution(0.8)
      this.world.createCollider(desc)
    })

    // Ceiling
    const ceiling = RAPIER.ColliderDesc.cuboid(pitchWidth / 2, 0.1, pitchDepth / 2)
      .setTranslation(0, wallHeight, 0)
      .setRestitution(0.8)
    this.world.createCollider(ceiling)

    // Goal side barriers (The "Net" sides)
    // Matching "big wall" thickness (2m) and height (10m)
    // Depth: 5m (from 11.2 to 16.2), Center: 13.7, halfX: 2.5
    // Position Z: Opening is 6m (+/- 3), Wall center: 3 + 1 = 4
    const barrierPositions = [
      [13.7, -3.5], [-13.7, -3.5], [13.7, 3.5], [-13.7, 3.5]
    ]
    barrierPositions.forEach(([x, z]) => {
      // halfX=2.5 (5m deep), halfY=5 (10m high), halfZ=1 (2m thick)
      const desc = RAPIER.ColliderDesc.cuboid(2.5, 5, 1)
        .setTranslation(x, 5, z)
        .setRestitution(1.2)
      this.world.createCollider(desc)
    })

    // Goal area blockers
    const blockerPositions = [[-10.8, 0], [10.8, 0]]
    blockerPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cuboid(2.5, 4.5, 2.75)
        .setTranslation(x, 8.7, z)
        .setRestitution(1.2)
      this.world.createCollider(desc)
    })
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

    const collider = RAPIER.ColliderDesc.cuboid(PHYSICS.PLAYER_RADIUS, 0.2, PHYSICS.PLAYER_RADIUS)
      .setTranslation(0, 0.2, 0)
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

    // Handle batched inputs
    if (data.inputs && Array.isArray(data.inputs)) {
      data.inputs.forEach(input => {
        // Optional: Deduplicate based on tick/sequence if needed
        // For now, we trust the client to send ordered batches
        player.inputQueue.push(input)
      })
      
      // Safety: Cap queue size to prevent memory leaks or speed hacks
      if (player.inputQueue.length > 60) {
        player.inputQueue = player.inputQueue.slice(-60)
      }
    } else {
      // Legacy/Single input fallback
      player.inputQueue.push(data)
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
        y: impulseY + 0.8 * kickMult, // Add base vertical boost scaled by power
        z: impulseZ 
      }, true)

      // Broadcast kick visual to all clients with impulse for prediction
      this.broadcast('ball-kicked', { 
        playerId: client.sessionId,
        impulse: { 
          x: impulseX, 
          y: impulseY + 0.8 * kickMult, // Visual boost scaled
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
        const jump = input.jump || false
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
      // Direct velocity (snappy movement)
           player.vx = player.vx || 0
      player.vz = player.vz || 0
      player.vx = player.vx + (x * speed - player.vx) * 0.3
      player.vz = player.vz + (z * speed - player.vz) * 0.3


      let newX = currentPos.x + player.vx * deltaTime
      let newZ = currentPos.z + player.vz * deltaTime

      // Vertical movement
      player.vy = (player.vy || 0) - PHYSICS.GRAVITY * deltaTime

      if (currentPos.y <= PHYSICS.GROUND_Y + 0.05 && player.vy <= 0) {
        player.jumpCount = 0
      }

      if (jump && !player.prevJump && player.jumpCount < PHYSICS.MAX_JUMPS) {
        const jumpForce = PHYSICS.JUMP_FORCE * (player.jumpMult || 1)
        player.vy = player.jumpCount === 0 ? jumpForce : jumpForce * PHYSICS.DOUBLE_JUMP_MULTIPLIER
        player.jumpCount++
      }
      player.prevJump = jump

      let newY = currentPos.y + player.vy * deltaTime
      if (newY < PHYSICS.GROUND_Y) {
        newY = PHYSICS.GROUND_Y
        player.vy = 0
        player.jumpCount = 0
      }

      // Bounds
      newX = Math.max(-PHYSICS.ARENA_HALF_WIDTH - 0.2, Math.min(PHYSICS.ARENA_HALF_WIDTH + 0.2, newX))
      newZ = Math.max(-PHYSICS.ARENA_HALF_DEPTH - 0.2, Math.min(PHYSICS.ARENA_HALF_DEPTH + 0.2, newZ))

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



  applyPowerUp(player, type) {
    const duration = this.POWER_UP_TYPES[type].duration
    
    if (type === 'speed') {
      player.speedMult = 2
      this.clock.setTimeout(() => player.speedMult = 1, duration)
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

        // Create GIANT collider (Radius 2.0 - matches client's 5x scale)
        // Was 3.0, which was too big and caused mismatches
        const giantCollider = RAPIER.ColliderDesc.cuboid(2.0, 2.0, 2.0)
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

  onDispose() {
    console.log('SoccerRoom disposed')
    if (this.timerInterval) this.timerInterval.clear()
    if (this.powerUpInterval) this.powerUpInterval.clear()
  }
}
