import { campaignTime } from './campaign.js';
import { isWater } from './chart.js';
import { availableInYear, GAME_DATA } from './dataLoader.js';
import {
  advancePosition, bearingDelta, bearingTo, distanceTo, hasWaterLine, METERS_PER_NM, moveToward, SECONDS_PER_HOUR, wrapHeading,
} from './navigation.js';
import { isBoatExposed, PERISCOPE_DEPTH } from './submarines.js';
import { torpedoModel, wakeLength, wakePoint } from './torpedoes.js';
import { sightMultiplier } from './weather.js';

const rosterById = new Map(GAME_DATA.ships.map((vessel) => [vessel.id, vessel]));

// The roster supplies vessel capabilities. These settings cover AI behavior and gun ballistics.
const VESSEL_TUNING = {
  freighter: {
    rosterId: 'tramp_steamer', flag: 'British', role: 'evade', cruise: 10, flank: 13, turnRate: 1, lookout: 33,
    hitRadius: 0.075,
  },
  armedMerchant: {
    rosterId: 'defensively_armed_merchant',
    label: 'Armed Merchant', flag: 'British', role: 'evade', cruise: 11, flank: 14, turnRate: 1, lookout: 35,
    hitRadius: 0.08,
    gun: { range: 3.6, reload: 13, damage: 13 },
  },
  transport: {
    rosterId: 'troop_transport',
    label: 'Troop Transport', flag: 'British', role: 'evade', cruise: 15, flank: 20, turnRate: 1.2, lookout: 42,
    hitRadius: 0.1, gun: { range: 4.4, reload: 15, damage: 16 },
  },
  neutral: {
    rosterId: 'neutral_freighter',
    label: 'Neutral Merchant', flag: 'Neutral', role: 'evade', cruise: 11, flank: 14, turnRate: 1, lookout: 38,
    hitRadius: 0.075,
  },
  qShip: {
    rosterId: 'q_ship_decoy',
    label: 'Q-Ship', flag: 'Royal Navy', role: 'ambush', cruise: 10, flank: 14, turnRate: 1.2, lookout: 42,
    hitRadius: 0.08, revealRange: 800 / METERS_PER_NM,
    gun: { range: 4.2, reload: 10, damage: 16 },
  },
  destroyer: {
    rosterId: 'royal_navy_destroyer',
    label: 'Destroyer Escort', flag: 'Royal Navy', role: 'hunt', cruise: 17, flank: 30, turnRate: 2.3, lookout: 52,
    hitRadius: 0.055,
    gun: { range: 5, reload: 9, damage: 20 },
  },
  sloop: {
    rosterId: 'flower_class_sloop', flag: 'Royal Navy', role: 'hunt', cruise: 12, turnRate: 1.7, lookout: 42,
    hitRadius: 0.055, gun: { range: 4, reload: 12, damage: 15 },
  },
  cruiser: {
    rosterId: 'armored_cruiser', flag: 'Royal Navy', role: 'hunt', cruise: 16, turnRate: 0.85, lookout: 55,
    hitRadius: 0.1, gun: { range: 6, reload: 17, damage: 28 },
  },
};

export const VESSEL_TYPES = Object.freeze(Object.fromEntries(Object.entries(VESSEL_TUNING).map(([type, tuning]) => {
  const { name, tonnage, apparentType, acousticSignature, visibilityRadius, category, maxSpeedKnots, hullPoints, behavior, armament } = rosterById.get(tuning.rosterId);
  return [type, {
    ...tuning, label: tuning.label ?? name, tonnage, apparentType, acousticSignature, visibilityRadius, category,
    cruise: Math.min(tuning.cruise, maxSpeedKnots), flank: maxSpeedKnots, hull: hullPoints,
    armed: armament.hasDeckGun, depthCharges: armament.depthCharges, diplomaticPenalty: behavior.diplomaticPenalty,
    isQShip: behavior.isQShip, surrendersToWarningShot: behavior.surrendersToWarningShot,
  }];
})));

const profilesById = new Map(Object.values(VESSEL_TYPES).map((profile) => [profile.rosterId, profile]));

