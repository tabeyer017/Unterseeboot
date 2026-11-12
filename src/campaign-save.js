import { campaignTime, FIRST_CAMPAIGN_DATE, LAST_CAMPAIGN_DATE } from './campaign.js';
import { isWater } from './chart.js';
import { assignedTorpedoes } from './combat.js';
import { COMPARTMENTS, CREW_SQUADS, createDamageControl } from './damageControl.js';
import { availableInYear, patrolZone } from './dataLoader.js';
import { METERS_PER_NM } from './navigation.js';
import { createFleet, SHIPPING_LANES, VESSEL_TYPES } from './ships.js';
import { DEFAULT_CAPTAIN, MAX_CAPTAIN_NAME_LENGTH, TELEGRAPH, TIME_SCALES } from './state.js';
import { BALLAST_HOLD_SECONDS, DEFAULT_SUBMARINE, submarineClass } from './submarines.js';
import { LEGACY_TORPEDO, patrolTorpedo, torpedoModel } from './torpedoes.js';
import { weatherAt } from './weather.js';

const SAVE_VERSION = 2;
const LEGACY_TORPEDO_CAPACITY = 8;
const LEGACY_SHIP_HULLS = { freighter: 90, armedMerchant: 105, transport: 140, neutral: 90, qShip: 110, destroyer: 110 };
const LEGACY_SHIP_SPEEDS = { freighter: 13, armedMerchant: 14, transport: 20, neutral: 14, qShip: 14, destroyer: 30 };
const fleet = new Map(createFleet().map((ship) => [ship.id, ship]));

function requireValid(condition) {
  if (!condition) throw new Error('The campaign save contains invalid data.');
}

function numberBetween(min, max = Infinity, integer = false) {
  return (value) => {
    requireValid(Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)));
    return value;
  };
}

function oneOf(values) {
  return (value) => {
    requireValid(values.includes(value));
    return value;
  };
}

function text(value) {
  requireValid(typeof value === 'string');
  return value;
}

function readCaptain(value = DEFAULT_CAPTAIN) {
  const name = text(value).trim();
  requireValid(name.length > 0 && name.length <= MAX_CAPTAIN_NAME_LENGTH);
  return name;
}

function readPatrolZone(value = null) {
  requireValid(value === null || Boolean(patrolZone(value)));
  return value;
}

function readFields(value, fields) {
  requireValid(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(fields).map(([key, read]) => [key, read(value[key])]));
}

function readList(read) {
  return (value) => {
    requireValid(Array.isArray(value));
    return value.map(read);
  };
}

const count = numberBetween(0, Infinity, true);
const patrolNumber = numberBetween(1, Infinity, true);
const seconds = numberBetween(0);
const heading = numberBetween(0, 360);
const percent = numberBetween(0, 100);
const boolean = oneOf([true, false]);
const shipId = oneOf([...fleet.keys()]);

function campaignDate(value) {
  requireValid(typeof value === 'string');
  const milliseconds = Date.parse(value);
  requireValid(milliseconds >= FIRST_CAMPAIGN_DATE && milliseconds <= LAST_CAMPAIGN_DATE);
  requireValid(new Date(milliseconds).toISOString() === value);
  return value;
}

function point(value) {
  return readFields(value, { lon: numberBetween(-180, 180), lat: numberBetween(-90, 90) });
}

function waterPoint(value) {
  const position = point(value);
  requireValid(isWater(position));
  return position;
}

