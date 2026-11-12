import { bearingDelta, bearingTo, distanceTo } from './navigation.js';

export const COMPARTMENTS = Object.freeze([
  { id: 'bow', name: 'Bow Torpedo Room', label: 'Bow', system: 'Bow reload speed' },
  { id: 'quarters', name: "Officers’ Quarters & Hydrophone Station", label: 'Quarters', system: 'Hydrophone range' },
  { id: 'control', name: 'Central Control Room', label: 'Control', system: 'Depth control' },
  { id: 'engine', name: 'Diesel & Electric Engine Room', label: 'Engines', system: 'Speed & battery recharge' },
  { id: 'stern', name: 'Stern Torpedo Room', label: 'Stern', system: 'Stern reload speed' },
]);
export const CREW_SQUADS = Object.freeze(['A', 'B', 'C', 'D']);
export const CHLORINE_DANGER = 35;
export const TRIM_SPEED_KNOTS = 5;
const PUMP_BATTERY_PERCENT_PER_SECOND = 0.32;
const PUMP_WATER_PERCENT_PER_SECOND = 1.1;
const clampPercent = (value) => Math.max(0, Math.min(100, value));

export function createDamageControl() {
  return {
    compartments: Object.fromEntries(COMPARTMENTS.map(({ id }) => [id, {
      floodingLevel: 0, mechanicalDamage: 0, chlorineGasLevel: 0,
    }])),
    crewSquads: CREW_SQUADS.map(() => ({ assignment: null, fatigue: 0, chlorineExposure: 0, incapacitated: false })),
    bilgePumpOn: false,
    ventilating: false,
  };
}

export function compartmentEfficiency(sub, id) {
  const room = sub.compartments?.[id];
  const crew = sub.crewSquads;
  const fitCrew = crew ? crew.filter(({ incapacitated }) => !incapacitated).length / crew.length : 1;
  return (1 - (room?.mechanicalDamage ?? 0) / 100) * fitCrew;
}

export function floodingLoad(sub) {
  if (!sub.compartments) return 0;
  const water = Object.values(sub.compartments).reduce((total, room) => total + room.floodingLevel, 0);
  return water / (100 * COMPARTMENTS.length);
}

export function peakChlorine(sub) {
  return Math.max(...Object.values(sub.compartments).map(({ chlorineGasLevel }) => chlorineGasLevel));
}

export function assignSquad(sub, index, assignment) {
  const squad = sub.crewSquads[index];
  if (!squad || squad.incapacitated || (assignment !== null && !Object.hasOwn(sub.compartments, assignment))) return false;
  squad.assignment = assignment;
  return true;
}

export function canPumpBilges({ boat, sub }) {
  return boat.hull > 0 && boat.battery > 0 && floodingLoad(sub) > 0;
}

export function canVentilate({ boat, sub }) {
  return boat.hull > 0 && boat.depth === 0 && peakChlorine(sub) > 0;
}

export function damageCompartment(sub, id, mechanical, flooding) {
  const room = sub.compartments[id];
  room.mechanicalDamage = clampPercent(room.mechanicalDamage + mechanical);
  room.floodingLevel = clampPercent(room.floodingLevel + flooding);
}

export function impactCompartment(boat, source, random) {
  if (distanceTo(boat.position, source) < 0.015) {
    return COMPARTMENTS[Math.min(COMPARTMENTS.length - 1, Math.floor(random() * COMPARTMENTS.length))].id;
  }
  const angle = bearingDelta(boat.heading, bearingTo(boat.position, source)) * Math.PI / 180;
  const position = (1 - Math.cos(angle)) / 2;
  return COMPARTMENTS[Math.min(COMPARTMENTS.length - 1, Math.floor(position * COMPARTMENTS.length))].id;
}