export function apparentShipType(ship) {
  const profile = VESSEL_TYPES[ship.type];
  return profile.isQShip && !ship.revealed ? profilesById.get(profile.apparentType) : profile;
}

export const SHIPPING_LANES = Object.freeze({
  western: [
    [-24.7, 51.7], [-20, 51.9], [-14.6, 52], [-10.7, 51.4], [-7.3, 49.7], [-4, 49.72], [-1.2, 50],
  ],
  northern: [
    [-24.7, 56], [-19, 56.3], [-11.5, 57.1], [-8.7, 58.4], [-6, 59.65], [-3, 59.75],
    [-0.1, 59.75], [1.3, 57.8], [4.3, 55.4], [6.7, 54.7],
  ],
  southern: [
    [-24.7, 47.35], [-19, 47], [-13.1, 46.8], [-9, 46.4], [-6, 46.2], [-3.2, 46.45],
  ],
});

const ROUTES = Object.fromEntries(Object.entries(SHIPPING_LANES).map(([name, points]) => (
  [name, points.map(([lon, lat]) => ({ lon, lat }))]
)));

// Each vessel starts partway along a lane so the first watch already has traffic in both directions.
const TRAFFIC = [
  { id: 'western-freighter', name: 'SS Merrow', type: 'freighter', lane: 'western', leg: 1, position: { lon: -17.179, lat: 51.508 }, direction: 1 },
  { id: 'western-neutral', name: 'SS Fjordholm', type: 'neutral', lane: 'western', leg: 1, progress: 0.44, direction: -1 },
  { id: 'western-transport', name: 'HMT Westmere', type: 'transport', lane: 'western', leg: 1, progress: 0.76, direction: 1 },
  { id: 'western-escort', name: 'HMS Bracken', type: 'destroyer', escortFor: 'western-transport' },
  { id: 'western-decoy', name: 'SS Carrow', type: 'qShip', lane: 'western', leg: 1, position: { lon: -17.072, lat: 51.531 }, direction: -1 },
  { id: 'channel-freighter', name: 'SS Alderbank', type: 'armedMerchant', lane: 'western', leg: 5, progress: 0.6, direction: -1 },
  { id: 'northern-freighter', name: 'SS Northwick', type: 'freighter', lane: 'northern', leg: 1, progress: 0.4, direction: 1 },
  { id: 'northern-transport', name: 'HMT Calver', type: 'transport', lane: 'northern', leg: 6, progress: 0.4, direction: -1 },
  { id: 'northern-escort', name: 'HMS Kittiwake', type: 'destroyer', escortFor: 'northern-transport' },
  { id: 'southern-neutral', name: 'SS Vesterhavn', type: 'neutral', lane: 'southern', leg: 1, progress: 0.55, direction: 1 },
  { id: 'southern-decoy', name: 'SS Larkhaven', type: 'qShip', lane: 'southern', leg: 3, progress: 0.35, direction: -1 },
  { id: 'biscay-escort', name: 'HMS Gannet', type: 'destroyer', lane: 'southern', leg: 4, progress: 0.35, direction: -1 },
  { id: 'channel-sloop', name: 'HMS Aster', type: 'sloop', lane: 'western', leg: 4, progress: 0.65, direction: 1 },
  { id: 'north-sea-cruiser', name: 'HMS Resolute', type: 'cruiser', lane: 'northern', leg: 8, progress: 0.5, direction: -1 },
];

const LOOKOUT_INTERVAL = 2;
const THREAT_MEMORY = 180;
const WAYPOINT_RADIUS = 0.35;
const ESCORT_OFFSET = 17;
export const DEPTH_CHARGE_DROP_RANGE = 0.06;

function escortStation(leader) {
  return advancePosition(leader.position, leader.heading - 75, ESCORT_OFFSET);
}

