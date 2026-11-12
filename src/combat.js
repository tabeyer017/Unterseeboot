import { campaignEnded } from './campaign.js';
import { isOnChart, isWater } from './chart.js';
import { compartmentEfficiency, damageCompartment, impactCompartment } from './damageControl.js';
import { advancePosition, bearingDelta, bearingTo, distanceTo, hasWaterLine, METERS_PER_NM, SECONDS_PER_HOUR, wrapHeading } from './navigation.js';
import { observeShip } from './sensors.js';
import { creditShip, DEPTH_CHARGE_DROP_RANGE, sinkShip, VESSEL_TYPES } from './ships.js';
import { damageHull, isBoatExposed, opticsMode, submarineDesignation } from './submarines.js';
import { patrolTorpedo, torpedoModel } from './torpedoes.js';
import { sightMultiplier } from './weather.js';

const TORPEDO_ARC = 30;
const ARMING_RANGE = 0.16;
const TRACK_LIFETIME = 150;
const CLAIM_RANGE = 2;
const DEPTH_CHARGE = { depth: 40, fuse: 9, reload: 35, blastRadius: 120, damage: 70 };

export function createCombatState(sub, year) {
  const { bowTubes, sternTubes, totalTorpedoes, torpedoCaliberMm, deckGun } = sub.armament;
  const model = patrolTorpedo(year, torpedoCaliberMm);
  const torpedoes = model ? totalTorpedoes : 0;
  return {
    shells: deckGun.equipped ? deckGun.maxAmmo : 0, torpedoes, torpedoCapacity: torpedoes, torpedoId: model?.id ?? null,
    readyAt: { deck: 0, bow: Array(bowTubes).fill(model ? 0 : null), stern: Array(sternTubes).fill(model ? 0 : null) }, track: null,
    projectiles: [], depthCharges: [], effects: [], events: [], report: '',
  };
}

export function assignedTorpedoes({ bow, stern }) {
  return [...bow, ...stern].filter((readyAt) => readyAt !== null).length;
}

function tubeReadiness(tubes, elapsed, reloadRate) {
  const loaded = tubes.filter((readyAt) => readyAt !== null);
  if (!loaded.length) return 'Tubes empty';
  const readyAt = Math.min(...loaded);
  return readyAt > elapsed && reloadRate === 0 ? 'Reload stalled' : reloadMessage(readyAt, elapsed);
}

export function selectTarget(state, shipId) {
  if (!shipId) {
    state.combat.track = null;
    return true;
  }
  const ship = state.ships.find((vessel) => vessel.id === shipId);
  const observation = ship && observeShip(state, ship);
  if (!observation) return false;

  state.combat.track = { ...observation, observedAt: state.elapsed };
  return true;
}

function targetTrack(state, visible) {
  const track = state.combat.track;
  if (!track) return null;
  if (visible?.id === track.id) return { ...visible, source: 'visual' };

  const age = state.elapsed - track.observedAt;
  if (age > TRACK_LIFETIME) return { ...track, source: 'lost' };
  const position = advancePosition(track.position, track.heading, track.speed * age / SECONDS_PER_HOUR);
  return { ...track, position, source: 'estimated', age };
}

