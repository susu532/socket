import { Room } from 'colyseus'
import RAPIER from '@dimforge/rapier3d-compat'
import { GameState, PlayerState, PowerUpState } from '../schema/GameState.js'
import { registerPrivateRoom, unregisterRoom, getRoomIdByCode } from '../roomRegistry.js'

const PHYSICS_TICK_RATE = 1000 / 120 // 120Hz for high-precision physics
const GOAL_COOLDOWN = 5000          // 5 seconds
const EMPTY_DISPOSE_DELAY = 30000   // 30 seconds

// ═══════════════════════════════════════════════════════════════════════════
// S-TIER ROCKET LEAGUE PHYSICS CONSTANTS (SYNCED WITH CLIENT)
// ═══════════════════════════════════════════════════════════════════════════
const BALL_RADIUS = 0.8
const PLAYER_RADIUS = 0.5
const BALL_RESTITUTION = 0.75

// Ground Lifting System
const GROUND_PROXIMITY_THRESHOLD = BALL_RADIUS * 1.3
const GROUND_LIFT_MULTIPLIER = 1.85
const SCOOP_ANGLE_BONUS = 0.7
const GROUND_FORWARD_TRANSFER = 0.6

// Roof Dribbling System
const ROOF_DETECT_HEIGHT = 1.0
const ROOF_DETECT_RADIUS = 1.2
const ROOF_DAMPING_FACTOR = 0.88
const ROOF_PULL_STRENGTH = 2.8
const ROOF_DEADZONE = 0.15
const ROOF_VELOCITY_THRESHOLD = 15
const ROOF_VELOCITY_MATCH = 0.15          // Ball velocity matching to player
const ROOF_VERTICAL_DAMPING = 0.7         // Reduce vertical bounce on roof
const ROOF_STICKY_RADIUS = 0.4            // Inner zone with stronger magnetism

// Pre-Lift Assist Zone (helps ball transition to roof)
const LIFT_ASSIST_HEIGHT = 0.8            // Y threshold for assist activation
const LIFT_ASSIST_RADIUS = 1.5            // Horizontal detection radius
const LIFT_ASSIST_FORCE = 4.5             // Upward assist strength
const LIFT_ASSIST_VELOCITY_CAP = 8        // Max ball speed for assist

// Enhanced Scoop Mechanics
const SCOOP_DETECTION_ANGLE = Math.PI / 6 // 30° below horizontal
const SCOOP_LIFT_BONUS = 2.2              // Extra vertical boost
const SCOOP_FORWARD_BOOST = 0.4           // Forward momentum on scoop

// Contact Precision System
const CONTACT_ZONE_FRONT = Math.PI / 4
const CONTACT_ZONE_SIDE = (3 * Math.PI) / 4
const FRONT_HIT_FORWARD_BIAS = 1.3
const SIDE_HIT_PERPENDICULAR = 0.4
const BACK_HIT_CHIP_MULTIPLIER = 1.5

// Continuous Contact System
const CONTINUOUS_CONTACT_RADIUS = BALL_RADIUS + PLAYER_RADIUS + 0.1
const CONTACT_IMPULSE_SCALE = 0.5         // Scale for continuous contact impulses

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - ROCKET LEAGUE MECHANICS
// ═══════════════════════════════════════════════════════════════════════════

const calculateContactZone = (playerPos, playerRotY, ballPos) => {
  const dx = ballPos.x - playerPos.x
  const dz = ballPos.z - playerPos.z
  const dist = Math.sqrt(dx * dx + dz * dz) || 1
  const toBallX = dx / dist
  const toBallZ = dz / dist
  
  const forwardX = Math.sin(playerRotY)
  const forwardZ = Math.cos(playerRotY)
  
  const dot = forwardX * toBallX + forwardZ * toBallZ
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
  
  if (angle < CONTACT_ZONE_FRONT) return 'front'
  if (angle < CONTACT_ZONE_SIDE) return 'side'
  return 'back'
}

const applyGroundLiftBias = (impulse, ballY, playerVelY) => {
  if (ballY >= GROUND_PROXIMITY_THRESHOLD) return impulse
  
  let liftMultiplier = GROUND_LIFT_MULTIPLIER
  if (playerVelY > 0.5) liftMultiplier += SCOOP_ANGLE_BONUS
  
  impulse.y *= liftMultiplier
  
  const horizontalMag = Math.sqrt(impulse.x * impulse.x + impulse.z * impulse.z)
  if (horizontalMag > 0.1) {
    impulse.x *= 1 + GROUND_FORWARD_TRANSFER
    impulse.z *= 1 + GROUND_FORWARD_TRANSFER
  }
  return impulse
}