export function createFleet(year) {
  const fleet = [];
  for (const entry of TRAFFIC) {
    const { id, name, type, escortFor } = entry;
    const profile = VESSEL_TYPES[type];
    if (year !== undefined && !availableInYear(rosterById.get(profile.rosterId), year)) continue;
    const leader = escortFor && fleet.find((ship) => ship.id === escortFor);
    let navigation;

    if (leader) {
      const { lane, nextWaypoint, direction, heading, speed } = leader;
      const station = escortStation(leader);
      const position = isWater(station) ? station : advancePosition(leader.position, heading + 180, 1);
      navigation = { lane, nextWaypoint, direction, heading, speed: Math.min(speed, profile.flank), position };
    } else if (escortFor) {
      continue;
    } else {
      const { lane, leg, progress, direction } = entry;
      const [from, to] = ROUTES[lane].slice(leg, leg + 2);
      const position = entry.position ? { ...entry.position }
        : advancePosition(from, bearingTo(from, to), distanceTo(from, to) * progress);
      const nextWaypoint = direction > 0 ? leg + 1 : leg;
      const heading = bearingTo(position, ROUTES[lane][nextWaypoint]);
      navigation = { lane, nextWaypoint, direction, heading, speed: profile.cruise, position };
    }

    fleet.push({
      id, name, type, escortFor, ...navigation, revealed: false, surrendered: false, hull: VESSEL_TYPES[type].hull,
      depthChargesRemaining: profile.depthCharges, nextDepthChargeAt: 0,
      nextLookout: 0, threat: null, wakeThreat: null, activity: leader ? 'Escorting' : 'Underway',
    });
  }
  return fleet;
}

function updateLookout(ship, profile, boat, weather, now) {
  if (now < ship.nextLookout) return;
  ship.nextLookout = now + LOOKOUT_INTERVAL;

  const distance = distanceTo(ship.position, boat.position);
  const exposure = isBoatExposed(boat) ? 1 : boat.depth <= PERISCOPE_DEPTH ? 0.08 : 0;
  const canSee = boat.hull > 0 && exposure > 0 && distance <= profile.lookout * exposure * sightMultiplier(weather)
    && hasWaterLine(ship.position, boat.position);
  const springsAmbush = !profile.isQShip || ship.revealed;

  if (canSee && springsAmbush) {
    ship.threat = { position: { ...boat.position }, until: now + THREAT_MEMORY, seen: true };
  } else if (ship.threat) {
    if (now >= ship.threat.until) ship.threat = null;
    else ship.threat.seen = false;
  }
}

function courseTo(ship, target, speed) {
  return { heading: bearingTo(ship.position, target), speed };
}

function threatCourse(ship, profile, now, submerged) {
  const { position, seen } = ship.threat;
  if (profile.role === 'evade') {
    ship.activity = 'Evading';
    const weave = Math.floor(now / 45) % 2 === 0 ? 24 : -24;
    return { heading: bearingTo(ship.position, position) + 180 + weave, speed: profile.flank };
  }

  ship.activity = seen ? 'Pursuing' : 'Searching';
  const turnAwayRange = submerged && ship.depthChargesRemaining > 0 ? DEPTH_CHARGE_DROP_RANGE / 2 : 0.8;
  if (distanceTo(ship.position, position) <= turnAwayRange) {
    return { heading: ship.heading + 35, speed: profile.cruise * 0.55 };
  }
  return courseTo(ship, position, seen ? profile.flank : profile.cruise);
}

function routeCourse(ship, profile) {
  const route = ROUTES[ship.lane];
  if (distanceTo(ship.position, route[ship.nextWaypoint]) <= WAYPOINT_RADIUS) {
    const next = ship.nextWaypoint + ship.direction;
    if (next < 0 || next >= route.length) ship.direction *= -1;
    ship.nextWaypoint += ship.direction;
  }
  ship.activity = 'Underway';
  return courseTo(ship, route[ship.nextWaypoint], profile.cruise);
}

function sailingCourse(ship, profile, leader, now, submerged) {
  if (leader) {
    ship.direction = leader.direction;
    ship.nextWaypoint = leader.nextWaypoint;
  }
  if (ship.wakeThreat) {
    ship.activity = 'Evading torpedo';
    return { heading: ship.wakeThreat.heading, speed: profile.flank };
  }
  if (ship.threat) return threatCourse(ship, profile, now, submerged);
  if (!leader) return routeCourse(ship, profile);

  const station = escortStation(leader);
  // An escort closes formation near shore if its usual station falls on land.
  const target = isWater(station) ? station : advancePosition(leader.position, leader.heading + 180, 0.4);
  const distance = distanceTo(ship.position, target);
  ship.activity = 'Escorting';
  if (distance <= 0.6) return { heading: leader.heading, speed: leader.speed };
  return courseTo(ship, target, Math.min(profile.flank, leader.speed + distance * 3));
}

