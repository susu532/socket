/**
 * GoalNetBoundaryEnforcer.js
 * 
 * Manual Boundary Enforcement Zone Detection and Smart Clamping
 * for goal net walls at z=±2.6 to prevent ball from crossing through.
 * 
 * This module provides robust boundary detection and position correction
 * for both server-side physics and client-side prediction.
 */

import { PHYSICS } from '../schema/PhysicsConstants.js'

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDARY CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const GOAL_NET_BOUNDARY = {
  // Goal net side wall Z position (posts at ±2.5, walls at ±2.6 for safety margin)
  SIDE_WALL_Z: 2.6,
  
  // Goal opening detection
  GOAL_LINE_X: 10.8,       // Where goal opening starts
  GOAL_BACK_X: 17.0,       // Back of goal net
  GOAL_HEIGHT: 4.0,        // Goal net height
  
  // Arena bounds
  ARENA_HALF_WIDTH: 14.5,
  ARENA_HALF_DEPTH: 9.5,
  
  // Smart clamping parameters
  CLAMP_MARGIN: 0.02,      // Small margin to prevent edge sticking
  PENETRATION_THRESHOLD: 0.001,  // Minimum penetration to trigger correction
  VELOCITY_DAMPING: 0.85,  // Velocity reduction on boundary collision
  
  // Zone transition smoothing
  TRANSITION_ZONE: 0.5,    // Width of zone for smooth transitions
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONE DETECTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determines which zone the ball is in for boundary enforcement.
 * @param {Object} pos - Position {x, y, z}
 * @param {number} ballRadius - Ball radius
 * @returns {Object} Zone information
 */
function detectBallZone(pos, ballRadius) {
  const absX = Math.abs(pos.x)
  const absZ = Math.abs(pos.z)
  
  const isPastGoalLine = absX > GOAL_NET_BOUNDARY.GOAL_LINE_X
  const isDeepInGoal = absX > GOAL_NET_BOUNDARY.ARENA_HALF_WIDTH
  const isWithinGoalWidth = absZ < GOAL_NET_BOUNDARY.SIDE_WALL_Z
  const isBelowGoalHeight = pos.y < GOAL_NET_BOUNDARY.GOAL_HEIGHT
  
  // Determine which goal (left = -X, right = +X)
  const goalSide = pos.x > 0 ? 'right' : 'left'
  
  return {
    // Main zone classifications
    isInMainArena: !isPastGoalLine,
    isInGoalOpening: isPastGoalLine && isWithinGoalWidth && isBelowGoalHeight,
    isInGoalNet: isDeepInGoal && isWithinGoalWidth,
    isDeepInGoal: isDeepInGoal,
    
    // Boundary proximity
    isPastGoalLine: isPastGoalLine,
    isWithinGoalWidth: isWithinGoalWidth,
    isBelowGoalHeight: isBelowGoalHeight,
    
    // Goal side
    goalSide: goalSide,
    
    // Distance to boundaries (for smart clamping)
    distToGoalSideWall: GOAL_NET_BOUNDARY.SIDE_WALL_Z - absZ,
    distToGoalBack: GOAL_NET_BOUNDARY.GOAL_BACK_X - absX,
    distToArenaWall: GOAL_NET_BOUNDARY.ARENA_HALF_WIDTH - absX,
    distToArenaSideWall: GOAL_NET_BOUNDARY.ARENA_HALF_DEPTH - absZ,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SMART CLAMPING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Smart clamp a value to a boundary with velocity correction.
 * Returns both the clamped position and corrected velocity.
 * @param {number} value - Current position value
 * @param {number} velocity - Current velocity
 * @param {number} minBound - Minimum boundary
 * @param {number} maxBound - Maximum boundary
 * @param {number} restitution - Bounce restitution factor
 * @returns {Object} {position, velocity, wasCorrect}
 */
function smartClamp(value, velocity, minBound, maxBound, restitution = 0.5) {
  let correctedPos = value
  let correctedVel = velocity
  let wasCorrected = false
  
  if (value < minBound) {
    correctedPos = minBound + GOAL_NET_BOUNDARY.CLAMP_MARGIN
    correctedVel = Math.abs(velocity) * restitution
    wasCorrected = true
  } else if (value > maxBound) {
    correctedPos = maxBound - GOAL_NET_BOUNDARY.CLAMP_MARGIN
    correctedVel = -Math.abs(velocity) * restitution
    wasCorrected = true
  }
  
  return { position: correctedPos, velocity: correctedVel, wasCorrected }
}

/**
 * Smart clamp specifically for Z-axis in goal net zone (z=±2.6).
 * Uses higher restitution for bouncy net feel.
 * @param {number} z - Current Z position
 * @param {number} vz - Current Z velocity
 * @param {number} ballRadius - Ball radius
 * @param {number} goalRestitution - Goal net bounce factor
 * @returns {Object} {z, vz, wasCorrected}
 */
function smartClampGoalNetZ(z, vz, ballRadius, goalRestitution = 1.5) {
  const limit = GOAL_NET_BOUNDARY.SIDE_WALL_Z - ballRadius
  let correctedZ = z
  let correctedVz = vz
  let wasCorrected = false
  
  if (z > limit) {
    correctedZ = limit - GOAL_NET_BOUNDARY.CLAMP_MARGIN
    correctedVz = -Math.abs(vz) * goalRestitution
    wasCorrected = true
  } else if (z < -limit) {
    correctedZ = -limit + GOAL_NET_BOUNDARY.CLAMP_MARGIN
    correctedVz = Math.abs(vz) * goalRestitution
    wasCorrected = true
  }
  
  return { z: correctedZ, vz: correctedVz, wasCorrected }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN BOUNDARY ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main boundary enforcement function.
 * Enforces all boundaries with zone-aware smart clamping.
 * 
 * @param {Object} pos - Current position {x, y, z}
 * @param {Object} vel - Current velocity {x, y, z}
 * @param {number} ballRadius - Ball radius
 * @param {Object} physicsConstants - Optional physics constants override
 * @returns {Object} {correctedPos, correctedVel, corrections}
 */
function enforceGoalNetBoundaries(pos, vel, ballRadius, physicsConstants = null) {
  const P = physicsConstants || PHYSICS || {}
  
  // Use provided constants or fallbacks
  const WALL_RESTITUTION = P.WALL_RESTITUTION || 0.3
  const GOAL_RESTITUTION = P.GOAL_RESTITUTION || 1.5
  const GROUND_RESTITUTION = P.GROUND_RESTITUTION || 0.9
  const WALL_HEIGHT = P.WALL_HEIGHT || 10
  
  // Initialize output
  let correctedPos = { x: pos.x, y: pos.y, z: pos.z }
  let correctedVel = { x: vel.x, y: vel.y, z: vel.z }
  const corrections = {
    x: false,
    y: false,
    z: false,
    zone: null,
    penetrationDepth: { x: 0, y: 0, z: 0 }
  }
  
  // Detect current zone
  const zone = detectBallZone(pos, ballRadius)
  corrections.zone = zone
  
  // Effective boundaries
  const maxX = GOAL_NET_BOUNDARY.ARENA_HALF_WIDTH - ballRadius
  const maxZ = GOAL_NET_BOUNDARY.ARENA_HALF_DEPTH - ballRadius
  const goalSideLimit = GOAL_NET_BOUNDARY.SIDE_WALL_Z - ballRadius
  const goalBackLimit = GOAL_NET_BOUNDARY.GOAL_BACK_X - ballRadius
  
  // ═══════════════════════════════════════════════════════════════════
  // Z-AXIS ENFORCEMENT (Goal Net Side Walls at z=±2.6)
  // ═══════════════════════════════════════════════════════════════════
  
  if (zone.isDeepInGoal) {
    // Ball is deep in goal extension (x > 14.5)
    // CRITICAL: Must stay within goal net width (z=±2.6)
    
    if (Math.abs(pos.z) > goalSideLimit) {
      // Ball is outside the goal net width while deep in goal area
      // This is the primary case this module handles
      
      if (zone.isWithinGoalWidth) {
        // Ball just barely crossed - clamp Z to goal net side wall
        const zResult = smartClampGoalNetZ(pos.z, vel.z, ballRadius, GOAL_RESTITUTION)
        correctedPos.z = zResult.z
        correctedVel.z = zResult.vz
        corrections.z = zResult.wasCorrected
        corrections.penetrationDepth.z = Math.abs(pos.z) - goalSideLimit
      } else {
        // Ball has significantly penetrated through goal net wall
        // Push back to arena boundary instead (prevents getting stuck behind net)
        const xSign = Math.sign(pos.x)
        correctedPos.x = xSign * maxX
        correctedVel.x = -Math.sign(vel.x) * Math.abs(vel.x) * WALL_RESTITUTION
        corrections.x = true
        corrections.penetrationDepth.x = Math.abs(pos.x) - maxX
      }
    } else {
      // Ball is within goal net width - enforce side walls normally
      const zResult = smartClampGoalNetZ(pos.z, vel.z, ballRadius, GOAL_RESTITUTION)
      if (zResult.wasCorrected) {
        correctedPos.z = zResult.z
        correctedVel.z = zResult.vz
        corrections.z = true
        corrections.penetrationDepth.z = Math.abs(pos.z) - goalSideLimit
      }
    }
  } else {
    // Ball is in main arena - enforce arena side walls
    if (pos.z > maxZ) {
      correctedPos.z = maxZ - GOAL_NET_BOUNDARY.CLAMP_MARGIN
      correctedVel.z = -Math.abs(vel.z) * WALL_RESTITUTION
      corrections.z = true
      corrections.penetrationDepth.z = pos.z - maxZ
    } else if (pos.z < -maxZ) {
      correctedPos.z = -maxZ + GOAL_NET_BOUNDARY.CLAMP_MARGIN
      correctedVel.z = Math.abs(vel.z) * WALL_RESTITUTION
      corrections.z = true
      corrections.penetrationDepth.z = -pos.z - maxZ
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // X-AXIS ENFORCEMENT (Goal Back Wall and Arena Walls)
  // ═══════════════════════════════════════════════════════════════════
  
  if (zone.isInGoalOpening || zone.isDeepInGoal) {
    // Ball is in goal area - clamp to goal back wall
    if (pos.x > goalBackLimit) {
      correctedPos.x = goalBackLimit - GOAL_NET_BOUNDARY.CLAMP_MARGIN
      correctedVel.x = -Math.abs(vel.x) * GOAL_RESTITUTION
      corrections.x = true
      corrections.penetrationDepth.x = pos.x - goalBackLimit
    } else if (pos.x < -goalBackLimit) {
      correctedPos.x = -goalBackLimit + GOAL_NET_BOUNDARY.CLAMP_MARGIN
      correctedVel.x = Math.abs(vel.x) * GOAL_RESTITUTION
      corrections.x = true
      corrections.penetrationDepth.x = -pos.x - goalBackLimit
    }
  } else {
    // Ball is in main arena - enforce arena walls
    if (pos.x > maxX) {
      correctedPos.x = maxX - GOAL_NET_BOUNDARY.CLAMP_MARGIN
      correctedVel.x = -Math.abs(vel.x) * WALL_RESTITUTION
      corrections.x = true
      corrections.penetrationDepth.x = pos.x - maxX
    } else if (pos.x < -maxX) {
      correctedPos.x = -maxX + GOAL_NET_BOUNDARY.CLAMP_MARGIN
      correctedVel.x = Math.abs(vel.x) * WALL_RESTITUTION
      corrections.x = true
      corrections.penetrationDepth.x = -pos.x - maxX
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // Y-AXIS ENFORCEMENT (Floor and Ceiling)
  // ═══════════════════════════════════════════════════════════════════
  
  if (pos.y < ballRadius) {
    correctedPos.y = ballRadius + GOAL_NET_BOUNDARY.CLAMP_MARGIN
    correctedVel.y = Math.abs(vel.y) * GROUND_RESTITUTION
    corrections.y = true
    corrections.penetrationDepth.y = ballRadius - pos.y
  } else if (pos.y > WALL_HEIGHT - ballRadius) {
    correctedPos.y = WALL_HEIGHT - ballRadius - GOAL_NET_BOUNDARY.CLAMP_MARGIN
    correctedVel.y = -Math.abs(vel.y) * 0.1
    corrections.y = true
    corrections.penetrationDepth.y = pos.y - (WALL_HEIGHT - ballRadius)
  }
  
  return {
    correctedPos,
    correctedVel,
    corrections,
    needsCorrection: corrections.x || corrections.y || corrections.z
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTINUOUS COLLISION DETECTION (CCD) FOR HIGH-SPEED BALLS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Performs swept boundary check to detect if ball will cross goal net wall
 * during a single timestep (prevents tunneling at high speeds).
 * 
 * @param {Object} startPos - Start position {x, y, z}
 * @param {Object} endPos - End position {x, y, z}
 * @param {number} ballRadius - Ball radius
 * @returns {Object|null} Collision info or null if no collision
 */
function sweepGoalNetBoundary(startPos, endPos, ballRadius) {
  const startZone = detectBallZone(startPos, ballRadius)
  const endZone = detectBallZone(endPos, ballRadius)
  const goalSideLimit = GOAL_NET_BOUNDARY.SIDE_WALL_Z - ballRadius
  
  // Check if ball is crossing goal net side wall at z=±2.6
  if (startZone.isDeepInGoal || endZone.isDeepInGoal) {
    // Check positive Z wall crossing
    if (startPos.z < goalSideLimit && endPos.z > goalSideLimit) {
      // Calculate exact crossing time
      const t = (goalSideLimit - startPos.z) / (endPos.z - startPos.z)
      if (t >= 0 && t <= 1) {
        return {
          t: t,
          normal: { x: 0, y: 0, z: -1 },
          wall: 'goal_net_z_positive',
          crossingPoint: {
            x: startPos.x + t * (endPos.x - startPos.x),
            y: startPos.y + t * (endPos.y - startPos.y),
            z: goalSideLimit
          }
        }
      }
    }
    
    // Check negative Z wall crossing
    if (startPos.z > -goalSideLimit && endPos.z < -goalSideLimit) {
      const t = (-goalSideLimit - startPos.z) / (endPos.z - startPos.z)
      if (t >= 0 && t <= 1) {
        return {
          t: t,
          normal: { x: 0, y: 0, z: 1 },
          wall: 'goal_net_z_negative',
          crossingPoint: {
            x: startPos.x + t * (endPos.x - startPos.x),
            y: startPos.y + t * (endPos.y - startPos.y),
            z: -goalSideLimit
          }
        }
      }
    }
  }
  
  return null
}

/**
 * Applies CCD correction to prevent tunneling through goal net walls.
 * 
 * @param {Object} pos - Current position {x, y, z}
 * @param {Object} vel - Current velocity {x, y, z}
 * @param {number} dt - Timestep
 * @param {number} ballRadius - Ball radius
 * @param {number} restitution - Bounce restitution
 * @returns {Object} {pos, vel, collision}
 */
function applyCCDBoundaryCorrection(pos, vel, dt, ballRadius, restitution = 1.5) {
  const endPos = {
    x: pos.x + vel.x * dt,
    y: pos.y + vel.y * dt,
    z: pos.z + vel.z * dt
  }
  
  const collision = sweepGoalNetBoundary(pos, endPos, ballRadius)
  
  if (collision) {
    // Calculate position at collision time
    const collisionPos = collision.crossingPoint
    
    // Reflect velocity off the wall normal
    const dotProduct = vel.x * collision.normal.x + 
                       vel.y * collision.normal.y + 
                       vel.z * collision.normal.z
    
    const reflectedVel = {
      x: vel.x - 2 * dotProduct * collision.normal.x,
      y: vel.y - 2 * dotProduct * collision.normal.y,
      z: vel.z - 2 * dotProduct * collision.normal.z
    }
    
    // Apply restitution
    reflectedVel.x *= restitution
    reflectedVel.y *= restitution
    reflectedVel.z *= restitution
    
    // Calculate remaining time after collision
    const remainingDt = dt * (1 - collision.t)
    
    // Continue motion with reflected velocity
    const finalPos = {
      x: collisionPos.x + reflectedVel.x * remainingDt,
      y: collisionPos.y + reflectedVel.y * remainingDt,
      z: collisionPos.z + reflectedVel.z * remainingDt
    }
    
    return {
      pos: finalPos,
      vel: reflectedVel,
      collision: collision
    }
  }
  
  return {
    pos: endPos,
    vel: vel,
    collision: null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Constants
  GOAL_NET_BOUNDARY,
  
  // Zone detection
  detectBallZone,
  
  // Smart clamping utilities
  smartClamp,
  smartClampGoalNetZ,
  
  // Main enforcement
  enforceGoalNetBoundaries,
  
  // CCD for high-speed balls
  sweepGoalNetBoundary,
  applyCCDBoundaryCorrection,
}