function readBoat(value, legacy) {
  const classId = value?.classId ?? DEFAULT_SUBMARINE;
  const profile = submarineClass(classId);
  requireValid(profile);
  const depth = numberBetween(0, profile.maneuverability.crushDepthMeters);
  const speedLimit = value.depth === 0 ? profile.speeds.maxSurfaceKnots : profile.speeds.maxSubmergedKnots;
  const { maxDieselLiters, maxBatteryCapacity } = profile.resources;
  const boat = readFields(value, {
    position: waterPoint, heading, depth, targetDepth: depth, blowingBallast: (flag) => boolean(flag ?? false),
    compressedAir: (air) => percent(air ?? 100), speed: numberBetween(0, legacy ? 16 : speedLimit),
    ballastHoldSeconds: (hold) => numberBetween(0, BALLAST_HOLD_SECONDS)(hold ?? 0),
    telegraph: oneOf(Object.keys(TELEGRAPH)), diesel: legacy ? percent : numberBetween(0, maxDieselLiters),
    battery: legacy ? percent : numberBetween(0, maxBatteryCapacity), hull: percent,
  });
  requireValid(!boat.blowingBallast || (boat.depth > 0 && boat.targetDepth === 0 && boat.hull > 0));
  if (legacy) {
    boat.diesel = boat.diesel / 100 * maxDieselLiters;
    boat.battery = boat.battery / 100 * maxBatteryCapacity;
    boat.speed = Math.min(boat.speed, speedLimit);
  }
  return { classId, ...boat };
}

function readShip(value, legacy) {
  const original = fleet.get(value?.id);
  requireValid(original);
  const { id, name, type, lane, escortFor } = original;
  const profile = VESSEL_TYPES[type];
  const previousHull = legacy ? LEGACY_SHIP_HULLS[type] ?? profile.hull : profile.hull;
  const previousSpeed = legacy ? LEGACY_SHIP_SPEEDS[type] ?? profile.flank : profile.flank;
  const ship = {
    id, name, type, lane, escortFor,
    ...readFields(value, {
      position: waterPoint, heading, speed: numberBetween(0, previousSpeed),
      nextWaypoint: numberBetween(0, SHIPPING_LANES[lane].length - 1, true), direction: oneOf([-1, 1]),
      revealed: boolean, hull: numberBetween(0, previousHull), nextLookout: seconds, activity: text,
      attacked: (flag) => boolean(flag ?? false), gunReadyAt: (time) => time == null ? null : seconds(time),
      depthChargesRemaining: (remaining) => numberBetween(0, profile.depthCharges, true)(remaining ?? profile.depthCharges),
      nextDepthChargeAt: (time) => seconds(time ?? 0),
      surrendered: (flag) => boolean(flag ?? false),
      threat: (threat) => threat === null ? null : readFields(threat, { position: waterPoint, until: seconds, seen: boolean }),
      wakeThreat: (threat) => threat == null ? null : readFields(threat, { heading, until: seconds }),
    }),
  };
  requireValid(ship.hull > 0);
  if (legacy) {
    ship.hull = ship.hull / previousHull * profile.hull;
    ship.speed = Math.min(ship.speed, profile.flank);
  }
  requireValid(!ship.surrendered || (profile.surrendersToWarningShot && !profile.armed && ship.speed === 0));
  return ship;
}

function readProjectile(value, legacy) {
  if (value?.kind === 'torpedo') {
    const torpedoId = legacy ? LEGACY_TORPEDO : value.torpedoId;
    const model = torpedoModel(torpedoId);
    requireValid(model);
    return {
      kind: 'torpedo', torpedoId,
      ...readFields(value, {
        origin: waterPoint, position: waterPoint, bearing: heading,
        traveled: numberBetween(0, model.maxRangeMeters / METERS_PER_NM),
      }),
      ...(torpedoId === LEGACY_TORPEDO ? { legacyDud: boolean(legacy ? value.dud : value.legacyDud) } : {}),
    };
  }

  const shell = readFields(value, {
    kind: oneOf(['shell']), owner: oneOf(['player', 'enemy']), origin: waterPoint, aim: point,
    damage: numberBetween(0), hit: boolean, warning: (flag) => boolean(flag ?? false), launchAt: seconds, impactAt: seconds,
    targetId: (id) => id == null ? null : shipId(id),
  });
  requireValid(shell.impactAt > shell.launchAt && (shell.owner === 'enemy' || shell.targetId));
  requireValid(shell.warning ? shell.owner === 'player' && shell.damage === 0 && !shell.hit : shell.damage > 0);
  return shell;
}