function watchForTorpedoes(ship, profile, state) {
  if (ship.wakeThreat?.until > state.elapsed) return;
  ship.wakeThreat = null;
  const alertedWarship = (profile.role === 'hunt' || profile.isQShip) && (ship.threat || ship.attacked || ship.revealed);
  const fastMerchant = profile.role === 'evade' && profile.flank >= 13;
  if (!alertedWarship && !fastMerchant) return;

  for (const torpedo of state.combat.projectiles) {
    if (torpedo.kind !== 'torpedo' || torpedo.traveled <= 0) continue;
    const { bubbleWakeVisibility } = torpedoModel(torpedo.torpedoId).stealth;
    const visibility = 0.48 * bubbleWakeVisibility * sightMultiplier(state.weather);
    const range = distanceTo(torpedo.position, ship.position);
    if (range > visibility || range < profile.hitRadius) continue;
    const relative = bearingDelta(torpedo.bearing, bearingTo(torpedo.position, ship.position));
    if (Math.abs(relative) >= 85) continue;
    const wake = wakePoint(torpedo, wakeLength(torpedo) * 0.2);
    if (distanceTo(wake, ship.position) > visibility || !hasWaterLine(ship.position, wake)) continue;
    ship.wakeThreat = { heading: wrapHeading(torpedo.bearing + (relative >= 0 ? 90 : -90)), until: state.elapsed + 24 };
    return;
  }
}

function clearCourse(position, desired) {
  // Check ahead before turning, then check the actual step for close coastal maneuvers.
  for (const offset of [0, -35, 35, -75, 75, -120, 120, 180]) {
    const heading = desired + offset;
    if (isWater(advancePosition(position, heading, 0.8))) return heading;
  }
  return desired;
}

export function updateFleet(state, seconds) {
  const submerged = !isBoatExposed(state.boat);
  for (const ship of state.ships) {
    if (ship.surrendered) continue;
    const profile = VESSEL_TYPES[ship.type];
    const leader = ship.escortFor && state.ships.find((vessel) => vessel.id === ship.escortFor);
    updateLookout(ship, profile, state.boat, state.weather, state.elapsed);
    watchForTorpedoes(ship, profile, state);
    const course = sailingCourse(ship, profile, leader, state.elapsed, submerged);
    const desired = clearCourse(ship.position, course.heading);
    const turn = bearingDelta(ship.heading, desired);
    ship.heading = wrapHeading(ship.heading + moveToward(0, turn, profile.turnRate * seconds));
    const targetSpeed = Math.abs(turn) > 75 ? Math.min(course.speed, profile.cruise * 0.65) : course.speed;
    ship.speed = moveToward(ship.speed, targetSpeed, 0.24 * seconds);
    const next = advancePosition(ship.position, ship.heading, ship.speed * seconds / SECONDS_PER_HOUR);
    if (isWater(next)) ship.position = next;
  }
}

// A loss or prize is credited once through the same campaign ledger.
export function creditShip(state, shipId, outcome) {
  const index = state.ships.findIndex((ship) => ship.id === shipId);
  if (index === -1) return false;

  const [ship] = state.ships.splice(index, 1);
  const profile = VESSEL_TYPES[ship.type];
  state.diplomaticPenalty += profile.diplomaticPenalty ?? 0;
  if (!profile.diplomaticPenalty) state.crewExperience++;
  state.tonnageSunk += profile.tonnage;
  state.sinkings.push({
    id: ship.id, name: ship.name, label: profile.label, tonnage: profile.tonnage,
    date: new Date(campaignTime(state)).toISOString(), patrol: state.patrolCount, outcome,
  });
  if (state.combat.track?.id === shipId) state.combat.track = null;
  return true;
}

export function sinkShip(state, shipId) {
  return creditShip(state, shipId, 'sunk');
}
