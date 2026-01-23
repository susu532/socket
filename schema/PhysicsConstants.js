// Shared physics constants for client and server consistency
export const PHYSICS = {
  TICK_RATE: 60,
  FIXED_TIMESTEP: 1 / 60,
  
  // Gravity
  GRAVITY: 20,          // For players (manual physics)
  WORLD_GRAVITY: 10,  // For ball (RAPIER world)
  
  // Player
  MOVE_SPEED: 8,
  JUMP_FORCE: 8,
  DOUBLE_JUMP_MULTIPLIER: 0.8,
  MAX_JUMPS: 2,
  GROUND_Y: 0.1,
  GROUND_CHECK_EPSILON: 0.05,
  PLAYER_RADIUS: 0.6,
  PLAYER_HEIGHT: 0.8,
  
  // Ball
  BALL_RADIUS: 0.8,
  BALL_MASS: 3.0,
  BALL_RESTITUTION: 0.75,
  BALL_LINEAR_DAMPING: 1.5,
  BALL_ANGULAR_DAMPING: 1.5,
  MAX_BALL_VELOCITY: 60, // Cap to prevent tunneling/ejection
  
  // Restitution
  GROUND_RESTITUTION: 0.6,
  WALL_RESTITUTION: 0.3,
  GOAL_RESTITUTION: 1.5,  // Increased for stronger net bounce
  POST_RESTITUTION: 0.3,
  
  // Wall Dimensions
  WALL_HEIGHT: 10,
  WALL_THICKNESS: 2,
  GOAL_NET_WALL_THICKNESS: 1.0,  // Thick goal net side walls (was 0.1)
  
  // Mechanics
  KICK_RANGE: 3.0,
  KICK_POWER: 65,
  KICK_COOLDOWN: 0.2,
  SPECULATIVE_IMPULSE_FACTOR: 0.92,
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
  SUB_FRAME_RATE: 120,
  SUB_FRAME_TIMESTEP: 1 / 120,
  INPUT_PREDICTION_LOOKAHEAD: 0.033, // 2 frames @ 60Hz
  
  // Aggressive Visual Smoothing
  VISUAL_LAMBDA_MIN: 30,          // Snappier base response
  VISUAL_LAMBDA_MAX: 50,          // Faster at speed
  VISUAL_OFFSET_DECAY: 0.35,      // Faster correction hiding
  
  // Latency Compensation
  MAX_PREDICTION_TIME: 0.15, // 150ms max lookahead
  RECONCILE_BLEND_FAST: 0.5,      // Faster blending when needed
  RECONCILE_BLEND_SLOW: 0.15,      // Less sluggish slow blend

  // S-Tier Sub-Frame Precision
  VISUAL_RATE: 240,                   // 240Hz visual interpolation  
  VISUAL_TIMESTEP: 1 / 240,
  KICK_TIMESTAMP_BUFFER: 0.033,       // 2 frames of kick timestamp lookahead
  TOUCH_RESPONSE_BOOST: 1.8,          // Boost factor for first-touch
  
  // Adaptive Reconciliation Tiers
  RECONCILE_TIER_1_PING: 50,          // <50ms: aggressive local prediction
  RECONCILE_TIER_2_PING: 150,         // 50-150ms: balanced
  RECONCILE_TIER_3_PING: 300,         // >150ms: trust server more
  
  // Collision Prediction Tuning
  SWEEP_SUBSTEPS: 8,                  // Sub-frame sweep subdivisions
  INSTANT_TOUCH_THRESHOLD: 0.015,     // 15ms for instant visual response

  // Professional Touch Response
  FIRST_TOUCH_SNAP_FACTOR: 0.95,      // Near-instant visual snap on first contact
  COLLISION_CONFIDENCE_BOOST: 2.0,    // Increase impulse confidence weighting
  TOUCH_VELOCITY_TRANSFER: 0.85,       // Aggressive player velocity transfer
  MICRO_COLLISION_THRESHOLD: 0.005,   // 5ms threshold for micro-collision timing

  // Reconciliation Smoothness
  HERMITE_BLEND_RANGE_MIN: 0.5,
  HERMITE_BLEND_RANGE_MAX: 2.0,
  VELOCITY_FADEOUT_RATE: 0.85,
  HEAD_STABILIZATION_LAMBDA: 40,      // Damping for head height stability

  // Adaptive Error Thresholds
  RECONCILE_BASE_THRESHOLD: 0.15,
  RECONCILE_ACTION_THRESHOLD: 0.4,    // After kicks/collisions
  RECONCILE_IDLE_THRESHOLD: 0.08,     // Ball slow/stopped

  // Phase 22-26: Advanced Collision Refinement
  COLLISION_SUBDIVISIONS: 6,
  COLLISION_SUBDIVISION_THRESHOLD: 1.5,
  HERMITE_TENSION: 0.0,
  IMPULSE_RAMP_FRAMES: 1,
  COLLISION_ANGLE_FACTOR: 0.95,

  // Running Collision Enhancement
  PLAYER_BALL_RESTITUTION: 0.85,       // Low bounce for ball stability on player head
  PLAYER_BALL_VELOCITY_TRANSFER: 0.65, // Tuned: less player momentum to ball for better control
  PLAYER_BALL_IMPULSE_MIN: 5,          // Tuned: lower min for softer touches
  PLAYER_BALL_APPROACH_BOOST: 1.4,     // Boost factor when approaching head-on
  RUNNING_COLLISION_SNAP: 0.9,         // Instant visual snap for running collisions
  COLLISION_VELOCITY_THRESHOLD: 3,     // Speed threshold for enhanced response

  // Ball Head Stability (for balancing ball on head)
  BALL_STABILITY_VELOCITY_THRESHOLD: 1.5,  // Below this relative velocity, apply stability
  BALL_STABILITY_HEIGHT_MIN: 0.3,          // Ball must be this much above player center
  BALL_STABILITY_DAMPING: 0.92,            // Dampen ball velocity when resting on head
  BALL_STABILITY_IMPULSE_CAP: 2.0,         // Max impulse when in stability mode

  // Collision Lift
  COLLISION_LIFT: 5.0,                     // Tuned: less upwards lift for grounded feel
  COLLISION_LIFT_GIANT: 3.0,              // Tuned: proportional reduction for giant

  // Ball Prediction Engine - Lookahead Collision
  LOOKAHEAD_FRAMES: 8,                     // Frames to predict ahead
  LOOKAHEAD_MAX_TIME: 0.133,               // ~8 frames at 60Hz
  TTC_THRESHOLD: 0.1,                      // Time-to-collision trigger (100ms)
  TTC_PREEMPTIVE_FRAMES: 3,                // Frames before collision to start response
  
  // Ball Prediction Engine - Confidence Scoring
  PREDICTION_CONFIDENCE_MIN: 0.3,          // Minimum confidence to apply prediction
  PREDICTION_CONFIDENCE_DECAY: 0.85,       // Per-frame confidence decay
  PREDICTION_CONFIDENCE_BOOST: 1.5,        // Boost on confirmed collision
  
  // Ball Prediction Engine - Trajectory
  TRAJECTORY_SPLINE_TENSION: 0.5,          // Catmull-Rom spline tension
  TRAJECTORY_SAMPLES: 16,                  // Points per prediction arc
  
  // Ball Prediction Engine - Rollback
  ROLLBACK_BUFFER_SIZE: 12,                // Frames to store for rollback
  ROLLBACK_POS_THRESHOLD: 0.5,             // Position diff to trigger rollback
  ROLLBACK_VEL_THRESHOLD: 5,               // Velocity diff to trigger rollback
  ROLLBACK_BLEND_FRAMES: 4,                // Frames to blend correction
  
  // Ball Prediction Engine - Input Prediction
  INPUT_LOOKAHEAD_FRAMES: 3,               // Frames of input prediction lookahead
  INPUT_CONFIDENCE_DECAY: 0.8,             // Per-frame input confidence decay
}
