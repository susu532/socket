import { Room } from 'colyseus'
import RAPIER from '@dimforge/rapier3d-compat'
import { GameState, PlayerState, PowerUpState } from '../schema/GameState.js'
import { registerPrivateRoom, unregisterRoom, getRoomIdByCode } from '../roomRegistry.js'

const PHYSICS_TICK_RATE = 1000 / 120 // 120Hz for high-precision physics
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
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })

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
    const groundDesc = RAPIER.ColliderDesc.cuboid(pitchWidth / 2, 0.25, pitchDepth / 2)
      .setTranslation(0, -0.25, 0)
      .setFriction(2.0)
    this.world.createCollider(groundDesc)

    // Back walls (Z axis)
    const backWall1 = RAPIER.ColliderDesc.cuboid((pitchWidth + wallThickness * 2) / 2, wallHeight / 2, wallThickness / 2)
      .setTranslation(0, wallHeight / 2, -pitchDepth / 2 - wallThickness / 2)
    this.world.createCollider(backWall1)

    const backWall2 = RAPIER.ColliderDesc.cuboid((pitchWidth + wallThickness * 2) / 2, wallHeight / 2, wallThickness / 2)
      .setTranslation(0, wallHeight / 2, pitchDepth / 2 + wallThickness / 2)
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
      const desc = RAPIER.ColliderDesc.cylinder(3, 0.04)
        .setTranslation(x, 4, z)
        .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) })
        .setRestitution(0.8)
      this.world.createCollider(desc)
    })

    // Ceiling
    const ceiling = RAPIER.ColliderDesc.cuboid(pitchWidth / 2, 0.1, pitchDepth / 2)
      .setTranslation(0, wallHeight, 0)
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
      .setLinearDamping(1.5)
      .setAngularDamping(1.5)

    this.ballBody = this.world.createRigidBody(ballBodyDesc)

    const ballCollider = RAPIER.ColliderDesc.ball(0.8)
      .setMass(3.0)
      .setRestitution(0.75)
      .setFriction(0.5)

    this.world.createCollider(ballCollider, this.ballBody)
  }

  createPlayerBody(sessionId, team) {
    const spawnX = team === 'red' ? -6 : 6
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spawnX, 0.1, 0)

    const body = this.world.createRigidBody(bodyDesc)

    // Bowl-shaped compound collider
    // Center platform (flat top)
    const center = RAPIER.ColliderDesc.cuboid(0.4, 0.1, 0.4)
      .setTranslation(0, 0.5, 0)
      .setFriction(1.5)
      .setRestitution(0.0)

    // Slopes to form the bowl
    const frontSlope = RAPIER.ColliderDesc.cuboid(0.4, 0.15, 0.2)
      .setTranslation(0, 0.4, 0.5)
      .setRotation({ x: Math.sin(-15 * Math.PI / 180 / 2), y: 0, z: 0, w: Math.cos(-15 * Math.PI / 180 / 2) }) // Tilt backward
      .setFriction(0.3)
      .setRestitution(0.4)

    const backSlope = RAPIER.ColliderDesc.cuboid(0.4, 0.15, 0.2)
      .setTranslation(0, 0.4, -0.5)
      .setRotation({ x: Math.sin(15 * Math.PI / 180 / 2), y: 0, z: 0, w: Math.cos(15 * Math.PI / 180 / 2) }) // Tilt forward
      .setFriction(0.3)
      .setRestitution(0.4)

    const leftSlope = RAPIER.ColliderDesc.cuboid(0.2, 0.15, 0.4)
      .setTranslation(-0.5, 0.4, 0)
      .setRotation({ x: 0, y: 0, z: Math.sin(15 * Math.PI / 180 / 2), w: Math.cos(15 * Math.PI / 180 / 2) }) // Tilt right
      .setFriction(0.3)
      .setRestitution(0.4)

    const rightSlope = RAPIER.ColliderDesc.cuboid(0.2, 0.15, 0.4)
      .setTranslation(0.5, 0.4, 0)
      .setRotation({ x: 0, y: 0, z: Math.sin(-15 * Math.PI / 180 / 2), w: Math.cos(-15 * Math.PI / 180 / 2) }) // Tilt left
      .setFriction(0.3)
      .setRestitution(0.4)

    this.world.createCollider(center, body)
    this.world.createCollider(frontSlope, body)
    this.world.createCollider(backSlope, body)
    this.world.createCollider(leftSlope, body)
    this.world.createCollider(rightSlope, body)
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

    // Store input for the physics loop
    player.inputX = data.x || 0
    player.inputZ = data.z || 0
    player.inputJump = data.jump || false
    player.inputRotY = data.rotY || 0
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

    if (dist < 0.7) {
      const { impulseX, impulseY, impulseZ } = data
      const kickMult = player.kickMult || 1

      // Apply impulse with a slight vertical boost for better feel
      // Note: impulse is already scaled by kickMult from client
      this.ballBody.applyImpulse({ 
        x: impulseX, 
        y: impulseY + 2.5 * kickMult, // Add base vertical boost scaled by power
        z: impulseZ 
      }, true)

      // Broadcast kick visual to all clients with impulse for prediction
      this.broadcast('ball-kicked', { 
        playerId: client.sessionId,
        impulse: { 
          x: impulseX, 
          y: impulseY + 2.5 * kickMult, // Visual boost scaled
          z: impulseZ 
        }
      })
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
    const deltaTime = deltaTimeMs / 1000
    // 1. Update players from stored inputs
    this.state.players.forEach((player, sessionId) => {
      const body = this.playerBodies.get(sessionId)
      if (!body) return

      const x = player.inputX || 0
      const z = player.inputZ || 0
      const jump = player.inputJump || false
      const rotY = player.inputRotY || 0

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

      const speed = 8 * (player.speedMult || 1)
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
      const GRAVITY = 20
      const JUMP_FORCE = 8
      const GROUND_Y = 0.1
      const MAX_JUMPS = 2
      const DOUBLE_JUMP_MULTIPLIER = 0.8

      player.vy = (player.vy || 0) - GRAVITY * deltaTime

      if (currentPos.y <= GROUND_Y + 0.05 && player.vy <= 0) {
        player.jumpCount = 0
      }

      if (jump && !player.prevJump && player.jumpCount < MAX_JUMPS) {
        const jumpForce = JUMP_FORCE * (player.jumpMult || 1)
        player.vy = player.jumpCount === 0 ? jumpForce : jumpForce * DOUBLE_JUMP_MULTIPLIER
        player.jumpCount++
      }
      player.prevJump = jump

      let newY = currentPos.y + player.vy * deltaTime
      if (newY < GROUND_Y) {
        newY = GROUND_Y
        player.vy = 0
        player.jumpCount = 0
      }

      // Bounds
      newX = Math.max(-14.7, Math.min(14.7, newX))
      newZ = Math.max(-9.7, Math.min(9.7, newZ))

      // Update physics body
      body.setNextKinematicTranslation({ x: newX, y: newY, z: newZ })

      // Update state for sync (rounded to 3 decimal places)
          // Update state for sync
      player.x = newX
      player.y = newY
      player.z = newZ
      player.rotY = rotY

      
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


      // Limit angular velocity
      const angvel = this.ballBody.angvel()
      const maxAv = 15.0
      const avSq = angvel.x ** 2 + angvel.y ** 2 + angvel.z ** 2
      if (avSq > maxAv ** 2) {
        const scale = maxAv / Math.sqrt(avSq)
        this.ballBody.setAngvel({ x: angvel.x * scale, y: angvel.y * scale, z: angvel.z * scale }, true)
      }
    }

    // Stabilize ball on player roof
    this.stabilizeBallOnPlayer(deltaTime)
  }

  stabilizeBallOnPlayer(deltaTime) {
    this.state.players.forEach((player, sessionId) => {
      const body = this.playerBodies.get(sessionId)
      if (!body || !this.ballBody) return

      const playerPos = body.translation()
      const ballPos = this.ballBody.translation()

      // Calculate horizontal distance
      const dx = ballPos.x - playerPos.x
      const dz = ballPos.z - playerPos.z
      const hDist = Math.sqrt(dx * dx + dz * dz)
      
      // Calculate vertical distance
      const dy = ballPos.y - playerPos.y

      // Check if ball is "on roof"
      // Horizontal < 1.2 (slightly larger than bowl radius)
      // Vertical between 0.6 (just above head) and 1.5 (max control height)
      if (hDist < 1.2 && dy > 0.6 && dy < 1.5) {
        const ballVel = this.ballBody.linvel()
        const playerVel = body.linvel() // Kinematic bodies have velocity

        const relVx = ballVel.x - playerVel.x
        const relVz = ballVel.z - playerVel.z

        // Forces
        // 1. Damping: oppose relative velocity
        const dampX = relVx * -0.4
        const dampZ = relVz * -0.4

        // 2. Velocity Transfer: add player velocity
        const transX = playerVel.x * 0.6
        const transZ = playerVel.z * 0.6

        // 3. Centering: spring force
        const centerX = -dx * 8.0
        const centerZ = -dz * 8.0

        // Apply forces as impulse (Force * deltaTime)
        this.ballBody.applyImpulse({
          x: (dampX + transX + centerX) * deltaTime,
          y: 0,
          z: (dampZ + transZ + centerZ) * deltaTime
        }, true)
      }
    })
  }

  checkGoal() {
    if (!this.ballBody) return
    if (Date.now() - this.lastGoalTime < GOAL_COOLDOWN) return

    const pos = this.ballBody.translation()

    // Goal detection: |x| > 11.3 && |z| < 2.3 && y < 4
    if (Math.abs(pos.x) > 11.3 && Math.abs(pos.z) < 2.3 && pos.y < 4) {
      this.lastGoalTime = Date.now()

      const scoringTeam = pos.x > 0 ? 'red' : 'blue'
      if (scoringTeam === 'red') {
        this.state.redScore++
      } else {
        this.state.blueScore++
      }

      this.broadcast('goal-scored', { team: scoringTeam })

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

        // Create GIANT collider (Radius 6.0 requested -> 6.0 half-extent)
        // Normal is 0.6, so this is 10x bigger
        // Create GIANT collider (Radius 6.0 requested -> 6.0 half-extent)
        // Normal is 0.6, so this is 10x bigger
        
        // Center platform
        const center = RAPIER.ColliderDesc.cuboid(4.0, 1.0, 4.0)
          .setTranslation(0, 5.0, 0)
          .setFriction(1.5)
          .setRestitution(0.0)

        // Slopes
        const frontSlope = RAPIER.ColliderDesc.cuboid(4.0, 1.5, 2.0)
          .setTranslation(0, 4.0, 5.0)
          .setRotation({ x: Math.sin(-15 * Math.PI / 180 / 2), y: 0, z: 0, w: Math.cos(-15 * Math.PI / 180 / 2) })
          .setFriction(0.3)
          .setRestitution(0.4)

        const backSlope = RAPIER.ColliderDesc.cuboid(4.0, 1.5, 2.0)
          .setTranslation(0, 4.0, -5.0)
          .setRotation({ x: Math.sin(15 * Math.PI / 180 / 2), y: 0, z: 0, w: Math.cos(15 * Math.PI / 180 / 2) })
          .setFriction(0.3)
          .setRestitution(0.4)

        const leftSlope = RAPIER.ColliderDesc.cuboid(2.0, 1.5, 4.0)
          .setTranslation(-5.0, 4.0, 0)
          .setRotation({ x: 0, y: 0, z: Math.sin(15 * Math.PI / 180 / 2), w: Math.cos(15 * Math.PI / 180 / 2) })
          .setFriction(0.3)
          .setRestitution(0.4)

        const rightSlope = RAPIER.ColliderDesc.cuboid(2.0, 1.5, 4.0)
          .setTranslation(5.0, 4.0, 0)
          .setRotation({ x: 0, y: 0, z: Math.sin(-15 * Math.PI / 180 / 2), w: Math.cos(-15 * Math.PI / 180 / 2) })
          .setFriction(0.3)
          .setRestitution(0.4)
        
        this.world.createCollider(center, body)
        this.world.createCollider(frontSlope, body)
        this.world.createCollider(backSlope, body)
        this.world.createCollider(leftSlope, body)
        this.world.createCollider(rightSlope, body)
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

          // Restore normal collider (Bowl shape)
          const center = RAPIER.ColliderDesc.cuboid(0.4, 0.1, 0.4)
            .setTranslation(0, 0.5, 0)
            .setFriction(1.5)
            .setRestitution(0.0)

          const frontSlope = RAPIER.ColliderDesc.cuboid(0.4, 0.15, 0.2)
            .setTranslation(0, 0.4, 0.5)
            .setRotation({ x: Math.sin(-15 * Math.PI / 180 / 2), y: 0, z: 0, w: Math.cos(-15 * Math.PI / 180 / 2) })
            .setFriction(0.3)
            .setRestitution(0.4)

          const backSlope = RAPIER.ColliderDesc.cuboid(0.4, 0.15, 0.2)
            .setTranslation(0, 0.4, -0.5)
            .setRotation({ x: Math.sin(15 * Math.PI / 180 / 2), y: 0, z: 0, w: Math.cos(15 * Math.PI / 180 / 2) })
            .setFriction(0.3)
            .setRestitution(0.4)

          const leftSlope = RAPIER.ColliderDesc.cuboid(0.2, 0.15, 0.4)
            .setTranslation(-0.5, 0.4, 0)
            .setRotation({ x: 0, y: 0, z: Math.sin(15 * Math.PI / 180 / 2), w: Math.cos(15 * Math.PI / 180 / 2) })
            .setFriction(0.3)
            .setRestitution(0.4)

          const rightSlope = RAPIER.ColliderDesc.cuboid(0.2, 0.15, 0.4)
            .setTranslation(0.5, 0.4, 0)
            .setRotation({ x: 0, y: 0, z: Math.sin(-15 * Math.PI / 180 / 2), w: Math.cos(-15 * Math.PI / 180 / 2) })
            .setFriction(0.3)
            .setRestitution(0.4)
          
          this.world.createCollider(center, body)
          this.world.createCollider(frontSlope, body)
          this.world.createCollider(backSlope, body)
          this.world.createCollider(leftSlope, body)
          this.world.createCollider(rightSlope, body)
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
