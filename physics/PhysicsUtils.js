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
  CARRY_HEIGHT_THRESHOLD,
  CARRY_STICKINESS,
  CARRY_LIFT_REDUCTION,
  POPUP_FORCE
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
  
  // 3. Hit Zone Multiplier (Rocket League style)
  const playerRadius = playerState.giant ? COLLISION_CONFIG.PLAYER_RADIUS * 10 : COLLISION_CONFIG.PLAYER_RADIUS
  const hitZoneMultiplier = getHitZoneMultiplier(ballState.y, playerState.y, playerRadius)

  // 4. Angle-Based Scaling
  const playerSpeed = Math.sqrt(playerState.vx * playerState.vx + playerState.vy * playerState.vy + playerState.vz * playerState.vz)
  
  // Calculate impulse magnitude
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
  const momentumBoost = Math.min(1.5, 0.3 + playerSpeed / 20)
  impulseX += playerState.vx * MOMENTUM_TRANSFER * momentumBoost
  impulseZ += playerState.vz * MOMENTUM_TRANSFER * momentumBoost
  
  // 7. Aerial Bonus
  if (playerState.y > 1.5 && playerState.vy > 2) {
    impulseY += Math.abs(playerState.vy) * AERIAL_MOMENTUM
  }
  
  // === CARRY / DRIBBLE CHECK ===
  if (ny > CARRY_HEIGHT_THRESHOLD) {
    // We are carrying!
    
    // 1. Reduce vertical bounce
    impulseY *= CARRY_LIFT_REDUCTION
    
    // 2. Match horizontal velocity (Stickiness)
    const targetVx = playerState.vx
    const targetVz = playerState.vz
    
    // Soft blend towards target
    impulseX = (targetVx - ballState.vx) * CARRY_STICKINESS * 3.0
    impulseZ = (targetVz - ballState.vz) * CARRY_STICKINESS * 3.0
    
    // 3. Centering Force (Anti-Slide)
    const toCenterX = playerState.x - ballState.x
    const toCenterZ = playerState.z - ballState.z
    
    const CENTERING_STRENGTH = 5.0
    impulseX += toCenterX * CENTERING_STRENGTH
    impulseZ += toCenterZ * CENTERING_STRENGTH
    
    // Add a little upward force to keep it floating
    impulseY += 2.0 
    
    return {
      impulse: { x: impulseX, y: impulseY, z: impulseZ },
      visualCue: 'dribble'
    }
  } else {
    // === POP-UP ASSIST ===
    // If not carrying, but hitting from side/below, help it get up
    // This fixes the issue where small colliders just hit the ball like a wall
    if (ny > 0.1 && playerSpeed > 2.0) {
      impulseY += POPUP_FORCE
    }
  }

  return {
    impulse: { x: impulseX, y: impulseY, z: impulseZ },
    visualCue: hitZoneMultiplier > 1.2 ? 'power' : 'normal'
  }
}
