import { Schema, MapSchema, defineTypes } from '@colyseus/schema'

// Player state
export class PlayerState extends Schema {
  constructor() {
    super()
    this.x = 0
    this.y = 0.1
    this.z = 0
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.rotY = 0
    this.name = ''
    this.team = ''
    this.character = 'cat'
    this.invisible = false
    this.giant = false
    this.jumpCount = 0
    this.sessionId = ''
    
    // Power-up multipliers
    this.speedMult = 1
    this.jumpMult = 1
    this.kickMult = 1
    this.tick = 0
    
    // Stats
    this.goals = 0
    this.assists = 0
    this.shots = 0
  }
}

defineTypes(PlayerState, {
  x: 'number',
  y: 'number',
  z: 'number',
  vx: 'number',
  vy: 'number',
  vz: 'number',
  rotY: 'number',
  name: 'string',
  team: 'string',
  character: 'string',
  invisible: 'boolean',
  giant: 'boolean',
  sessionId: 'string',
  speedMult: 'number',
  jumpMult: 'number',
  kickMult: 'number',
  jumpCount: 'number',
  tick: 'number',
  goals: 'number',
  assists: 'number',
  shots: 'number'
})

// Power-up state
export class PowerUpState extends Schema {
  constructor() {
    super()
    this.id = ''
    this.type = ''
    this.x = 0
    this.y = 0
    this.z = 0
  }
}

defineTypes(PowerUpState, {
  id: 'string',
  type: 'string',
  x: 'number',
  y: 'number',
  z: 'number'
})

// Ball state
export class BallState extends Schema {
  constructor() {
    super()
    this.x = 0
    this.y = 2
    this.z = 0
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.rx = 0
    this.ry = 0
    this.rz = 0
    this.rw = 1
    this.tick = 0
    this.ownerSessionId = ''
  }
}

defineTypes(BallState, {
  x: 'number',
  y: 'number',
  z: 'number',
  vx: 'number',
  vy: 'number',
  vz: 'number',
  rx: 'number',
  ry: 'number',
  rz: 'number',
  rw: 'number',
  tick: 'number',
  ownerSessionId: 'string'
})

// Main game state
export class GameState extends Schema {
  constructor() {
    super()
    this.players = new MapSchema()
    this.powerUps = new MapSchema()
    this.ball = new BallState()
    this.redScore = 0
    this.blueScore = 0
    this.timer = 300
    this.gamePhase = 'waiting'
    this.selectedMap = 'OceanFloor'
    this.currentTick = 0
  }
}

defineTypes(GameState, {
  players: { map: PlayerState },
  powerUps: { map: PowerUpState },
  ball: BallState,
  redScore: 'number',
  blueScore: 'number',
  timer: 'number',
  gamePhase: 'string',
  selectedMap: 'string',
  currentTick: 'number'
})