const applyRoofMagnetism = (ballPos, ballVel, playerPos, playerVel, delta) => {
  const dx = ballPos.x - playerPos.x
  const dy = ballPos.y - (playerPos.y + ROOF_DETECT_HEIGHT)
  const dz = ballPos.z - playerPos.z
  const horizontalDist = Math.sqrt(dx * dx + dz * dz)
  
  const isOnRoof = dy > 0 && 
                   dy < BALL_RADIUS * 2 && 
                   horizontalDist < ROOF_DETECT_RADIUS
  
  if (!isOnRoof) return { damping: 1.0, pull: { x: 0, y: 0, z: 0 }, velocityMatch: { x: 0, y: 0, z: 0 } }
  
  const ballSpeed = Math.sqrt(ballVel.x * ballVel.x + ballVel.y * ballVel.y + ballVel.z * ballVel.z)
  if (ballSpeed > ROOF_VELOCITY_THRESHOLD) {
    return { damping: 1.0, pull: { x: 0, y: 0, z: 0 }, velocityMatch: { x: 0, y: 0, z: 0 } }
  }
  
  const pull = { x: 0, y: 0, z: 0 }
  const velocityMatch = { x: 0, y: 0, z: 0 }
  
  // Enhanced horizontal pull with sticky zone
  if (horizontalDist > ROOF_DEADZONE) {
    const invH = 1 / horizontalDist
    const pullX = (playerPos.x - ballPos.x) * invH
    const pullZ = (playerPos.z - ballPos.z) * invH
    
    // Stronger pull in sticky zone
    const isInStickyZone = horizontalDist < ROOF_STICKY_RADIUS
    const stickyMultiplier = isInStickyZone ? 2.5 : 1.0
    const strength = Math.min(1, horizontalDist / ROOF_DETECT_RADIUS) * stickyMultiplier
    
    pull.x = pullX * ROOF_PULL_STRENGTH * strength * delta
    pull.z = pullZ * ROOF_PULL_STRENGTH * strength * delta
  }
  
  // Velocity matching - ball follows player movement
  if (playerVel) {
    velocityMatch.x = (playerVel.x - ballVel.x) * ROOF_VELOCITY_MATCH
    velocityMatch.z = (playerVel.z - ballVel.z) * ROOF_VELOCITY_MATCH
  }
  
  // Vertical damping for bounce reduction
  const verticalDamping = ballVel.y > 0 ? ROOF_VERTICAL_DAMPING : ROOF_DAMPING_FACTOR
  
  return {
    damping: ROOF_DAMPING_FACTOR,
    verticalDamping: verticalDamping,
    pull: pull,
    velocityMatch: velocityMatch,
    isInStickyZone: horizontalDist < ROOF_STICKY_RADIUS
  }
}

// Pre-Lift Assist: helps ball transition from ground to roof
const applyLiftAssist = (ballPos, ballVel, playerPos, playerVel, delta) => {
  const ballSpeed = Math.sqrt(ballVel.x * ballVel.x + ballVel.y * ballVel.y + ballVel.z * ballVel.z)
  
  // Only assist slow-moving balls at low height
  if (ballPos.y > LIFT_ASSIST_HEIGHT || ballSpeed > LIFT_ASSIST_VELOCITY_CAP) {
    return { liftForce: 0, velocityMatch: { x: 0, z: 0 } }
  }
  
  const dx = ballPos.x - playerPos.x
  const dz = ballPos.z - playerPos.z
  const horizontalDist = Math.sqrt(dx * dx + dz * dz)
  
  if (horizontalDist > LIFT_ASSIST_RADIUS) {
    return { liftForce: 0, velocityMatch: { x: 0, z: 0 } }
  }
  
  // Lift force inversely proportional to distance
  const distFactor = 1 - horizontalDist / LIFT_ASSIST_RADIUS
  const liftForce = LIFT_ASSIST_FORCE * distFactor * delta
  
  // Match ball horizontal velocity to player
  const velocityMatch = {
    x: (playerVel.x - ballVel.x) * 0.1 * distFactor,
    z: (playerVel.z - ballVel.z) * 0.1 * distFactor
  }
  
  return { liftForce, velocityMatch }
}