function updatePump(state, seconds) {
  const { boat, sub } = state;
  if (!sub.bilgePumpOn) return;
  if (!canPumpBilges(state)) {
    sub.bilgePumpOn = false;
    return;
  }

  const wet = Object.values(sub.compartments).filter(({ floodingLevel }) => floodingLevel > 0);
  const water = wet.reduce((sum, room) => sum + room.floodingLevel, 0);
  const batteryPerSecond = sub.resources.maxBatteryCapacity * PUMP_BATTERY_PERCENT_PER_SECOND / 100;
  const runTime = Math.min(seconds, water / PUMP_WATER_PERCENT_PER_SECOND, boat.battery / batteryPerSecond);
  const fractionDrained = runTime * PUMP_WATER_PERCENT_PER_SECOND / water;
  for (const room of wet) room.floodingLevel *= Math.max(0, 1 - fractionDrained);
  boat.battery = Math.max(0, boat.battery - batteryPerSecond * runTime);
  if (runTime < seconds || !canPumpBilges(state)) sub.bilgePumpOn = false;
}

function updateGas(state, seconds) {
  const { boat, sub } = state;
  const rooms = COMPARTMENTS.map(({ id }) => sub.compartments[id]);
  const gas = rooms.map(({ chlorineGasLevel }) => chlorineGasLevel);
  const ventilating = sub.ventilating && canVentilate(state);
  const batteryFlooding = sub.compartments.engine.floodingLevel;
  // The battery well starts taking seawater after the engine-room bilge fills.
  const batteryGas = boat.depth > 0 ? Math.max(0, batteryFlooding - 20) * 0.04 : 0;
  for (const [index, room] of rooms.entries()) {
    const local = gas[index];
    const spread = ((gas[index - 1] ?? local) + (gas[index + 1] ?? local) - 2 * local) * 0.025;
    const source = room === sub.compartments.engine ? batteryGas : 0;
    room.chlorineGasLevel = clampPercent(local + (spread + source - (ventilating ? 2.4 : 0)) * seconds);
  }
  sub.ventilating = ventilating && peakChlorine(sub) > 0;
}

function updateSquads(sub, seconds) {
  for (const squad of sub.crewSquads) {
    const room = sub.compartments[squad.assignment ?? 'quarters'];
    const gas = room.chlorineGasLevel;
    if (gas >= CHLORINE_DANGER) {
      squad.chlorineExposure = clampPercent(squad.chlorineExposure + (gas - 25) / 75 * 2.2 * seconds);
    } else if (gas < 15) {
      squad.chlorineExposure = clampPercent(squad.chlorineExposure - 1.1 * seconds);
    }
    if (squad.chlorineExposure >= 100) squad.incapacitated = true;
    if (squad.incapacitated && squad.chlorineExposure <= 35) squad.incapacitated = false;
    if (squad.incapacitated) continue;

    if (squad.assignment === null) {
      if (gas < CHLORINE_DANGER) squad.fatigue = clampPercent(squad.fatigue - 0.48 * seconds);
    } else if (room.mechanicalDamage > 0 || room.floodingLevel > 0) {
      const effort = (1 - squad.fatigue * 0.008) * (1 - gas * 0.008) * seconds;
      room.mechanicalDamage = clampPercent(room.mechanicalDamage - 0.4 * effort);
      room.floodingLevel = clampPercent(room.floodingLevel - 0.66 * effort);
      squad.fatigue = clampPercent(squad.fatigue + 0.33 * seconds);
    }
  }
}

export function updateDamageControl(state, seconds) {
  const { boat, sub } = state;
  if (boat.hull <= 0) {
    sub.bilgePumpOn = false;
    sub.ventilating = false;
    return;
  }
  const leakRate = boat.depth > 0 ? 0.016 : 0.004;
  for (const room of Object.values(sub.compartments)) {
    room.floodingLevel = clampPercent(room.floodingLevel + Math.max(0, room.mechanicalDamage - 25) * leakRate * seconds);
  }
  updatePump(state, seconds);
  updateGas(state, seconds);
  updateSquads(sub, seconds);
  if (sub.bilgePumpOn && !canPumpBilges(state)) sub.bilgePumpOn = false;
}
