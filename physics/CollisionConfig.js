// CollisionConfig.js - Centralized Rocket League-style collision tuning
// All constants in one place for easy iteration

export const COLLISION_CONFIG = {
  // === TIMING ===
  COOLDOWN: 0.0015,              // 1.5ms ultra-precise re-collision
  BASE_LOOKAHEAD: 0.035,         // 35ms base anticipation
  MAX_LOOKAHEAD: 0.25,           // 250ms max at high ping
  MICRO_TIME_THRESHOLD: 0.0008,  // 0.8ms precision threshold
  
  // === PHYSICS CONSTANTS ===
  BALL_RADIUS: 0.8,
  PLAYER_RADIUS: 0.8,
  BALL_RESTITUTION: 0.75,
  GRAVITY: 20,
  LINEAR_DAMPING: 1.5,
  MAX_LINEAR_VEL: 50,
  
  // === ARENA BOUNDS ===
  ARENA_HALF_WIDTH: 14.5,
  ARENA_HALF_DEPTH: 9.5,
  GOAL_HALF_WIDTH: 2.5,
  GOAL_X: 11.2,
  
  // === IMPULSE TUNING ===
  BASE_BOOST: 1.35,              // Slightly punchy feel
  GIANT_BOOST: 2.2,              // Power-up scaling
  VERTICAL_LIFT: 2.0,            // Base vertical boost on hit
  GIANT_VERTICAL_LIFT: 4.0,      // Giant mode vertical boost
  MOMENTUM_TRANSFER: 0.55,       // Player velocity transfer ratio
  AERIAL_MOMENTUM: 0.4,          // Extra momentum when hitting in air
  IMPULSE_PREDICTION_FACTOR: 0.92, // Tighter server match
  
  // === HIT ZONES (Rocket League style) ===
  // Hood (top of player) = power shot
  // Front (middle) = normal hit
  // Wheels (bottom) = soft dribble touch
  HOOD_HEIGHT_THRESHOLD: 0.6,    // Top 40% of collider
  WHEEL_HEIGHT_THRESHOLD: 0.2,   // Bottom 20% of collider
  HOOD_MULTIPLIER: 1.45,         // Power shot multiplier
  FRONT_MULTIPLIER: 1.0,         // Normal hit
  WHEEL_MULTIPLIER: 0.55,        // Soft dribble touch
  
  // === CARRY / DRIBBLE ===
  CARRY_HEIGHT_THRESHOLD: 0.75,  // Easier to initiate carry (was 0.8)
  CARRY_STICKINESS: 0.99,        // Almost perfect velocity matching (was 0.95)
  CARRY_LIFT_REDUCTION: 0.05,    // Minimal bounce when carrying (was 0.2)
  
  // === SUB-FRAME PREDICTION ===
  SUB_FRAME_STEPS_MIN: 3,
  SUB_FRAME_STEPS_MAX: 8,
  VELOCITY_DECAY_RATE: 0.94,     // Smooth velocity blending decay
  
  // === SPECULATIVE DETECTION ===
  SPECULATIVE_THRESHOLD: 0.6,    // Earlier speculative trigger
  SPECULATIVE_IMPULSE_FACTOR: 0.88, // Reduced impulse for speculative hits
  
  // === CONFIDENCE SCORING ===
  CONFIDENCE_DECAY: 0.94,
  CHAIN_COLLISION_PENALTY: 0.7,  // Reduce confidence when multiple players nearby
  
  // === VISUAL INTERPOLATION ===
  LERP_NORMAL: 35,               // Snappier base lerp
  LERP_COLLISION: 140,           // Ultra-instant snap on collision
  LERP_SNAP_THRESHOLD: 5.5,      // Lower threshold for faster snapping
  PING_DAMPENING_MAX: 500,       // Max ping for dampening calculation
  
  // === SERVER RECONCILIATION ===
  SERVER_TRUST_LOCAL: 0.35,      // Trust in server when we predicted collision
  SERVER_TRUST_REMOTE: 0.85,     // Trust in server when remote player caused it
  POSITION_SNAP_THRESHOLD: 2.0,  // Hard snap if position differs by this much
  
  // === MAGNUS EFFECT (Ball Spin) ===
  SPIN_INFLUENCE: 0.05,          // How much spin affects trajectory
  
  // === PREDICTION HISTORY ===
  MAX_PREDICTION_HISTORY: 10,    // Frames stored for rollback
  ROLLBACK_TIME_TOLERANCE: 0.05, // 50ms tolerance for finding matching prediction
}

// === ANTI-LAG & RECONCILIATION CONFIG ===
export const LAG_CONFIG = {
  EXTRAPOLATION_MAX_MS: 300,     // Cap extrapolation at 300ms ping
  RECONCILIATION_ALPHA: 0.12,    // Correct 12% of error per frame (smooth)
  ERROR_SNAP_THRESHOLD: 4.0,     // Snap if error > 4m (teleport)
  ERROR_SMOOTH_THRESHOLD: 0.05,  // Ignore errors < 5cm (jitter)
  PLAYER_RECONCILIATION_ALPHA: 0.05, // Gentle pull for player (5% per frame)
}

// Helper: Calculate hit zone multiplier based on contact height
export const getHitZoneMultiplier = (ballY, playerY, playerRadius) => {
  const hitHeight = (ballY - playerY) / playerRadius
  
  if (hitHeight > COLLISION_CONFIG.HOOD_HEIGHT_THRESHOLD) {
    return COLLISION_CONFIG.HOOD_MULTIPLIER // Power shot from top
  } else if (hitHeight < COLLISION_CONFIG.WHEEL_HEIGHT_THRESHOLD) {
    return COLLISION_CONFIG.WHEEL_MULTIPLIER // Soft dribble from bottom
  }
  return COLLISION_CONFIG.FRONT_MULTIPLIER // Normal front hit
}

// Helper: Calculate dynamic sub-frame steps based on velocity
export const getDynamicSubFrameSteps = (velocityMagnitude) => {
  return Math.min(
    COLLISION_CONFIG.SUB_FRAME_STEPS_MAX,
    Math.max(
      COLLISION_CONFIG.SUB_FRAME_STEPS_MIN,
      Math.ceil(velocityMagnitude / 10)
    )
  )
}

// Helper: Calculate velocity-scaled lookahead
export const getVelocityScaledLookahead = (baseLookahead, velocityMagnitude) => {
  // Faster ball needs less ahead prediction (it's more predictable)
  const velocityScale = Math.max(0.3, 1 - velocityMagnitude / 60)
  return baseLookahead * velocityScale
}

// Helper: Quadratic Bézier interpolation for smooth sub-frame stepping
export const bezierLerp = (start, control, end, t) => {
  const invT = 1 - t
  return {
    x: invT * invT * start.x + 2 * invT * t * control.x + t * t * end.x,
    y: invT * invT * start.y + 2 * invT * t * control.y + t * t * end.y,
    z: invT * invT * start.z + 2 * invT * t * control.z + t * t * end.z
  }
}

export default COLLISION_CONFIG