// Scoop Mechanics: enhanced lift when player moves into ball from below
const applyScoopMechanics = (ballPos, ballVel, playerPos, playerVel, playerRotY) => {
  // Check if player is moving forward and upward
  const forwardX = Math.sin(playerRotY)
  const forwardZ = Math.cos(playerRotY)
  const playerForwardSpeed = playerVel.x * forwardX + playerVel.z * forwardZ
  
  if (playerForwardSpeed < 2.0 || playerVel.y <= 0) {
    return { scoopImpulse: { x: 0, y: 0, z: 0 } }
  }
  
  const dx = ballPos.x - playerPos.x
  const dy = ballPos.y - playerPos.y
  const dz = ballPos.z - playerPos.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  
  // Ball must be close and roughly in front of player
  if (dist > CONTINUOUS_CONTACT_RADIUS * 1.5) {
    return { scoopImpulse: { x: 0, y: 0, z: 0 } }
  }
  
  // Check angle: ball should be low relative to player forward
  const horizontalDist = Math.sqrt(dx * dx + dz * dz)
  const angleToHorizontal = Math.atan2(dy, horizontalDist)
  
  if (angleToHorizontal > SCOOP_DETECTION_ANGLE) {
    return { scoopImpulse: { x: 0, y: 0, z: 0 } }
  }
  
  // Apply scoop impulse
  const scoopStrength = Math.min(1, playerForwardSpeed / 8) * SCOOP_LIFT_BONUS
  const scoopImpulse = {
    x: forwardX * playerForwardSpeed * SCOOP_FORWARD_BOOST,
    y: scoopStrength * 3,
    z: forwardZ * playerForwardSpeed * SCOOP_FORWARD_BOOST
  }
  
  return { scoopImpulse }
}

// Continuous contact detection for smooth ball control
const applyContinuousContact = (ballPos, ballVel, playerPos, playerVel, delta) => {
  const dx = ballPos.x - playerPos.x
  const dy = ballPos.y - playerPos.y
  const dz = ballPos.z - playerPos.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  
  if (dist > CONTINUOUS_CONTACT_RADIUS || dist < 0.1) {
    return null
  }
  
  // Calculate contact normal
  const invD = 1 / dist
  const nx = dx * invD
  const ny = Math.max(0.05, dy * invD) // Slight upward bias
  const nz = dz * invD
  
  // Relative velocity
  const relVx = ballVel.x - (playerVel.x || 0)
  const relVy = ballVel.y - (playerVel.y || 0)
  const relVz = ballVel.z - (playerVel.z || 0)
  const approachSpeed = relVx * nx + relVy * ny + relVz * nz
  
  // Only apply if approaching
  if (approachSpeed > 0) {
    return null
  }
  
  // Soft push impulse
  const impulseMag = -approachSpeed * CONTACT_IMPULSE_SCALE
  const impulse = {
    x: impulseMag * nx + (playerVel.x || 0) * 0.3,
    y: impulseMag * ny + 0.5, // Slight lift
    z: impulseMag * nz + (playerVel.z || 0) * 0.3
  }
  
  // Separation push
  const overlap = CONTINUOUS_CONTACT_RADIUS - dist
  const separation = {
    x: nx * overlap * 0.5,
    y: ny * overlap * 0.3,
    z: nz * overlap * 0.5
  }
  
  return { impulse, separation, contactNormal: { x: nx, y: ny, z: nz } }
}

