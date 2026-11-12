import { LAST_CAMPAIGN_DATE } from './campaign.js';
import { isOnChart, isWater } from './chart.js';
import { updateCombat } from './combat.js';
import { compartmentEfficiency, updateDamageControl } from './damageControl.js';
import { advancePosition, bearingDelta, bearingTo, distanceTo, moveToward, SECONDS_PER_HOUR, wrapHeading } from './navigation.js';
import { inspectNearbyQShips } from './sensors.js';
import { updateFleet } from './ships.js';
import { TELEGRAPH } from './state.js';
import { updateDive } from './submarines.js';
import { weatherAt } from './weather.js';

export { distanceTo, sampleLeg } from './navigation.js';
export { sinkShip } from './ships.js';

const STEP_SECONDS = 0.1;
const MAX_FRAME_SECONDS = 0.25;
const ARRIVAL_DISTANCE_NM = 0.12;

function serviceWaypoints(state) {
  while (state.waypoints.length && distanceTo(state.boat.position, state.waypoints[0]) <= ARRIVAL_DISTANCE_NM) {
    state.waypoints.shift();
    if (!state.waypoints.length) {
      state.boat.telegraph = 'stop';
      state.navigationNotice = 'Course complete';
    }
  }
}

function updateReserves(boat, sub, surfaced, maxSpeed, seconds) {
  if (boat.speed === 0) return;

  const { resources } = sub;
  const hours = seconds / SECONDS_PER_HOUR;
  const load = boat.speed / maxSpeed;
  if (surfaced && boat.diesel > 0) {
    // Apply the class rates to the prototype's normalized consumption curves.
    boat.diesel = Math.max(0, boat.diesel - (0.8 + 8 * load ** 2) / 100 * resources.maxDieselLiters * resources.fuelBurnRateFull * hours);
    const charge = (4 + 10 * load) / 100 * resources.maxBatteryCapacity * resources.batteryRechargeRate * hours;
    boat.battery = Math.min(resources.maxBatteryCapacity, boat.battery + charge * compartmentEfficiency(sub, 'engine'));
  } else if (!surfaced) {
    boat.battery = Math.max(0, boat.battery - (2 + 26 * load ** 2) / 100 * resources.maxBatteryCapacity * resources.batteryDrainRateFull * hours);
  }
}

export function speedLimit({ boat, sub }) {
  const rated = boat.depth === 0 ? sub.speeds.maxSurfaceKnots : sub.speeds.maxSubmergedKnots;
  return rated * compartmentEfficiency(sub, 'engine');
}

function updateBoat(state, seconds) {
  const { boat, sub, waypoints } = state;
  if (boat.hull === 0) return;
  updateDive(state, seconds);
  if (boat.hull === 0) return;
  serviceWaypoints(state);

  const surfaced = boat.depth === 0;
  const maxSpeed = speedLimit(state);
  const hasPower = (surfaced ? boat.diesel : boat.battery) > 0;
  const targetSpeed = hasPower ? maxSpeed * TELEGRAPH[boat.telegraph] : 0;
  const acceleration = targetSpeed > boat.speed ? 0.35 : 0.55;
  boat.speed = Math.min(maxSpeed, moveToward(boat.speed, targetSpeed, acceleration * seconds));
  if (boat.speed === 0) return;

  if (waypoints.length) {
    const desired = bearingTo(boat.position, waypoints[0]);
    const turn = bearingDelta(boat.heading, desired);
    const maxTurn = sub.maneuverability.turnRateDegPerSec * seconds;
    boat.heading = wrapHeading(boat.heading + moveToward(0, turn, maxTurn));
  }

  // Speed in knots times simulated hours gives nautical miles traveled.
  const next = advancePosition(boat.position, boat.heading, boat.speed * seconds / SECONDS_PER_HOUR);
  if (!isWater(next)) {
    boat.speed = 0;
    boat.telegraph = 'stop';
    waypoints.length = 0;
    state.navigationNotice = isOnChart(next) ? 'Stopped at coast' : 'Stopped at chart limit';
    return;
  }

  boat.position = next;
  updateReserves(boat, sub, surfaced, maxSpeed, seconds);
  serviceWaypoints(state);
}

export function stepSimulation(state, seconds = STEP_SECONDS) {
  const remaining = (LAST_CAMPAIGN_DATE - state.patrolStart) / 1000 - state.elapsed;
  if (remaining <= 0) return;
  seconds = Math.min(seconds, remaining);
  state.elapsed += seconds;
  state.weather = weatherAt(state.elapsed);
  updateBoat(state, seconds);
  updateDamageControl(state, seconds);
  inspectNearbyQShips(state);
  updateFleet(state, seconds);
  updateCombat(state, seconds);
}

export function startSimulation(state, drawFrame, isPaused = () => false) {
  let previousTime;
  let accumulator = 0;
  let frameId;
  let stopped = false;

  function frame(now) {
    if (stopped) return;
    if (isPaused()) {
      previousTime = undefined;
    } else {
      if (previousTime !== undefined) {
        const realSeconds = Math.min((now - previousTime) / 1000, MAX_FRAME_SECONDS);
        accumulator += realSeconds * state.timeScale;
        // Compression adds more ticks. It never increases the physics step size.
        while (accumulator >= STEP_SECONDS) {
          stepSimulation(state);
          accumulator -= STEP_SECONDS;
        }
      }
      previousTime = now;
    }

    drawFrame();
    if (!stopped) frameId = requestAnimationFrame(frame);
  }

  frameId = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(frameId);
  };
}