function readTubeTimers(value, armament, torpedoes) {
  const timers = readFields(value, { deck: seconds, bow: (bow) => bow, stern: (stern) => stern });
  const counts = { bow: armament.bowTubes, stern: armament.sternTubes };

  if (!Array.isArray(timers.bow) && !Array.isArray(timers.stern)) {
    // Older saves had one timer per end. Distribute their remaining rounds among the installed tubes.
    const legacy = { bow: seconds(timers.bow), stern: seconds(timers.stern) };
    const order = ['bow', 'stern'].sort((a, b) => legacy[a] - legacy[b]);
    for (const side of order) timers[side] = Array(counts[side]).fill(null);
    let remaining = torpedoes;
    for (let index = 0; index < Math.max(counts.bow, counts.stern) && remaining > 0; index++) {
      for (const side of order) {
        if (index >= counts[side] || !remaining) continue;
        timers[side][index] = legacy[side];
        remaining--;
      }
    }
  } else {
    for (const side of ['bow', 'stern']) {
      requireValid(Array.isArray(timers[side]) && timers[side].length === counts[side]);
      timers[side] = timers[side].map((timer) => timer === null ? null : seconds(timer));
    }
  }

  const assigned = assignedTorpedoes(timers);
  requireValid(assigned <= torpedoes && (!torpedoes || assigned > 0));
  return timers;
}

function readCombat(value, classId, year, legacy) {
  const { armament } = submarineClass(classId);
  const torpedoCapacity = value?.torpedoCapacity ?? LEGACY_TORPEDO_CAPACITY;
  const torpedoId = legacy ? patrolTorpedo(year, armament.torpedoCaliberMm)?.id ?? null : value?.torpedoId;
  const model = torpedoModel(torpedoId);
  requireValid(torpedoId === null ? torpedoCapacity === 0
    : model?.caliberMm === armament.torpedoCaliberMm && availableInYear(model, year)
      && (torpedoCapacity === armament.totalTorpedoes || (classId === DEFAULT_SUBMARINE && torpedoCapacity === LEGACY_TORPEDO_CAPACITY)));
  const combat = readFields(value, {
    shells: numberBetween(0, armament.deckGun.equipped ? armament.deckGun.maxAmmo : 0, true), torpedoes: numberBetween(0, torpedoCapacity, true),
    track: (track) => track === null ? null : readFields(track, {
      id: shipId, name: text, position: waterPoint, heading, speed: seconds,
      label: text, flag: text, armed: boolean, activity: text, observedAt: seconds,
      surrendered: (flag) => boolean(flag ?? false),
    }),
    projectiles: readList((projectile) => readProjectile(projectile, legacy)), report: text,
    depthCharges: (charges) => readList((charge) => readFields(charge, {
      position: waterPoint, depth: seconds, detonatesAt: seconds,
    }))(charges ?? []),
    events: (events) => readList((event) => readFields(event, { elapsed: seconds, message: text }))(events ?? []),
  });
  return { ...combat, torpedoCapacity, torpedoId, readyAt: readTubeTimers(value.readyAt, armament, combat.torpedoes) };
}

function readDamageControl(value) {
  if (value === undefined) return createDamageControl();
  const assignment = oneOf([null, ...COMPARTMENTS.map(({ id }) => id)]);
  const room = (value) => readFields(value, { floodingLevel: percent, mechanicalDamage: percent, chlorineGasLevel: percent });
  const rooms = Object.fromEntries(COMPARTMENTS.map(({ id }) => [id, room]));
  return readFields(value, {
    compartments: (value) => readFields(value, rooms),
    crewSquads: (squads) => {
      requireValid(Array.isArray(squads) && squads.length === CREW_SQUADS.length);
      return squads.map((squad) => readFields(squad, { assignment, fatigue: percent, chlorineExposure: percent, incapacitated: boolean }));
    },
    bilgePumpOn: boolean,
    ventilating: boolean,
  });
}

