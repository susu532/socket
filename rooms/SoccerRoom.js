import { Room } from 'colyseus'
import RAPIER from '@dimforge/rapier3d-compat'
import { GameState, PlayerState } from '../schema/GameState.js'

const PHYSICS_TICK_RATE = 1000 / 45 // 45Hz
const STATE_SYNC_RATE = 1000 / 30   // 30Hz
const GOAL_COOLDOWN = 5000          // 5 seconds

export class SoccerRoom extends Room {
  maxClients = 10

  // Physics world
  world = null
  playerBodies = new Map()
  ballBody = null

  // Timers
  lastGoalTime = 0
  timerInterval = null

  async onCreate(options) {
    console.log('SoccerRoom created!')

    // Initialize state
    this.setState(new GameState())

    // Initialize Rapier
    await RAPIER.init()
    this.world = new RAPIER.World({ x: 0, y: -20, z: 0 })

    // Create arena colliders
    this.createArena()

    // Create ball rigid body
    this.createBall()

    // Physics loop
    this.setSimulationInterval((deltaTime) => this.physicsUpdate(deltaTime), PHYSICS_TICK_RATE)

    // State sync (broadcast at 30Hz)
    this.clock.setInterval(() => this.syncState(), STATE_SYNC_RATE)

    // Message handlers
    this.onMessage('input', (client, data) => this.handleInput(client, data))
    this.onMessage('kick', (client, data) => this.handleKick(client, data))
    this.onMessage('join-team', (client, data) => this.handleJoinTeam(client, data))
    this.onMessage('chat', (client, data) => this.handleChat(client, data))
    this.onMessage('start-game', (client) => this.handleStartGame(client))
    this.onMessage('end-game', (client) => this.handleEndGame(client))
    this.onMessage('update-state', (client, data) => this.handleUpdateState(client, data))
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

    // Goal back walls
    const goalWidth = 6
    const goalBackWallPositions = [[-13 - wallThickness, 0], [13 + wallThickness, 0]]
    goalBackWallPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cuboid(wallThickness / 2, wallHeight / 2, (goalWidth + 2) / 2)
        .setTranslation(x, wallHeight / 2, z)
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

    // Goal side barriers
    const barrierPositions = [
      [13, -2.4], [-13, -2.4], [13, 2.4], [-13, 2.4]
    ]
    barrierPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cuboid(2, 6.5, 0.1)
        .setTranslation(x, 0, z)
      this.world.createCollider(desc)
    })

    // Goal area blockers
    const blockerPositions = [[-10.8, 0], [10.8, 0]]
    blockerPositions.forEach(([x, z]) => {
      const desc = RAPIER.ColliderDesc.cuboid(2.5, 4.5, 2.75)
        .setTranslation(x, 8.7, z)
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

    const collider = RAPIER.ColliderDesc.cuboid(0.5, 0.8, 0.5)
      .setTranslation(0, 0.8, 0)

    this.world.createCollider(collider, body)
    this.playerBodies.set(sessionId, body)

    return { x: spawnX, y: 0.1, z: 0 }
  }

  onJoin(client, options) {
    console.log(`Player ${client.sessionId} joined`)

    const player = new PlayerState()
    player.name = options.name || 'Player'
    player.team = options.team || 'red'
    player.character = options.character || 'cat'

    const spawn = this.createPlayerBody(client.sessionId, player.team)
    player.x = spawn.x
    player.y = spawn.y
    player.z = spawn.z

    this.state.players.set(client.sessionId, player)

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

    this.broadcast('player-left', { sessionId: client.sessionId })
  }

  handleInput(client, data) {
    const player = this.state.players.get(client.sessionId)
    const body = this.playerBodies.get(client.sessionId)
    if (!player || !body) return

    const { moveX, moveZ, jump, rotY } = data

    // Calculate new position based on input
    const speed = 8 * (1 / 45) // MOVE_SPEED * deltaTime
    const currentPos = body.translation()

    let newX = currentPos.x + (moveX || 0) * speed
    let newZ = currentPos.z + (moveZ || 0) * speed
    let newY = currentPos.y

    // Simple jump (if on ground)
    if (jump && currentPos.y <= 0.2) {
      newY = 1 // Simple jump impulse visual
    }

    // Bounds
    newX = Math.max(-14.7, Math.min(14.7, newX))
    newZ = Math.max(-9.7, Math.min(9.7, newZ))

    // Ground check
    if (newY < 0.1) newY = 0.1

    // Update kinematic body
    body.setNextKinematicTranslation({ x: newX, y: newY, z: newZ })

    // Update state
    player.x = newX
    player.y = newY
    player.z = newZ
    player.rotY = rotY || player.rotY
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

    if (dist < 2.5) {
      const { impulseX, impulseY, impulseZ } = data

      this.ballBody.applyImpulse({ x: impulseX, y: impulseY + 2, z: impulseZ }, true)

      // Broadcast kick visual
      this.broadcast('ball-kicked', { playerId: client.sessionId })
    }
  }

  handleJoinTeam(client, data) {
    const player = this.state.players.get(client.sessionId)
    if (!player) return

    player.name = data.name || player.name
    player.team = data.team || player.team
    player.character = data.character || player.character

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
        body.setNextKinematicTranslation({ x: spawnX, y: 0.1, z: 0 })
        player.x = spawnX
        player.y = 0.1
        player.z = 0
      }
    })

    this.broadcast('game-reset', {})
  }

  physicsUpdate(deltaTime) {
    // Step physics world
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

      // Reset ball after delay
      this.clock.setTimeout(() => {
        if (this.ballBody) {
          this.ballBody.setTranslation({ x: 0, y: 2, z: 0 }, true)
          this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
          this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
        }
      }, 3000)
    }
  }

  syncState() {
    // State is automatically synced by Colyseus schema
    // This is here for any additional manual syncing if needed
  }

  onDispose() {
    console.log('SoccerRoom disposed')
    if (this.timerInterval) {
      this.timerInterval.clear()
    }
  }
}
