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
  
  // Ball
  BALL_RADIUS: 0.8,
  BALL_MASS: 3.0,
 BALL_RESTITUTION: 0.75,
  BALL_LINEAR_DAMPING: 1.5,
  BALL_ANGULAR_DAMPING: 1.5,
  
  // Restitution
  GROUND_RESTITUTION: 0.9,
  WALL_RESTITUTION: 0.3,
  GOAL_RESTITUTION: 0.6,
  POST_RESTITUTION: 0.3,
  
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
  GOAL_LINE_X: 10.8,

  // Head Stabilization (Bowl Zone)
  HEAD_ZONE_RADIUS: 0.8,        // Wider bowl (was 0.6)
  HEAD_ZONE_HEIGHT: 1.2,        // Height above player where zone starts
  HEAD_ZONE_DEPTH: 0.3,         // How deep the "bowl" is (vertical detection range)
  HEAD_CENTERING_FORCE: 15.0,   // Strong magnet pull (was 3.0)
  HEAD_RIM_FORCE: 30.0,         // Unbreakable containment (was 8.0)
  HEAD_VELOCITY_MATCH: 0.85,     // Perfect 1:1 movement sync (was 0.85)
  HEAD_DAMPING: 8.0,            // Kill all bounce (was 2.0)
}
