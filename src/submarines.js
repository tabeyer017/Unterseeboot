import { GAME_DATA } from './dataLoader.js';
import { compartmentEfficiency, damageCompartment, floodingLoad, TRIM_SPEED_KNOTS } from './damageControl.js';
import { moveToward } from './navigation.js';

export const DEFAULT_SUBMARINE = 'type_u_31';
export const PERISCOPE_DEPTH = 12;
export const BALLAST_AIR_COST = 25;
export const BALLAST_HOLD_SECONDS = 90;
const classes = new Map(GAME_DATA.submarines.map((profile) => [profile.id, profile]));
const DEPTH_RATE = 0.6;
const BALLAST_ASCENT_RATE = DEPTH_RATE * 3;

export function submarineClass(classId = DEFAULT_SUBMARINE) {
  return classes.get(classId);
}

export function submarineDesignation(boat) {
  return submarineClass(boat.classId).name.split(' (')[0].replace(/^Type /, '');
}

export function isBoatExposed(boat) {
  return boat.depth < PERISCOPE_DEPTH;
}

export function opticsMode(boat) {
  if (!boat.hull) return null;
  if (boat.depth === 0) return 'binoculars';
  return boat.depth >= 10 && boat.depth <= 14 ? 'periscope' : null;
}

const forwardLift = (boat) => Math.min(1, boat.speed / TRIM_SPEED_KNOTS);

export function depthDrift(boat, sub) {
  if (boat.blowingBallast || (boat.depth === 0 && boat.ballastHoldSeconds > 0)) return 0;
  const control = compartmentEfficiency(sub, 'control');
  const waterWeight = floodingLoad(sub) * 1.45 * (2 - control);
  const trimError = boat.targetDepth > 0 ? Math.min(1, boat.depth / PERISCOPE_DEPTH) * (1 - control) * 0.12 : 0;
  return (waterWeight + trimError) * (1 - forwardLift(boat));
}

function diveEntryRate(boat, sub) {
  return PERISCOPE_DEPTH / sub.maneuverability.diveTimeSec * compartmentEfficiency(sub, 'control') + depthDrift(boat, sub);
}

export function secondsUntilSubmerged(boat, sub = submarineClass(boat.classId)) {
  if (boat.depth >= PERISCOPE_DEPTH) return 0;
  return (PERISCOPE_DEPTH - boat.depth) / diveEntryRate(boat, sub);
}

export function hullStress(boat) {
  const { testDepthMeters, crushDepthMeters } = submarineClass(boat.classId).maneuverability;
  return Math.max(0, Math.min(1, (boat.depth - testDepthMeters) / (crushDepthMeters - testDepthMeters)));
}

export function orderDepth(boat, depth) {
  boat.targetDepth = depth;
  if (depth > 0) {
    boat.blowingBallast = false;
    boat.ballastHoldSeconds = 0;
  }
}

export function canBlowBallast(boat) {
  return boat.hull > 0 && boat.depth > 0 && !boat.blowingBallast && boat.compressedAir >= BALLAST_AIR_COST;
}

export function blowBallast(boat) {
  if (!canBlowBallast(boat)) return false;
  boat.compressedAir -= BALLAST_AIR_COST;
  boat.targetDepth = 0;
  boat.blowingBallast = true;
  return true;
}

export function damageHull(state, damage, lossMessage = `${submarineDesignation(state.boat)} lost`) {
  const { boat, combat, waypoints } = state;
  boat.hull = Math.max(0, boat.hull - damage);
  if (boat.hull > 0) return;

  boat.speed = 0;
  boat.telegraph = 'stop';
  boat.blowingBallast = false;
  boat.ballastHoldSeconds = 0;
  waypoints.length = 0;
  state.navigationNotice = lossMessage;
  combat.report = lossMessage;
}

export function updateDive(state, seconds) {
  const { boat, sub } = state;
  const drift = depthDrift(boat, sub);
  boat.ballastHoldSeconds = Math.max(0, (boat.ballastHoldSeconds ?? 0) - seconds);
  const previousStress = hullStress(boat);
  if (isBoatExposed(boat) && boat.targetDepth >= PERISCOPE_DEPTH) {
    const timeToSubmerge = secondsUntilSubmerged(boat, sub);
    if (timeToSubmerge > seconds + 1e-9) {
      boat.depth += diveEntryRate(boat, sub) * seconds;
      return;
    }
    boat.depth = PERISCOPE_DEPTH;
    seconds = Math.max(0, seconds - timeToSubmerge);
  }

  // In a flooded boat, the diving planes need forward motion to raise the bow.
  const lift = boat.depth > boat.targetDepth && floodingLoad(sub) > 0 ? forwardLift(boat) : 1;
  const rate = boat.blowingBallast ? BALLAST_ASCENT_RATE : DEPTH_RATE * compartmentEfficiency(sub, 'control') * lift;
  const depthChange = rate * seconds;
  boat.depth = Math.abs(boat.depth - boat.targetDepth) <= depthChange + 1e-9
    ? boat.targetDepth : moveToward(boat.depth, boat.targetDepth, depthChange);
  boat.depth = Math.min(sub.maneuverability.crushDepthMeters, boat.depth + drift * seconds);
  if (boat.depth === 0 && boat.blowingBallast) {
    boat.blowingBallast = false;
    boat.ballastHoldSeconds = BALLAST_HOLD_SECONDS;
  }
  const stress = hullStress(boat);
  if (stress >= 1) damageHull(state, boat.hull, 'Hull crushed at depth');
  else if (stress > 0 || previousStress > 0) {
    const damage = seconds * (previousStress ** 2 + stress ** 2);
    damageCompartment(sub, 'control', damage * 0.6, damage * 0.35);
    damageHull(state, damage, 'Hull failed under pressure');
  }
}
