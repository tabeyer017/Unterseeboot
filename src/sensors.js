import { bearingDelta, bearingTo, distanceTo, hasWaterLine, wrapHeading } from './navigation.js';
import { compartmentEfficiency } from './damageControl.js';
import { apparentShipType, VESSEL_TYPES } from './ships.js';
import { isBoatExposed } from './submarines.js';
import { sightMultiplier } from './weather.js';

export const HYDROPHONE_HALF_ANGLE = 48;
const MAX_ACOUSTIC_RANGE = Math.max(...Object.values(VESSEL_TYPES).map(({ acousticSignature, flank }) => acousticSignature * flank));

export function hydrophoneAvailable({ boat, sub }) {
  return boat.hull > 0 && sub.sensors.hydrophoneEquipped && !isBoatExposed(boat) && compartmentEfficiency(sub, 'quarters') > 0;
}

function sensorRanges({ boat, sub, weather }) {
  // The periscope is usable at 12 m. The sight circle closes as the scope goes under.
  const sight = boat.depth <= 12 ? 82 - boat.depth * 4.5 : Math.max(0, 28 * (18 - boat.depth) / 6);
  const listening = hydrophoneAvailable({ boat, sub });
  const selfNoise = 1 - 0.28 * Math.min(boat.speed / sub.speeds.maxSubmergedKnots, 1);
  const seaNoise = weather === 'storm' ? 0.8 : 1;
  const acousticFactor = listening ? selfNoise * seaNoise * compartmentEfficiency(sub, 'quarters') : 0;
  return { sight: sight * sightMultiplier(weather), hydrophone: MAX_ACOUSTIC_RANGE * acousticFactor, acousticFactor };
}

function visualContact(ship) {
  const profile = VESSEL_TYPES[ship.type];
  const apparent = apparentShipType(ship);
  return {
    id: ship.id, name: ship.name, position: ship.position, heading: ship.heading, speed: ship.speed,
    type: apparent.rosterId, label: apparent.label, flag: apparent.flag, armed: apparent.armed === true,
    visibilityRadius: apparent.visibilityRadius,
    activity: apparent === profile ? ship.activity : 'Underway', surrendered: ship.surrendered,
  };
}

function canSeeShip(from, to, distance, sight) {
  return sight > 0 && distance <= sight && hasWaterLine(from, to);
}

export function observeShip(state, ship) {
  const { boat } = state;
  const { sight } = sensorRanges(state);
  const distance = distanceTo(boat.position, ship.position);
  return canSeeShip(boat.position, ship.position, distance, sight * apparentShipType(ship).visibilityRadius) ? visualContact(ship) : null;
}

export function inspectNearbyQShips(state) {
  const { boat, ships } = state;
  if (!boat.hull) return;
  const { sight } = sensorRanges(state);
  for (const ship of ships) {
    const profile = VESSEL_TYPES[ship.type];
    if (!profile.isQShip || ship.revealed) continue;
    const distance = distanceTo(boat.position, ship.position);
    if (distance <= profile.revealRange && canSeeShip(boat.position, ship.position, distance, sight)) ship.revealed = true;
  }
}

export function collectContacts(state, { includeVisualBearings = false } = {}) {
  const { boat, ships } = state;
  const ranges = sensorRanges(state);
  const visual = [];
  const bearings = new Set();

  for (const ship of ships) {
    const range = distanceTo(boat.position, ship.position);
    const hearingDistance = VESSEL_TYPES[ship.type].acousticSignature * ship.speed * ranges.acousticFactor;
    if (canSeeShip(boat.position, ship.position, range, ranges.sight * apparentShipType(ship).visibilityRadius)) {
      visual.push(visualContact(ship));
      if (!includeVisualBearings) continue;
    }
    if (hearingDistance > 0 && range <= hearingDistance) {
      const bearing = bearingTo(boat.position, ship.position);
      if (Math.abs(bearingDelta(boat.heading, bearing)) <= HYDROPHONE_HALF_ANGLE
        && hasWaterLine(boat.position, ship.position)) {
        // A hydrophone return carries only a bearing. Nearby returns can merge.
        bearings.add(wrapHeading(Math.round(bearing / 5) * 5));
      }
    }
  }

  return { ranges, visual, bearings: [...bearings] };
}