const applyContactZoneModifiers = (impulse, zone, playerRotY, nx, nz) => {
  const forwardX = Math.sin(playerRotY)
  const forwardZ = Math.cos(playerRotY)
  const impulseLen = Math.sqrt(impulse.x * impulse.x + impulse.y * impulse.y + impulse.z * impulse.z)
  
  switch(zone) {
    case 'front':
      impulse.x += forwardX * impulseLen * FRONT_HIT_FORWARD_BIAS
      impulse.z += forwardZ * impulseLen * FRONT_HIT_FORWARD_BIAS
      break
    case 'side':
      const perpX = -forwardZ
      const perpZ = forwardX
      const sideDir = Math.sign(perpX * nx + perpZ * nz)
      impulse.x += perpX * sideDir * impulseLen * SIDE_HIT_PERPENDICULAR
      impulse.z += perpZ * sideDir * impulseLen * SIDE_HIT_PERPENDICULAR
      impulse.y *= 1.2
      break
    case 'back':
      impulse.y *= BACK_HIT_CHIP_MULTIPLIER
      impulse.x *= 0.7
      impulse.z *= 0.7
      break
  }
  return impulse
}

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
      const desc = RAPIER.ColliderDesc.cylinder(3, 0.06)
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

    const collider = RAPIER.ColliderDesc.cuboid(0.5, 0.2, 0.5)
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

    if (dist < 1.7) {
      const { impulseX, impulseY, impulseZ } = data
      const kickMult = player.kickMult || 1
      const playerRotY = player.inputRotY || 0
      const playerVelY = player.vy || 0

      // 1. Calculate contact zone
      const zone = calculateContactZone(playerPos, playerRotY, ballPos)

      // 2. Base impulse from client (already scaled by kickMult)
      let impulse = { x: impulseX, y: impulseY, z: impulseZ }

      // 3. Apply Ground Lift Bias (scoop mechanics)
      impulse = applyGroundLiftBias(impulse, ballPos.y, playerVelY)

      // 4. Apply Contact Zone Modifiers (directional control)
      const invD = 1 / Math.max(dist, 0.1)
      const nx = dx * invD
      const nz = dz * invD
      impulse = applyContactZoneModifiers(impulse, zone, playerRotY, nx, nz)

      // Apply final impulse to RAPIER body
      this.ballBody.applyImpulse(impulse, true)

      // Broadcast kick visual to all clients with final impulse for prediction
      this.broadcast('ball-kicked', { 
        playerId: client.sessionId,
        impulse: impulse,
        zone: zone
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

      // ═══════════════════════════════════════════════════════════════════
      // ROCKET LEAGUE S-TIER BALL PHYSICS INTEGRATION
      // ═══════════════════════════════════════════════════════════════════
      if (this.ballBody) {
        const ballPos = this.ballBody.translation()
        const ballVel = this.ballBody.linvel()
        const playerPos = { x: newX, y: newY, z: newZ }
        const playerVel = { x: player.vx || 0, y: player.vy || 0, z: player.vz || 0 }
        const playerRotY = rotY
        
        // MODULE 1: LIFT ASSIST (ground-to-roof transition)
        const liftEffect = applyLiftAssist(ballPos, ballVel, playerPos, playerVel, deltaTime)
        if (liftEffect.liftForce > 0) {
          this.ballBody.applyImpulse({
            x: liftEffect.velocityMatch.x,
            y: liftEffect.liftForce,
            z: liftEffect.velocityMatch.z
          }, true)
        }
        
        // MODULE 2: SCOOP MECHANICS (jump + forward = ball lift)
        const scoopEffect = applyScoopMechanics(ballPos, ballVel, playerPos, playerVel, playerRotY)
        if (scoopEffect.scoopImpulse.y > 0) {
          this.ballBody.applyImpulse(scoopEffect.scoopImpulse, true)
        }
        
        // MODULE 3: CONTINUOUS CONTACT (smooth ball control)
        const contactEffect = applyContinuousContact(ballPos, ballVel, playerPos, playerVel, deltaTime)
        if (contactEffect) {
          this.ballBody.applyImpulse(contactEffect.impulse, true)
          // Apply separation to prevent overlap
          const currentBallPos = this.ballBody.translation()
          this.ballBody.setTranslation({
            x: currentBallPos.x + contactEffect.separation.x,
            y: currentBallPos.y + contactEffect.separation.y,
            z: currentBallPos.z + contactEffect.separation.z
          }, true)
        }
        
        // MODULE 4: ENHANCED ROOF DRIBBLE MAGNETISM
        const roofEffect = applyRoofMagnetism(
          ballPos,
          ballVel,
          playerPos,
          playerVel,
          deltaTime
        )

        if (roofEffect.damping < 1.0) {
          // Apply velocity damping (with vertical-specific damping)
          const vertDamp = roofEffect.verticalDamping || roofEffect.damping
          this.ballBody.setLinvel({
            x: ballVel.x * roofEffect.damping + roofEffect.velocityMatch.x,
            y: ballVel.y * vertDamp,
            z: ballVel.z * roofEffect.damping + roofEffect.velocityMatch.z
          }, true)

          // Apply magnetism pull (as impulse)
          this.ballBody.applyImpulse(roofEffect.pull, true)
          
          // Extra stabilization in sticky zone
          if (roofEffect.isInStickyZone) {
            this.ballBody.applyImpulse({ x: 0, y: -0.5, z: 0 }, true) // Slight downward to prevent float
          }
        }
      }
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
        const giantCollider = RAPIER.ColliderDesc.cuboid(6.0, 4.0, 6.0)
          .setTranslation(0, 2.0, 0) // Shift up so it doesn't clip ground
          .setFriction(2.0)
          .setRestitution(0.0)
        
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

          const normalCollider = RAPIER.ColliderDesc.cuboid(0.5, 0.2, 0.5)
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