export function createCampaignSave(state) {
  const { captainName, tonnageSunk, patrolCount, crewExperience, diplomaticPenalty } = state;
  const { elapsed, timeScale, boat, ships, waypoints, navigationNotice, combat, patrolZoneId } = state;
  const { compartments, crewSquads, bilgePumpOn, ventilating } = state.sub;
  const { shells, torpedoes, torpedoCapacity, torpedoId, readyAt, track, projectiles, depthCharges, events, report } = combat;
  return {
    version: SAVE_VERSION,
    campaign: { date: new Date(campaignTime(state)).toISOString(), captainName, tonnageSunk, patrolCount, crewExperience, diplomaticPenalty },
    captainsLog: state.sinkings,
    patrol: {
      elapsed, timeScale, boat, ships, waypoints, navigationNotice, patrolZoneId,
      damageControl: { compartments, crewSquads, bilgePumpOn, ventilating },
      combat: { shells, torpedoes, torpedoCapacity, torpedoId, readyAt, track, projectiles, depthCharges, events, report },
    },
  };
}

export function validateCampaignSave(value) {
  requireValid(value && typeof value === 'object' && !Array.isArray(value));
  const legacy = value.version === 1;
  if (!legacy && value.version !== SAVE_VERSION) throw new Error('This campaign save uses an unsupported version.');

  const campaign = readFields(value.campaign, {
    date: campaignDate, captainName: readCaptain, tonnageSunk: count, patrolCount: patrolNumber, crewExperience: count, diplomaticPenalty: count,
  });
  const captainsLog = readList((entry) => readFields(entry, {
    id: shipId, name: text, label: text, tonnage: numberBetween(1, Infinity, true), date: campaignDate, patrol: patrolNumber,
    outcome: (value) => oneOf(['sunk', 'claimed'])(value ?? 'sunk'),
  }))(value.captainsLog);
  const patrol = readFields(value.patrol, {
    elapsed: seconds, timeScale: oneOf(TIME_SCALES), boat: (boat) => readBoat(boat, legacy),
    ships: readList((ship) => readShip(ship, legacy)),
    waypoints: readList(waterPoint), navigationNotice: text, damageControl: readDamageControl, patrolZoneId: readPatrolZone,
  });
  const start = Date.parse(campaign.date) - Math.round(patrol.elapsed * 1000);
  requireValid(start >= FIRST_CAMPAIGN_DATE);
  patrol.combat = readCombat(value.patrol.combat, patrol.boat.classId, new Date(start).getUTCFullYear(), legacy);

  const activeIds = new Set(patrol.ships.map(({ id }) => id));
  requireValid(activeIds.size === patrol.ships.length);
  if (patrol.combat.track) {
    requireValid(activeIds.has(patrol.combat.track.id) && patrol.combat.track.observedAt <= patrol.elapsed);
  }

  const sunkIds = new Set();
  let tonnage = 0;
  for (const entry of captainsLog) {
    const key = `${entry.patrol}/${entry.id}`;
    requireValid(!sunkIds.has(key) && entry.patrol <= campaign.patrolCount && entry.date <= campaign.date);
    if (entry.patrol === campaign.patrolCount) requireValid(!activeIds.has(entry.id) && Date.parse(entry.date) >= start);
    sunkIds.add(key);
    tonnage += entry.tonnage;
  }
  requireValid(tonnage === campaign.tonnageSunk);
  return { version: SAVE_VERSION, campaign, captainsLog, patrol };
}

export function restoreCampaign(save) {
  const { campaign, captainsLog, patrol } = validateCampaignSave(save);
  const { date, ...progress } = campaign;
  const { damageControl, ...patrolState } = patrol;
  return {
    ...progress,
    ...patrolState,
    sub: { ...submarineClass(patrol.boat.classId), ...damageControl },
    patrolStart: Date.parse(date) - Math.round(patrol.elapsed * 1000),
    weather: weatherAt(patrol.elapsed),
    sinkings: captainsLog,
    combat: { ...patrol.combat, effects: [] },
  };
}
