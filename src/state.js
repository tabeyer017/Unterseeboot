import { campaignEnded, campaignTime, FIRST_CAMPAIGN_DATE, LAST_CAMPAIGN_DATE } from './campaign.js';
import { isWater } from './chart.js';
import { createCombatState } from './combat.js';
import { createDamageControl } from './damageControl.js';
import { availableInYear, patrolZone } from './dataLoader.js';
import { createFleet } from './ships.js';
import { DEFAULT_SUBMARINE, PERISCOPE_DEPTH, submarineClass } from './submarines.js';
import { weatherAt } from './weather.js';

export const TELEGRAPH = Object.freeze({ stop: 0, slow: 0.25, half: 0.5, full: 0.8, flank: 1 });
export const DEPTHS = Object.freeze({ surface: 0, periscope: PERISCOPE_DEPTH, submerged: 40 });
export const TIME_SCALES = Object.freeze([1, 10, 50]);
export const PATROL_START = Date.UTC(1917, 2, 12, 6, 40);
export const DEFAULT_CAPTAIN = 'Kptlt. von Müller';
export const MAX_CAPTAIN_NAME_LENGTH = 28;
export const FIRST_PATROL_YEAR = new Date(FIRST_CAMPAIGN_DATE).getUTCFullYear();
export const LAST_PATROL_YEAR = new Date(LAST_CAMPAIGN_DATE).getUTCFullYear();
export const DEFAULT_PATROL_ZONE = 'western_approaches';

export function createState(classId = DEFAULT_SUBMARINE, patrolStart = PATROL_START, {
  captainName = DEFAULT_CAPTAIN, patrolZoneId = null,
} = {}) {
  const year = new Date(patrolStart).getUTCFullYear();
  const sub = submarineClass(classId);
  if (!sub || !availableInYear(sub, year)) throw new Error('Submarine class is unavailable for this patrol year.');
  const zone = patrolZone(patrolZoneId);
  if (patrolZoneId !== null && (!zone || !isWater(zone.spawnCoords))) throw new Error('The patrol sector has no valid departure point.');
  const captain = captainName.trim() || DEFAULT_CAPTAIN;
  if (captain.length > MAX_CAPTAIN_NAME_LENGTH) throw new Error(`Captain name must be ${MAX_CAPTAIN_NAME_LENGTH} characters or fewer.`);
  return {
    elapsed: 0,
    patrolStart,
    captainName: captain,
    patrolZoneId,
    patrolCount: 1,
    crewExperience: 0,
    timeScale: 1,
    weather: weatherAt(0),
    ships: createFleet(year),
    diplomaticPenalty: 0,
    tonnageSunk: 0,
    sinkings: [],
    sub: { ...sub, ...createDamageControl() },
    combat: createCombatState(sub, year),
    boat: {
      classId,
      position: zone ? { ...zone.spawnCoords } : { lon: -17.2, lat: 51.5 },
      heading: 62,
      depth: 0,
      targetDepth: DEPTHS.surface,
      blowingBallast: false,
      compressedAir: 100,
      ballastHoldSeconds: 0,
      speed: sub.speeds.maxSurfaceKnots * TELEGRAPH.half,
      telegraph: 'half',
      diesel: sub.resources.maxDieselLiters * 0.86,
      battery: sub.resources.maxBatteryCapacity * 0.72,
      hull: 100,
    },
    waypoints: [],
    navigationNotice: '',
  };
}

export function createConfiguredPatrol({ captainName, year, uboatClassId, patrolZoneId }) {
  if (!Number.isInteger(year) || year < FIRST_PATROL_YEAR || year > LAST_PATROL_YEAR) {
    throw new Error(`Choose a year from ${FIRST_PATROL_YEAR} to ${LAST_PATROL_YEAR}.`);
  }
  if (!patrolZoneId) throw new Error('Choose a patrol sector.');
  const departure = Date.UTC(year, year === FIRST_PATROL_YEAR ? 7 : 2, 12, 6, 40);
  const patrol = createState(uboatClassId, departure, { captainName, patrolZoneId });
  patrol.boat.targetDepth = DEPTHS.periscope;
  return patrol;
}

export function startNextPatrol(state, classId = state.boat.classId, patrolStart = campaignTime(state)) {
  const sub = submarineClass(classId);
  if (campaignEnded(state) || !Number.isFinite(patrolStart) || patrolStart < campaignTime(state) || patrolStart > LAST_CAMPAIGN_DATE
    || !sub || !availableInYear(sub, new Date(patrolStart).getUTCFullYear())) return false;

  Object.assign(state, createState(classId, patrolStart, { captainName: state.captainName, patrolZoneId: state.patrolZoneId }), {
    patrolCount: state.patrolCount + 1,
    crewExperience: state.crewExperience,
    tonnageSunk: state.tonnageSunk,
    diplomaticPenalty: state.diplomaticPenalty,
    sinkings: state.sinkings,
  });
  return true;
}

export const state = createState();

