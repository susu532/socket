// Shared physics constants for client and server consistency
export const PHYSICS = {
  TICK_RATE: 60,
  FIXED_TIMESTEP: 1 / 60,
  
  // Gravity
  GRAVITY: 20,          // For players (manual physics)
  WORLD_GRAVITY: 14,  // For ball (RAPIER world)
  
  // Player
  MOVE_SPEED: 8,
  JUMP_FORCE: 8,
  DOUBLE_JUMP_MULTIPLIER: 0.8,
  MAX_JUMPS: 2,
  GROUND_Y: 0.1,
  GROUND_CHECK_EPSILON: 0.05,
  PLAYER_RADIUS: 0.4,
  PLAYER_HEIGHT: 0.8,
  
  // Ball
  BALL_RADIUS: 0.8,
  BALL_MASS: 3.0,
  BALL_RESTITUTION: 0.75,
  BALL_LINEAR_DAMPING: 1.5,
  BALL_ANGULAR_DAMPING: 1.5,
  BALL_FRICTION: 0.5,
  
  // Restitution
  GROUND_RESTITUTION: 0.9,
  WALL_RESTITUTION: 0.3,
  GOAL_RESTITUTION: 0.6,
  POST_RESTITUTION: 0.3,
  
  // Wall Dimensions
  WALL_HEIGHT: 10,
  WALL_THICKNESS: 2,
  
  // Mechanics
  KICK_RANGE: 3.0,
  KICK_POWER: 65,
  KICK_COOLDOWN: 0.2,
  SPECULATIVE_IMPULSE_FACTOR: 0.85,
  KICK_VERTICAL_BOOST: 0.8,
  
  // Arena
  ARENA_WIDTH: 30,
  ARENA_DEPTH: 20,
  ARENA_HALF_WIDTH: 14.5,
  ARENA_HALF_DEPTH: 9.5,
  GOAL_WIDTH: 5.0,
  GOAL_HEIGHT: 4.0,
  GOAL_DEPTH: 2.0,
  GOAL_LINE_X: 10.8,

  VELOCITY_SMOOTHING: 0.95,       // Snappy velocity response (was 0.8)
  VELOCITY_SMOOTHING_SUB: 0.975,  // Adjusted for 120Hz sub-frames
  
  // Sub-frame Prediction
  SUB_FRAME_RATE: 240,
  SUB_FRAME_TIMESTEP: 1 / 240,
  INPUT_PREDICTION_LOOKAHEAD: 0.033, // 2 frames @ 60Hz
  
  // Aggressive Visual Smoothing
  VISUAL_LAMBDA_MIN: 30,          // Snappier base response
  VISUAL_LAMBDA_MAX: 100,         // Faster at speed (was 50)
  VISUAL_OFFSET_DECAY: 2.5,       // Lambda for damp smoothing (was 0.35)
  ERROR_ACCUMULATION_FACTOR: 0.1, // Factor for reconciliation error spreading
  VERTICAL_VELOCITY_LERP: 0.5,    // Blending factor for vertical velocity reconciliation
  
  // Latency Compensation
  MAX_PREDICTION_TIME: 0.2, // 200ms max lookahead (was 150ms)
  RECONCILE_BLEND_FAST: 0.5,      // Faster blending when needed
  RECONCILE_BLEND_SLOW: 0.15,      // Less sluggish slow blend

  // S-Tier Sub-Frame Precision
  VISUAL_RATE: 240,                   // 240Hz visual interpolation  
  VISUAL_TIMESTEP: 1 / 240,
  KICK_TIMESTAMP_BUFFER: 0.033,       // 2 frames of kick timestamp lookahead
  TOUCH_RESPONSE_BOOST: 4.0,          // Increased from 3.5 for ultra-instant feel
  
  // Adaptive Reconciliation Tiers
  RECONCILE_TIER_1_PING: 50,          // <50ms: aggressive local prediction
  RECONCILE_TIER_2_PING: 150,         // 50-150ms: balanced
  RECONCILE_TIER_3_PING: 300,         // >150ms: trust server more
  
  // Collision Prediction Tuning
  SWEEP_SUBSTEPS: 16,                 // Increased from 12 for high-speed precision
  CCD_ITERATIONS: 8,                  // Increased from 4 for robust collision detection
  INSTANT_TOUCH_THRESHOLD: 0.015,     // 15ms for instant visual response

  // Professional Touch Response
  FIRST_TOUCH_SNAP_FACTOR: 1.0,       // Increased from 0.99 for instant visual snap
  COLLISION_CONFIDENCE_BOOST: 4.0,    // Increased from 3.0 weighting
  TOUCH_VELOCITY_TRANSFER: 1.0,       // Aggressive player velocity transfer (was 0.9)
  MICRO_COLLISION_THRESHOLD: 0.002,   // 2ms threshold for micro-collision timing

  // Reconciliation Smoothness
  HERMITE_BLEND_RANGE_MIN: 0.5,
  HERMITE_BLEND_RANGE_MAX: 2.0,
  HERMITE_SMOOTHING_TENSION: 0.5,     // Catmull-Rom style tension
  VELOCITY_FADEOUT_RATE: 0.85,
  HEAD_STABILIZATION_LAMBDA: 40,      // Damping for head height stability

  // Adaptive Error Thresholds
  RECONCILE_BASE_THRESHOLD: 0.15,
  RECONCILE_ACTION_THRESHOLD: 0.4,    // After kicks/collisions
  RECONCILE_IDLE_THRESHOLD: 0.08,     // Ball slow/stopped

  // Phase 22-26: Advanced Collision Refinement
  COLLISION_SUBDIVISIONS: 8,          // Increased from 4 for 240Hz precision
  COLLISION_SUBDIVISION_THRESHOLD: 0.5,
  HERMITE_TENSION: 0.0,
  IMPULSE_RAMP_FRAMES: 1,             // Reduced from 2 for 100% instant response
  COLLISION_ANGLE_FACTOR: 0.85,       // Increased from 0.8
  
  
  // Phase 32: Gold Standard Collision Tuning
  COLLISION_COOLDOWN: 0.002,          // 2ms - near-instant re-collision
  BASE_LOOKAHEAD: 0.02,               // 20ms base lookahead
  MAX_LOOKAHEAD: 0.08,                // 80ms max lookahead
  IMPULSE_PREDICTION_FACTOR: 1.0,     // Full trust in local prediction
  COLLISION_LOCKOUT_DURATION: 0.05,   // 50ms lockout window (was 120ms)
  
  // Phase 33: Gold Standard Netcode Refinement
  SERVER_PATCH_RATE: 60,              // 60Hz server updates
  INPUT_BATCH_SIZE: 5,                // Max inputs to process per tick
  JITTER_BUFFER_MAX: 10,              // Max input queue size
  RECONCILE_SNAP_THRESHOLD: 4.0,      // Distance to force hard snap
}