export function solveIntercept(origin, target, model) {
  const distance = distanceTo(origin, target.position);
  const relative = bearingDelta(bearingTo(origin, target.position), target.heading) * Math.PI / 180;
  // Solve the intercept in a local tangent plane, including targets as fast as the torpedo.
  const a = target.speed ** 2 - model.speedKnots ** 2;
  const b = 2 * distance * target.speed * Math.cos(relative);
  const c = distance ** 2;
  const discriminant = b ** 2 - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const roots = Math.abs(a) < 1e-9 ? [-c / b] : [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  const hours = Math.min(...roots.filter((time) => time > 0 && Number.isFinite(time)));
  if (hours * model.speedKnots > model.maxRangeMeters / METERS_PER_NM) return null;
  const point = advancePosition(target.position, target.heading, target.speed * hours);
  const bearing = bearingTo(origin, point);
  return { point, bearing, eta: hours * SECONDS_PER_HOUR, distance: distanceTo(origin, point), lead: bearingDelta(bearingTo(origin, target.position), bearing) };
}

function reloadMessage(readyAt, now) {
  return readyAt > now ? `Reloading · ${Math.ceil(readyAt - now)} s` : '';
}

function deckAccuracy(range, maxRange, weather) {
  const accuracy = 0.98 - 0.69 * (range / maxRange) ** 1.6;
  return accuracy * (weather === 'storm' ? 0.72 : 1);
}

export function getFireControl(state, visible, aim = targetTrack(state, visible)) {
  const { boat, sub, combat, elapsed } = state;
  const gun = sub.armament.deckGun;
  const gunRange = gun.maxRangeMeters / METERS_PER_NM;
  const model = torpedoModel(combat.torpedoId);
  const target = aim;
  const usable = target && target.source !== 'lost';
  const range = usable ? distanceTo(boat.position, target.position) : null;
  const solution = usable && model ? solveIntercept(boat.position, target, model) : null;
  const noTarget = target ? 'Track lost' : 'Select a target';
  let unavailable = '';
  if (campaignEnded(state)) unavailable = 'Campaign ended';
  else if (boat.hull === 0) unavailable = `${submarineDesignation(boat)} lost`;
  else if (sub.crewSquads.every(({ incapacitated }) => incapacitated)) unavailable = 'Crew incapacitated';
  const disabled = unavailable || (usable ? '' : noTarget);

  let deck = disabled;
  if (!deck) {
    if (!gun.equipped) deck = 'Deck gun not fitted';
    else if (boat.depth !== 0) deck = 'Surface to fire';
    else if (target.source !== 'visual') deck = 'Visual contact required';
    else if (range > gunRange) deck = `Out of range · ${gunRange.toFixed(2)} NM`;
    else if (!combat.shells) deck = 'No shells remaining';
    else deck = reloadMessage(combat.readyAt.deck, elapsed);
  }

  let claim = disabled;
  if (!claim) {
    if (boat.depth !== 0) claim = 'Surface to claim tonnage';
    else if (target.source !== 'visual') claim = 'Visual contact required';
    else if (!target.surrendered) claim = 'Target has not surrendered';
    else if (range > CLAIM_RANGE) claim = 'Close to 2 NM to claim';
  }

  let launch = disabled;
  if (!launch) {
    if (isBoatExposed(boat)) launch = boat.depth === 0 ? 'Dive to launch' : 'Wait until submerged';
    else if (!combat.torpedoes) launch = 'No torpedoes remaining';
    else if (!model) launch = 'No compatible torpedoes';
    else if (!solution) launch = `No intercept within ${(model.maxRangeMeters / METERS_PER_NM).toFixed(2)} NM`;
    else if (solution.distance < ARMING_RANGE) launch = 'Inside arming distance';
    else if (!hasWaterLine(boat.position, solution.point)) launch = 'Land blocks firing line';
  }

  const tubeStatus = (tube, heading) => (!combat.readyAt[tube].length ? 'Not fitted' : '') || launch
    || (Math.abs(bearingDelta(heading, solution.bearing)) > TORPEDO_ARC ? 'Outside firing arc' : '')
    || tubeReadiness(combat.readyAt[tube], elapsed, compartmentEfficiency(sub, tube));

  return {
    target, range, solution,
    deck, warning: deck || (target.surrendered ? 'Target already surrendered' : ''), claim,
    bow: tubeStatus('bow', boat.heading), stern: tubeStatus('stern', boat.heading + 180),
    accuracy: !deck ? deckAccuracy(range, gunRange, state.weather) : null,
  };
}

export function getOpticalFireControl(state, sight, contact) {
  const { boat, combat } = state;
  const mode = opticsMode(boat);
  const model = torpedoModel(combat.torpedoId);
  const { bearing, speed, range, angleOnBow } = sight;
  const valid = Number.isFinite(bearing) && Number.isFinite(speed) && speed >= 0 && speed <= 40
    && Number.isFinite(range) && range >= 50 && range <= 20000
    && Number.isFinite(angleOnBow) && Math.abs(angleOnBow) <= 180;
  let estimate = null;
  if (valid) {
    const position = advancePosition(boat.position, bearing, range / METERS_PER_NM);
    estimate = { ...contact, position, speed, heading: wrapHeading(bearingTo(position, boat.position) - angleOnBow), source: 'visual' };
  }
  const solution = estimate && model ? solveIntercept(boat.position, estimate, model) : null;
  const bowOffset = solution ? bearingDelta(boat.heading, solution.bearing) : 0;
  const tube = Math.abs(bowOffset) <= 90 ? 'bow' : 'stern';
  const gyro = solution ? bearingDelta(boat.heading + (tube === 'stern' ? 180 : 0), solution.bearing) : null;
  const weapon = mode === 'binoculars' ? 'deck' : tube;
  const aim = mode === 'binoculars' ? (contact ? { ...contact, source: 'visual' } : null) : estimate;
  const control = getFireControl(state, null, aim);
  let reason = control[weapon];
  if (!mode) reason = 'Surface or set depth to 10–14 m';
  else if (!contact) reason = 'Center a ship in the reticle';
  else if (!Number.isFinite(bearing) || Math.abs(bearingDelta(bearing, bearingTo(boat.position, contact.position))) > 8) reason = 'Center a ship in the reticle';
  else if (mode === 'periscope' && !valid) reason = 'Enter speed, range and angle on bow';
  return { mode, control, weapon, solution, gyro, tube, reason };
}

function addEffect(state, kind, position, details = {}) {
  const effects = state.combat.effects;
  effects.push({ kind, position, ...details });
  if (effects.length > 40) effects.shift();
}

function alertShip(ship) {
  ship.attacked = true;
  if (VESSEL_TYPES[ship.type].isQShip) ship.revealed = true;
}

function queueShell(state, origin, target, { owner, damage, hit, warning = false }) {
  const travel = Math.max(0.45, distanceTo(origin, target.position) * 2.35);
  let aim = advancePosition(target.position, target.heading, target.speed * travel / SECONDS_PER_HOUR);
  if (!hit) aim = advancePosition(aim, target.heading + 90, 0.13);
  state.combat.projectiles.push({
    kind: 'shell', owner, origin, aim, targetId: target.id, damage, hit, warning,
    launchAt: state.elapsed, impactAt: state.elapsed + travel,
  });
  addEffect(state, 'flash', origin);
}

export function fireWeapon(state, weapon, random = Math.random) {
  if (!['deck', 'warning', 'bow', 'stern'].includes(weapon)) return false;
  const { combat, elapsed } = state;
  const ship = state.ships.find((vessel) => vessel.id === combat.track?.id);
  const visual = ship && observeShip(state, ship);
  if (visual) combat.track = { ...visual, observedAt: elapsed };
  const control = getFireControl(state, visual);
  if (control[weapon]) {
    combat.report = control[weapon];
    return false;
  }

  return launchWeapon(state, weapon, control, ship, random);
}

export function fireOpticalWeapon(state, sight, shipId, random = Math.random) {
  const ship = state.ships.find((vessel) => vessel.id === shipId);
  const contact = ship && observeShip(state, ship);
  const { control, weapon, reason } = getOpticalFireControl(state, sight, contact);
  if (reason) {
    state.combat.report = reason;
    return false;
  }
  selectTarget(state, shipId);
  return launchWeapon(state, weapon, control, ship, random);
}

function launchWeapon(state, weapon, control, ship, random) {
  const { boat, sub, combat, elapsed } = state;
  if (weapon === 'deck' || weapon === 'warning') {
    const warning = weapon === 'warning';
    const gun = sub.armament.deckGun;
    combat.shells--;
    combat.readyAt.deck = elapsed + gun.reloadSec;
    queueShell(state, boat.position, control.target, {
      owner: 'player', damage: warning ? 0 : Math.round(32 * gun.caliberMm / 88), hit: !warning && random() < control.accuracy, warning,
    });
    alertShip(ship);
    combat.report = warning ? 'Warning shot away' : `${gun.caliberMm} mm shell away`;
  } else {
    const tubes = combat.readyAt[weapon];
    const tube = tubes.findIndex((readyAt) => readyAt !== null && readyAt <= elapsed);
    const spareTorpedoes = combat.torpedoes - assignedTorpedoes(combat.readyAt);
    const reload = sub.armament.torpedoReloadTimeSec;
    combat.torpedoes--;
    tubes[tube] = spareTorpedoes > 0 && reload > 0 ? elapsed + reload : null;
    combat.projectiles.push({
      kind: 'torpedo', origin: boat.position, position: boat.position, bearing: control.solution.bearing,
      traveled: 0, torpedoId: combat.torpedoId,
    });
    if (ship && VESSEL_TYPES[ship.type].isQShip) ship.revealed = true;
    combat.report = weapon === 'bow' ? 'Bow torpedo away' : 'Stern torpedo away';
  }
  return true;
}

export function claimTonnage(state) {
  const ship = state.ships.find(({ id }) => id === state.combat.track?.id);
  const visual = ship && observeShip(state, ship);
  const { claim } = getFireControl(state, visual);
  if (claim) {
    state.combat.report = claim;
    return false;
  }

  creditShip(state, ship.id, 'claimed');
  state.combat.report = `${ship.name} claimed`;
  return true;
}

function damageShip(state, ship, damage, weapon) {
  ship.hull = Math.max(0, ship.hull - damage);
  addEffect(state, 'explosion', ship.position);
  alertShip(ship);
  if (ship.hull > 0) {
    state.combat.report = `${weapon} hit · ${ship.name}`;
    return;
  }

  sinkShip(state, ship.id);
  addEffect(state, 'wreck', ship.position, { heading: ship.heading });
  state.combat.report = `${ship.name} sunk`;
}

function damageBoat(state, shell, random) {
  const { boat, combat, sub } = state;
  const { damage } = shell;
  addEffect(state, 'explosion', boat.position);
  damageCompartment(sub, impactCompartment(boat, shell.origin, random), damage * 1.5, damage * 0.55);
  damageHull(state, damage);
  if (boat.hull > 0) combat.report = `Return fire hit · hull ${Math.ceil(boat.hull)}%`;
}

function advanceShell(state, shell, random) {
  if (state.elapsed < shell.impactAt) return true;

  if (shell.owner === 'player') {
    const target = state.ships.find((ship) => ship.id === shell.targetId);
    if (shell.warning) {
      addEffect(state, 'splash', shell.aim);
      const profile = target && VESSEL_TYPES[target.type];
      if (profile?.surrendersToWarningShot && !profile.armed && distanceTo(shell.aim, target.position) <= 0.28) {
        target.surrendered = true;
        target.speed = 0;
        target.threat = null;
        target.activity = 'Surrendered';
        state.combat.report = `${target.name} stopped engines`;
      } else {
        state.combat.report = target ? `${target.name} ignored the warning shot` : 'Warning shot splashed';
      }
      return false;
    }
    if (shell.hit && target && distanceTo(shell.aim, target.position) <= VESSEL_TYPES[target.type].hitRadius) {
      damageShip(state, target, shell.damage, 'Deck gun');
      return false;
    }
    state.combat.report = 'Deck gun missed';
  } else if (shell.hit && isBoatExposed(state.boat) && state.boat.hull > 0 && distanceTo(shell.aim, state.boat.position) <= 0.07) {
    damageBoat(state, shell, random);
    return false;
  }

  addEffect(state, 'splash', shell.aim);
  return false;
}

export function impactDudProbability(torpedo, ship) {
  const base = torpedoModel(torpedo.torpedoId).reliability.dudProbability;
  if (distanceTo(torpedo.position, ship.position) < 1e-6) return base;
  const normal = bearingTo(torpedo.position, ship.position);
  const incidence = Math.max(0, Math.cos(bearingDelta(torpedo.bearing, normal) * Math.PI / 180));
  return Math.min(1, base + 0.35 * (1 - incidence) ** 2);
}

function advanceTorpedo(state, torpedo, seconds, random) {
  const model = torpedoModel(torpedo.torpedoId);
  const range = model.maxRangeMeters / METERS_PER_NM;
  torpedo.traveled = Math.min(range, torpedo.traveled + model.speedKnots * seconds / SECONDS_PER_HOUR);
  torpedo.position = advancePosition(torpedo.origin, torpedo.bearing, torpedo.traveled);
  if (!isWater(torpedo.position)) {
    state.combat.report = isOnChart(torpedo.position) ? 'Torpedo struck land' : 'Torpedo left the chart';
    return false;
  }

  if (torpedo.traveled >= ARMING_RANGE) {
    const hit = state.ships.find((ship) => distanceTo(torpedo.position, ship.position) <= VESSEL_TYPES[ship.type].hitRadius);
    if (hit) {
      if (torpedo.legacyDud ?? (random() < impactDudProbability(torpedo, hit))) {
        addEffect(state, 'splash', hit.position);
        state.combat.report = 'Torpedo Impact - Dud!';
        state.combat.events.push({ elapsed: state.elapsed, message: state.combat.report });
      } else damageShip(state, hit, model.hullDamage, 'Torpedo');
      return false;
    }
  }

  if (torpedo.traveled < range) return true;
  state.combat.report = 'Torpedo ran out of range';
  return false;
}

function updateEnemyGuns(state, random) {
  const { boat, elapsed, weather } = state;
  if (!isBoatExposed(boat) || boat.hull === 0) return;

  for (const ship of state.ships) {
    const { gun, role, lookout, isQShip } = VESSEL_TYPES[ship.type];
    if (!gun || (!ship.attacked && !ship.revealed && role !== 'hunt')) continue;
    const range = distanceTo(ship.position, boat.position);
    if (range > Math.min(gun.range, lookout * sightMultiplier(weather)) || !hasWaterLine(ship.position, boat.position)) continue;

    ship.gunReadyAt ??= elapsed + (isQShip ? 0 : 3);
    if (elapsed < ship.gunReadyAt) continue;
    ship.gunReadyAt = elapsed + gun.reload;
    const accuracy = (0.77 - 0.48 * range / gun.range) * (weather === 'storm' ? 0.72 : 1);
    queueShell(state, ship.position, boat, { owner: 'enemy', damage: gun.damage, hit: random() < accuracy });
    state.combat.report = `${ship.name} firing on ${submarineDesignation(boat)}`;
  }
}

function updateDepthCharges(state, random) {
  const { boat, combat, elapsed, sub } = state;
  combat.depthCharges = combat.depthCharges.filter((charge) => {
    if (elapsed < charge.detonatesAt) return true;

    const horizontal = distanceTo(charge.position, boat.position) * METERS_PER_NM;
    const distanceMeters = Math.hypot(horizontal, charge.depth - boat.depth);
    addEffect(state, 'splash', charge.position, { depthChargeDistanceMeters: distanceMeters });
    if (boat.hull > 0 && distanceMeters < DEPTH_CHARGE.blastRadius) {
      const damage = DEPTH_CHARGE.damage * (1 - distanceMeters / DEPTH_CHARGE.blastRadius) ** 2;
      damageCompartment(sub, impactCompartment(boat, charge.position, random), damage * 1.45, damage * 0.95);
      damageHull(state, damage, 'Hull failed under depth charges');
      if (boat.hull > 0) combat.report = `Depth charge hit · hull ${Math.ceil(boat.hull)}%`;
    }
    return false;
  });

  if (isBoatExposed(boat) || boat.hull === 0) return;
  for (const ship of state.ships) {
    if (ship.surrendered || !ship.depthChargesRemaining || ship.nextDepthChargeAt > elapsed
      || !ship.threat || ship.threat.until <= elapsed || distanceTo(ship.position, ship.threat.position) > DEPTH_CHARGE_DROP_RANGE) continue;

    ship.depthChargesRemaining--;
    ship.nextDepthChargeAt = elapsed + DEPTH_CHARGE.reload;
    combat.depthCharges.push({ position: ship.position, depth: DEPTH_CHARGE.depth, detonatesAt: elapsed + DEPTH_CHARGE.fuse });
    combat.report = `${ship.name} dropped a depth charge`;
  }
}

export function updateCombat(state, seconds, random = Math.random) {
  const { combat, sub, elapsed } = state;
  // Extend unfinished absolute deadlines by the work lost this tick. Ready tubes stay loaded.
  for (const side of ['bow', 'stern']) {
    const delay = seconds * (1 - compartmentEfficiency(sub, side));
    if (delay <= 0) continue;
    const tubes = combat.readyAt[side];
    for (let index = 0; index < tubes.length; index++) {
      if (tubes[index] !== null && tubes[index] > elapsed - seconds + 1e-9) tubes[index] += delay;
    }
  }
  const track = combat.track;
  if (track && state.elapsed - track.observedAt >= 0.5) {
    const ship = state.ships.find((vessel) => vessel.id === track.id);
    if (!ship) combat.track = null;
    else {
      const visible = observeShip(state, ship);
      if (visible) combat.track = { ...visible, observedAt: state.elapsed };
    }
  }

  if (combat.projectiles.length) {
    combat.projectiles = combat.projectiles.filter((projectile) => projectile.kind === 'shell'
      ? advanceShell(state, projectile, random) : advanceTorpedo(state, projectile, seconds, random));
  }
  updateEnemyGuns(state, random);
  updateDepthCharges(state, random);
}
