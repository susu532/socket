// Shared physics constants for client and server consistency
export const PHYSICS = {
  TICK_RATE: 120,
  FIXED_TIMESTEP: 1 / 120,
  
  // Gravity
  GRAVITY: 20,          // For players (manual physics)
  WORLD_GRAVITY: 9.81,  // For ball (RAPIER world)
  
  // Player
  MOVE_SPEED: 8,
  JUMP_FORCE: 8,
  DOUBLE_JUMP_MULTIPLIER: 0.8,
  MAX_JUMPS: 2,
  GROUND_Y: 0.1,
  PLAYER_RADIUS: 0.4,
  COYOTE_TIME: 0.1,          // 100ms grace period after leaving ground
  JUMP_BUFFER_TIME: 0.15,    // 150ms pre-land buffer
  
  // Ball
  BALL_RADIUS: 0.8,
  BALL_MASS: 3.0,
  BALL_RESTITUTION: 0.75,
  BALL_RESTITUTION_MIN: 0.5,      // At high speed impacts
  BALL_RESTITUTION_MAX: 0.85,     // At low speed impacts
  BALL_RESTITUTION_SPEED_THRESHOLD: 20, // Speed for min restitution
  BALL_LINEAR_DAMPING: 1.5,
  BALL_ANGULAR_DAMPING: 1.5,
  BALL_GROUND_DAMPING: 3.0,       // Higher drag when rolling on ground
  BALL_AIR_DAMPING: 0.3,          // Lower drag in air
  BALL_AIR_DRAG: 0.0008,          // Quadratic air resistance coefficient
  BALL_GROUND_FRICTION: 2.5,      // Rolling resistance
  
  // Mechanics
  KICK_RANGE: 3.0,
  KICK_POWER: 65,
  KICK_COOLDOWN: 0.2,
  SPECULATIVE_IMPULSE_FACTOR: 0.85,
  
  // Arena
  ARENA_WIDTH: 30,
  ARENA_DEPTH: 20,
  ARENA_HALF_WIDTH: 14.5,
  ARENA_HALF_DEPTH: 9.5,
  GOAL_WIDTH: 5.0,
  GOAL_HEIGHT: 4.0,
  GOAL_DEPTH: 2.0,
  GOAL_LINE_X: 10.8
}
