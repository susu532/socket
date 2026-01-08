import { COLLISION_CONFIG, getHitZoneMultiplier } from './CollisionConfig.js'

// Destructure for easier access
const {
  BALL_RESTITUTION,
  BASE_BOOST,
  GIANT_BOOST,
  VERTICAL_LIFT,
  GIANT_VERTICAL_LIFT,
  MOMENTUM_TRANSFER,
  AERIAL_MOMENTUM,
  SPECULATIVE_IMPULSE_FACTOR,
  CARRY_HEIGHT_THRESHOLD,
  CARRY_STICKINESS,
  CARRY_LIFT_REDUCTION
} = COLLISION_CONFIG

/**
 * Calculates the precise Rocket League-style impulse for a ball-player collision.
 * 
 * @param {Object} ballState - { x, y, z, vx, vy, vz }
 * @param {Object} playerState - { x, y, z, vx, vy, vz, giant (bool) }
 * @param {Object} collisionData - Optional pre-calculated collision data { nx, ny, nz, dist }
 * @returns {Object} { impulse: {x, y, z}, visualCue: string }
 */
export const calculateRocketLeagueImpulse = (ballState, playerState, collisionData = null) => {
  // 1. Calculate relative position and normal if not provided
  let nx, ny, nz, dist
  
  if (collisionData) {
    nx = collisionData.nx
    ny = collisionData.ny
    nz = collisionData.nz
    dist = collisionData.dist
  } else {
    const dx = ballState.x - playerState.x
    const dy = ballState.y - playerState.y
    const dz = ballState.z - playerState.z
    dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    
    // Avoid divide by zero
    const invD = 1 / Math.max(dist, 0.001)
    nx = dx * invD
    ny = Math.max(0.1, dy * invD) // Bias slightly up to prevent tunneling
    nz = dz * invD
  }

  // 2. Relative Velocity
  const relVx = ballState.vx - playerState.vx
  const relVy = ballState.vy - playerState.vy
  const relVz = ballState.vz - playerState.vz
  
  // Project relative velocity onto normal
  const approachSpeed = relVx * nx + relVy * ny + relVz * nz
  
  // If moving apart, no impulse (unless we want to force a push, but usually no)
  // However, for "active" hits, we might want to apply force even if slightly separating
  // For now, standard physics check:
  // if (approachSpeed > 0) return { impulse: { x: 0, y: 0, z: 0 }, visualCue: 'none' }

  // 3. Hit Zone Multiplier (Rocket League style)
  // Hood = Power, Wheels = Soft
  // We need player radius. Assuming standard if not provided.
  const playerRadius = playerState.giant ? COLLISION_CONFIG.PLAYER_RADIUS * 10 : COLLISION_CONFIG.PLAYER_RADIUS
  const hitZoneMultiplier = getHitZoneMultiplier(ballState.y, playerState.y, playerRadius)

  // 4. Angle-Based Scaling
  // Direct hits (dot product ~ -1) get full power. Glancing hits get less.
  // Normal points FROM player TO ball. Relative vel points FROM ball TO player (approx).
  // We want alignment between Normal and Player Velocity for "Power Hits"
  
  const playerSpeed = Math.sqrt(playerState.vx * playerState.vx + playerState.vy * playerState.vy + playerState.vz * playerState.vz)
  
  // Calculate impulse magnitude
  // J = -(1 + e) * v_rel_normal
  // We add multipliers here
  
  let impulseMag = -(1 + BALL_RESTITUTION) * approachSpeed
  
  // Clamp min impulse to avoid sticky collisions
  if (impulseMag < 0) impulseMag = 0
  
  // Apply Hit Zone
  impulseMag *= hitZoneMultiplier
  
  // Apply Boosts
  const isGiant = playerState.giant || false
  const boostFactor = isGiant ? GIANT_BOOST : BASE_BOOST
  impulseMag *= boostFactor
  
  // 5. Calculate Final Impulse Vector
  let impulseX = nx * impulseMag
  let impulseY = ny * impulseMag
  let impulseZ = nz * impulseMag
  
  // Add Vertical Lift (Pop-up)
  const lift = isGiant ? GIANT_VERTICAL_LIFT : VERTICAL_LIFT
  impulseY += lift
  
  // 6. Momentum Transfer (Add player's velocity to ball)
  // This gives the "carry" feel
  const momentumBoost = Math.min(1.5, 0.3 + playerSpeed / 20)
  impulseX += playerState.vx * MOMENTUM_TRANSFER * momentumBoost
  impulseZ += playerState.vz * MOMENTUM_TRANSFER * momentumBoost
  
  // 7. Aerial Bonus
  // If player is in air and moving up, add extra lift
  if (playerState.y > 1.5 && playerState.vy > 2) {
    impulseY += Math.abs(playerState.vy) * AERIAL_MOMENTUM
  }
  

  
  // === CARRY / DRIBBLE CHECK ===
  // If player is UNDER the ball and moving with it, we want to "carry" it
  // Normal points from player to ball. If Y component is high, ball is on top.
  if (ny > CARRY_HEIGHT_THRESHOLD) {
    // We are carrying!
    
    // 1. Reduce vertical bounce (so it doesn't fly away)
    impulseY *= CARRY_LIFT_REDUCTION
    
    // 2. Match horizontal velocity (Stickiness)
    // Blend impulse to match player's velocity instead of bouncing off
    // Target velocity = Player Velocity
    // Impulse needed = (TargetVel - BallVel) * MassFactor
    
    // We want the result to be: NewBallVel = PlayerVel
    // Current calculation adds impulse to BallVel.
    // So we modify impulse to achieve this.
    
    const targetVx = playerState.vx
    const targetVz = playerState.vz
    
    // Soft blend towards target
    impulseX = (targetVx - ballState.vx) * CARRY_STICKINESS * 3.0 // *3.0 to account for mass?
    impulseZ = (targetVz - ballState.vz) * CARRY_STICKINESS * 3.0
    
    // Add a little upward force to keep it floating
    impulseY += 2.0 
    
    return {
      impulse: { x: impulseX, y: impulseY, z: impulseZ },
      visualCue: 'dribble'
    }
  }

  return {
    impulse: { x: impulseX, y: impulseY, z: impulseZ },
    visualCue: hitZoneMultiplier > 1.2 ? 'power' : 'normal'
  }
}
