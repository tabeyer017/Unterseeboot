import { audio } from './audioEngine.js';
import { createCampaignSave, restoreCampaign } from './campaign-save.js';
import { campaignEnded, campaignTime } from './campaign.js';
import { isWater, patrolSectorAt } from './chart.js';
import { claimTonnage, fireWeapon, getFireControl, selectTarget } from './combat.js';
import { createControlRoomView } from './controlRoomRenderer.js';
import { CHLORINE_DANGER, peakChlorine } from './damageControl.js';
import { dataForYear, patrolZone } from './dataLoader.js';
import { distanceTo, speedLimit, startSimulation } from './engine.js';
import { initLandingScreen } from './landing.js';
import { METERS_PER_NM } from './navigation.js';
import { createPeriscopeView } from './periscopeView.js';
import { createChartRenderer } from './renderer.js';
import { collectContacts, hydrophoneAvailable } from './sensors.js';
import { createConfiguredPatrol, DEPTHS, startNextPatrol, state, TELEGRAPH, TIME_SCALES } from './state.js';
import { BALLAST_AIR_COST, blowBallast, canBlowBallast, hullStress, isBoatExposed, opticsMode, orderDepth, secondsUntilSubmerged, submarineDesignation } from './submarines.js';
import { torpedoModel } from './torpedoes.js';

const byId = (id) => document.getElementById(id);
const canvas = byId('chart');
const chart = createChartRenderer(canvas);
const heardDepthCharges = new WeakSet();
const timeButtons = [...document.querySelectorAll('[data-scale]')];
const telegraphButtons = [...document.querySelectorAll('[data-telegraph]')];
const depthButtons = [...document.querySelectorAll('[data-depth]')];
const fireButtons = [...document.querySelectorAll('[data-fire]')];
const viewTabs = { chart: byId('chart-room-tab'), periscope: byId('optical-toggle'), control: byId('control-room-tab') };
const manual = { open: byId('open-manual'), save: byId('save-manual-copy'), options: byId('manual-options'), status: byId('manual-status') };
const pause = { dialog: byId('pause-menu'), open: byId('open-pause-menu'), resume: byId('resume-patrol'), menu: byId('return-to-main-menu') };
const gameRegions = document.querySelectorAll('.masthead, .dashboard, .status-bar');

const hud = {
  date: byId('patrol-date'), time: byId('patrol-time'),
  heading: byId('heading'), needle: byId('compass-needle'), speed: byId('speed'), speedLimit: byId('speed-limit'),
  depth: byId('depth'), depthMarker: byId('depth-marker'),
  stress: byId('hull-stress'), testMark: byId('depth-test-mark'), crushMark: byId('depth-crush-mark'), testTick: byId('depth-test-tick'),
  orderedDepth: byId('ordered-depth'), depthOrder: byId('depth-order-status'), depthLimits: byId('depth-limits'),
  blowBallast: byId('blow-ballast'), ballastAir: byId('ballast-air'),
  dieselMeter: byId('diesel-meter'), dieselValue: byId('diesel-value'),
  batteryMeter: byId('battery-meter'), batteryValue: byId('battery-value'),
  sectorCode: byId('sector-code'), sectorName: byId('sector-name'),
  course: byId('course-status'), coordinates: byId('coordinates'),
  weather: byId('weather'), weatherCondition: byId('weather-condition'),
  sight: byId('sight-status'), hydrophone: byId('hydrophone-status'), diplomacy: byId('diplomacy-status'),
  scan: byId('hydrophone-scan'), scanResult: byId('hydrophone-result'),
  hull: byId('hull-status'), chartTitle: byId('chart-title'), chartSubtitle: byId('chart-subtitle'),
};
const weapons = {
  mode: byId('tactical-mode'), viewport: byId('chart-viewport'), console: byId('combat-console'),
  target: byId('combat-target'), targetData: byId('combat-target-data'), solution: byId('combat-solution'),
  shells: byId('shell-count'), torpedoes: byId('torpedo-count'), deck: byId('deck-status'), tubes: byId('tube-status'),
  gunLabel: byId('deck-gun-label'), model: byId('torpedo-model'), events: byId('torpedo-events'),
  bowTubes: byId('bow-tube-count'), sternTubes: byId('stern-tube-count'),
  report: byId('combat-report'), restart: byId('restart-patrol'), log: byId('sinking-log'),
  total: byId('tonnage-total'), totalTitle: byId('tonnage-title'), empty: byId('empty-sinkings'),
  prize: byId('prize-controls'), claim: byId('claim-tonnage'), claimStatus: byId('claim-status'),
};
const log = {
  dialog: byId('campaign-log'), open: byId('open-campaign-log'), close: byId('close-campaign-log'),
  captain: byId('campaign-captain'),
  date: byId('campaign-date'), patrols: byId('campaign-patrols'), experience: byId('campaign-experience'),
  tonnage: byId('campaign-tonnage'), tonnageTitle: byId('campaign-tonnage-title'), records: byId('campaign-record'), empty: byId('empty-campaign-record'),
  status: byId('campaign-status'), next: byId('next-patrol'), save: byId('save-campaign'), load: byId('load-campaign'),
  submarine: byId('next-submarine'), departure: byId('next-patrol-date'),
};

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const numberFormat = new Intl.NumberFormat('en-GB');
let displayedMinute;
let cursor = null;
let plotFeedback = '';
let plotFeedbackUntil = 0;
let tactical = false;
let targetOptionsKey;
let displayedSinkings = -1;
let displayedLog;
let storageBusy = false;
let displayedEvents;
let displayedEventCount = -1;
let lastThrottle;
let lastEngineDepth;
let nextHullCreakAt;
let lastScan;
let manualStatusTimeout;
let activeView = 'chart';
let stopPatrol;
const isPatrolPaused = () => !stopPatrol || log.dialog.open || pause.dialog.open;
const optics = createPeriscopeView({
  state, playWeaponAudio, blocked: isPatrolPaused, onChange: updateChartTitle,
  onToggle: () => setView(activeView === 'periscope' ? 'chart' : 'periscope'),
});
const controlRoom = createControlRoomView({ state, blocked: isPatrolPaused });
const landing = initLandingScreen({
  onStartNewPatrol: (config) => enterPatrol(createConfiguredPatrol(config)),
  onLoadSave: loadSavedPatrol,
  onResume: () => enterPatrol(),
  onQuit: () => window.electronAPI.quitApp(),
});

for (const event of ['click', 'keydown']) {
  window.addEventListener(event, unlockEngineAudio, { capture: true });
}

function unlockEngineAudio() {
  if (isPatrolPaused() || audio.ctx?.state === 'running') return;
  audio.init();
  if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
}

async function loadSavedPatrol() {
  const result = await window.campaignStorage.load();
  if (result.ok) enterPatrol(restoreCampaign(result.save));
  return result;
}

function enterPatrol(next) {
  if (stopPatrol) return;
  if (next) {
    Object.assign(state, next);
    resetPatrolView();
  }
  for (const region of gameRegions) region.inert = false;
  landing.hide();
  stopPatrol = startSimulation(state, drawPatrolFrame, isPatrolPaused);
  unlockEngineAudio();
  pause.open.focus({ preventScroll: true });
}

function openPauseMenu() {
  if (isPatrolPaused()) return;
  pause.dialog.showModal();
  audio.setMuted(true);
  updateEngineAudio(true);
}

function returnToMainMenu() {
  if (!stopPatrol) return;
  stopPatrol();
  stopPatrol = undefined;
  audio.shutdown().catch((error) => console.error('Could not close patrol audio:', error));
  lastThrottle = lastEngineDepth = nextHullCreakAt = undefined;
  pause.dialog.close();
  for (const region of gameRegions) region.inert = true;
  landing.show();
}

function playWeaponAudio(projectile) {
  if (projectile.kind === 'torpedo') audio.playTorpedoLaunch();
  else audio.playDeckGun();
}

function updateEngineAudio(paused) {
  const ready = audio.ctx?.state === 'running';
  const { boat, combat } = state;
  const submerged = boat.depth > 2;
  const limit = speedLimit(state);
  const throttle = !paused && boat.hull > 0 && limit > 0 ? Math.min(1, boat.speed / limit) : 0;
  if (ready && (throttle !== lastThrottle || boat.depth !== lastEngineDepth)) {
    audio.updateEngineState(throttle, submerged);
    if (throttle > 0 && !audio.dieselNodes) audio.startDieselEngine(throttle);
    if (throttle === 0) audio.stopDieselEngine();
    lastThrottle = throttle;
    lastEngineDepth = boat.depth;
  }

  const stress = !paused && boat.hull > 0 ? hullStress(boat) : 0;
  if (stress === 0) {
    nextHullCreakAt = undefined;
  } else if (ready) {
    // The warning uses audio time so time compression cannot stack creaks in one frame.
    const now = audio.ctx.currentTime;
    if (nextHullCreakAt === undefined || now >= nextHullCreakAt) {
      if (nextHullCreakAt !== undefined) audio.playHullCreak(stress);
      nextHullCreakAt = now + 3 + Math.random() * 3;
    }
  }

  if (paused) return;
  for (const effect of combat.effects) {
    if (!Number.isFinite(effect.depthChargeDistanceMeters) || heardDepthCharges.has(effect)) continue;
    heardDepthCharges.add(effect);
    if (ready) audio.playDepthCharge(effect.depthChargeDistanceMeters);
  }
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

async function useFieldManual(action) {
  if (manual.open.disabled) return;
  if (manual.options.open) manual.options.querySelector('summary').focus();
  manual.options.open = false;
  manual.open.disabled = manual.save.disabled = true;
  clearTimeout(manualStatusTimeout);
  manual.status.dataset.error = 'false';
  setText(manual.status, action === 'open' ? 'Preparing the field manual…' : 'Choose where to save the manual.');
  try {
    const result = await window.fieldManual[action]();
    manual.status.dataset.error = String(!result.ok);
    setText(manual.status, result.ok ? (action === 'saveCopy' && !result.canceled ? `Manual saved to ${result.path}` : '') : result.message);
  } catch (error) {
    console.error('Field manual request failed:', error);
    manual.status.dataset.error = 'true';
    setText(manual.status, 'The field manual is unavailable.');
  } finally {
    manual.open.disabled = manual.save.disabled = false;
    manualStatusTimeout = setTimeout(() => setText(manual.status, ''), 10000);
  }
}

function setPressed(button, pressed) {
  const value = String(pressed);
  if (button.ariaPressed !== value) button.ariaPressed = value;
}

function setTactical(active) {
  tactical = active;
  cursor = null;
  weapons.console.hidden = !active;
  weapons.viewport.classList.toggle('is-tactical', active);
  setPressed(weapons.mode, active);
  updateChartTitle();
}

function setView(view) {
  if (activeView === view || (view === 'periscope' && !state.boat.hull)) return;
  activeView = view;
  optics.setActive(view === 'periscope');
  controlRoom.setActive(view === 'control');
  weapons.viewport.classList.toggle('is-control-room', view === 'control');
  for (const [name, tab] of Object.entries(viewTabs)) setPressed(tab, view === name);
  updateChartTitle();
}

function resetPatrolView() {
  plotFeedbackUntil = 0;
  lastScan = null;
  setText(hud.scanResult, '');
  setView('chart');
  setTactical(Boolean(state.combat.track) || state.boat.hull === 0);
  updateClock();
}

function updateChartTitle() {
  if (activeView === 'control') {
    setText(hud.chartTitle, 'Control Room');
    setText(hud.chartSubtitle, 'Damage & Crew');
  } else if (activeView === 'periscope') {
    setText(hud.chartTitle, opticsMode(state.boat) === 'binoculars' ? 'Conning Tower' : 'Periscope View');
    setText(hud.chartSubtitle, 'Optical fire control');
  } else {
    setText(hud.chartTitle, tactical ? 'Tactical Combat' : 'Tactical Chart');
    setText(hud.chartSubtitle, tactical ? 'Close-range plot' : 'North Atlantic & British Isles');
  }
}

function updateTargets(contacts, target) {
  const choices = contacts.visual.map(({ id, name, label }) => [id, `${name} · ${label}`]);
  if (target && target.source !== 'visual') {
    choices.unshift([target.id, `${target.name} · ${target.source === 'lost' ? 'Track lost' : 'Estimated track'}`]);
  }
  const key = JSON.stringify(choices);
  if (key !== targetOptionsKey) {
    targetOptionsKey = key;
    weapons.target.replaceChildren(new Option('Select a contact', ''), ...choices.map(([id, name]) => new Option(name, id)));
  }
  const selected = target?.id ?? '';
  if (weapons.target.value !== selected) weapons.target.value = selected;
}

function formatDuration(seconds) {
  const rounded = Math.ceil(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function formatHeading(degrees) {
  return `${String(Math.round(degrees) % 360).padStart(3, '0')}°`;
}

function updateSinkingLog() {
  if (displayedLog === state.sinkings && displayedSinkings === state.sinkings.length) return;
  displayedLog = state.sinkings;
  displayedSinkings = state.sinkings.length;
  setText(weapons.total, `${numberFormat.format(state.tonnageSunk)} t`);
  const includesPrizes = state.sinkings.some((record) => record.outcome === 'claimed');
  setText(weapons.totalTitle, includesPrizes ? 'Tonnage Credited' : 'Tonnage Sunk');
  setText(log.tonnageTitle, includesPrizes ? 'Tonnage credited' : 'Tonnage sunk');
  weapons.empty.hidden = displayedSinkings > 0;
  log.empty.hidden = weapons.empty.hidden;
  const entries = [...state.sinkings].reverse().map((record) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    const tonnage = document.createElement('span');
    const detail = document.createElement('span');
    name.className = 'sinking-ship';
    tonnage.className = 'sinking-tonnage';
    detail.className = 'sinking-meta';
    name.textContent = record.name;
    tonnage.textContent = `+${numberFormat.format(record.tonnage)} t`;
    const date = new Date(record.date);
    const outcome = record.outcome === 'claimed' ? 'Claimed' : 'Sunk';
    detail.textContent = `${dateFormat.format(date)} · ${timeFormat.format(date)} UTC · Patrol ${record.patrol} · ${record.label} · ${outcome}`;
    item.append(name, tonnage, detail);
    return item;
  });
  log.records.replaceChildren(...entries.map((item) => item.cloneNode(true)));
  weapons.log.replaceChildren(...entries);
}

function updateCampaignDialog() {
  const zone = patrolZone(state.patrolZoneId);
  setText(log.captain, zone ? `${state.captainName} · ${zone.name}` : state.captainName);
  const date = new Date(campaignTime(state));
  setText(log.date, dateFormat.format(date));
  log.date.dateTime = date.toISOString();
  setText(log.patrols, numberFormat.format(state.patrolCount));
  setText(log.experience, `${numberFormat.format(state.crewExperience)} XP`);
  setText(log.tonnage, `${numberFormat.format(state.tonnageSunk)} t`);
  const today = date.toISOString().slice(0, 10);
  log.departure.min = today;
  log.departure.value = today;
  updatePatrolChoices(state.boat.classId);
  updateSinkingLog();
}

function nextDeparture() {
  const current = campaignTime(state);
  if (log.departure.value === new Date(current).toISOString().slice(0, 10)) return current;
  return log.departure.valueAsNumber;
}

function updatePatrolChoices(preferred = log.submarine.value) {
  const validDate = log.departure.validity.valid && Number.isFinite(nextDeparture());
  const choices = validDate ? dataForYear(new Date(nextDeparture()).getUTCFullYear()).submarines : [];
  log.submarine.replaceChildren(...choices.map(({ id, name }) => new Option(name, id)));
  if (choices.some(({ id }) => id === preferred)) log.submarine.value = preferred;
  log.departure.disabled = storageBusy || campaignEnded(state);
  log.next.disabled = log.departure.disabled || !choices.length;
  log.submarine.disabled = log.next.disabled;
}

function storageStatus(message, error = false, path = '') {
  setText(log.status, message);
  log.status.dataset.error = String(error);
  log.status.title = path;
}

function setStorageBusy(busy) {
  storageBusy = busy;
  log.save.disabled = busy;
  log.load.disabled = busy;
  log.close.disabled = busy;
  updatePatrolChoices();
}

async function changeCampaignSave(action) {
  if (storageBusy) return;
  setStorageBusy(true);
  storageStatus(action === 'save' ? 'Saving campaign…' : 'Loading campaign…');

  try {
    const result = action === 'save'
      ? await window.campaignStorage.save(createCampaignSave(state))
      : await window.campaignStorage.load();
    if (!result.ok) {
      storageStatus(result.message, true);
      return;
    }

    if (action === 'load') {
      Object.assign(state, restoreCampaign(result.save));
      resetPatrolView();
      updateCampaignDialog();
    }
    storageStatus(action === 'save' ? 'Campaign saved locally.' : 'Campaign loaded.', false, result.path);
  } catch (error) {
    console.error('Campaign storage failed:', error);
    storageStatus('Campaign storage is unavailable.', true);
  } finally {
    setStorageBusy(false);
  }
}

function nextPatrol(classId, departure = campaignTime(state)) {
  if (!startNextPatrol(state, classId, departure)) return;
  resetPatrolView();
  storageStatus(`Patrol ${state.patrolCount} started.`);
  if (log.dialog.open) log.dialog.close();
}

function tubeCount(tubes) {
  if (!tubes.length) return 'No tubes';
  const ready = tubes.filter((time) => time !== null && time <= state.elapsed).length;
  return `${ready} / ${tubes.length} ready`;
}

function updateFireConsole(contacts, control) {
  const { target, range, solution, deck, claim, bow, stern, accuracy } = control;
  updateTargets(contacts, target);
  let targetData = 'Choose a visible contact';
  if (target) {
    targetData = range === null ? 'Track lost · regain visual contact'
      : `${range.toFixed(1)} NM · ${target.speed.toFixed(1)} kn · ${formatHeading(target.heading)}`;
    if (target.source === 'estimated') targetData += ' · Estimated';
    if (target.surrendered && target.source === 'visual') targetData += ' · Surrendered';
  }
  setText(weapons.targetData, targetData);
  const showSolution = Boolean(solution && state.boat.depth > 0);
  weapons.solution.hidden = !showSolution;
  if (showSolution) {
    const lead = Math.round(solution.lead);
    setText(weapons.solution, `${formatHeading(solution.bearing)} · Lead ${lead > 0 ? '+' : ''}${lead}° · ETA ${formatDuration(solution.eta)}`);
  }

  const gun = state.sub.armament.deckGun;
  const model = torpedoModel(state.combat.torpedoId);
  setText(weapons.gunLabel, gun.equipped ? `${gun.caliberMm} mm deck gun` : 'Deck gun');
  setText(weapons.shells, `${state.combat.shells} / ${gun.equipped ? gun.maxAmmo : 0}`);
  setText(weapons.torpedoes, `${state.combat.torpedoes} / ${state.combat.torpedoCapacity}`);
  setText(weapons.model, model ? `${model.name} · ${(model.maxRangeMeters / METERS_PER_NM).toFixed(2)} NM` : 'No compatible torpedoes');
  setText(weapons.bowTubes, tubeCount(state.combat.readyAt.bow));
  setText(weapons.sternTubes, tubeCount(state.combat.readyAt.stern));
  setText(weapons.deck, deck || `${Math.round(accuracy * 100)}% hit chance · ${(gun.maxRangeMeters / METERS_PER_NM).toFixed(2)} NM max`);
  weapons.prize.hidden = !target?.surrendered || target.source !== 'visual';
  weapons.claim.disabled = Boolean(claim);
  setText(weapons.claimStatus, claim || (target?.flag === 'Neutral' ? 'Claiming a neutral incurs a diplomatic penalty' : 'Engines stopped'));
  const tubes = bow === stern ? bow || 'Tubes ready' : `Bow ${bow.toLowerCase() || 'ready'} · Stern ${stern.toLowerCase() || 'ready'}`;
  setText(weapons.tubes, tubes);
  for (const button of fireButtons) button.disabled = Boolean(control[button.dataset.fire]);
  setText(weapons.report, state.combat.report);
  weapons.restart.hidden = state.boat.hull > 0 || campaignEnded(state);
  updateSinkingLog();
  const { events } = state.combat;
  if (events !== displayedEvents || events.length !== displayedEventCount) {
    displayedEvents = events;
    displayedEventCount = events.length;
    weapons.events.hidden = events.length === 0;
    weapons.events.replaceChildren(...events.map(({ message, elapsed }) => {
      const item = document.createElement('li');
      item.textContent = `${timeFormat.format(new Date(state.patrolStart + elapsed * 1000))} · ${message}`;
      return item;
    }).reverse());
  }
}

function drawCompassTicks() {
  const ticks = byId('compass-ticks');
  for (let angle = 0; angle < 360; angle += 10) {
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const major = angle % 30 === 0;
    tick.setAttribute('x1', '60');
    tick.setAttribute('x2', '60');
    tick.setAttribute('y1', '11');
    tick.setAttribute('y2', major ? '18' : '15');
    tick.setAttribute('class', major ? 'compass-tick major' : 'compass-tick');
    tick.setAttribute('transform', `rotate(${angle} 60 60)`);
    ticks.append(tick);
  }
}

function formatAxis(value, positive, negative, padding) {
  const minutes = Math.round(Math.abs(value) * 60);
  const degrees = String(Math.floor(minutes / 60)).padStart(padding, '0');
  const remainder = String(minutes % 60).padStart(2, '0');
  return `${degrees}°${remainder}′${value < 0 ? negative : positive}`;
}

function formatPosition({ lon, lat }) {
  return `${formatAxis(lat, 'N', 'S', 2)}  ${formatAxis(lon, 'E', 'W', 3)}`;
}

function updateClock() {
  const minute = Math.floor(campaignTime(state) / 60_000);
  if (minute === displayedMinute) return;
  displayedMinute = minute;
  const date = new Date(minute * 60_000);
  setText(hud.date, dateFormat.format(date).toUpperCase());
  setText(hud.time, timeFormat.format(date));
  hud.time.dateTime = date.toISOString();
}

function courseText() {
  if (campaignEnded(state)) return 'Campaign ended';
  if (performance.now() < plotFeedbackUntil) return plotFeedback;
  if (!state.waypoints.length) return state.navigationNotice || 'Holding heading';
  const count = state.waypoints.length;
  const distance = distanceTo(state.boat.position, state.waypoints[0]);
  return `${count} waypoint${count === 1 ? '' : 's'} · ${distance.toFixed(1)} NM to next`;
}

function updateContactReadouts({ ranges, visual, bearings }) {
  if (hud.weather.dataset.condition !== state.weather) hud.weather.dataset.condition = state.weather;
  setText(hud.weatherCondition, state.weather === 'storm' ? 'Storm' : 'Clear');
  setText(hud.sight, `${Math.round(ranges.sight)} NM · ${visual.length} contact${visual.length === 1 ? '' : 's'}`);
  setText(hud.hydrophone, ranges.hydrophone > 0
    ? `${Math.round(ranges.hydrophone)} NM · ${bearings.length} bearing${bearings.length === 1 ? '' : 's'}`
    : state.sub.sensors.hydrophoneEquipped ? isBoatExposed(state.boat) ? 'Standby' : 'Offline' : 'Not fitted');
  hud.scan.disabled = campaignEnded(state) || !hydrophoneAvailable(state);
  if (lastScan && (lastScan.boat !== state.boat || hud.scan.disabled || performance.now() >= lastScan.until)) {
    setText(hud.scanResult, '');
    lastScan = null;
  }
  const hasPenalty = state.diplomaticPenalty > 0;
  if (hud.diplomacy.hidden === hasPenalty) hud.diplomacy.hidden = !hasPenalty;
  if (hasPenalty) setText(hud.diplomacy, `Diplomacy −${state.diplomaticPenalty}`);
}

function updateDepthHud(boat, controlsDisabled) {
  const { testDepthMeters, crushDepthMeters } = state.sub.maneuverability;
  const testTick = 6 + 51 * testDepthMeters / crushDepthMeters;
  setText(hud.depth, String(Math.round(boat.depth)));
  hud.depthMarker.setAttribute('transform', `translate(0 ${boat.depth * 51 / crushDepthMeters})`);
  hud.testTick.setAttribute('d', `M11 ${testTick}h8`);
  hud.testMark.setAttribute('y', String(testTick + 3));
  setText(hud.testMark, String(testDepthMeters));
  setText(hud.crushMark, String(crushDepthMeters));
  setText(hud.depthLimits, `Test ${testDepthMeters} m · Crush ${crushDepthMeters} m`);
  if (Number(hud.orderedDepth.max) !== crushDepthMeters) hud.orderedDepth.max = crushDepthMeters;
  if (Number(hud.orderedDepth.value) !== boat.targetDepth) hud.orderedDepth.value = boat.targetDepth;
  hud.orderedDepth.disabled = controlsDisabled;
  hud.blowBallast.disabled = controlsDisabled || !canBlowBallast(boat);
  setText(hud.ballastAir, `Air ${boat.compressedAir}%`);
  hud.ballastAir.dataset.low = String(boat.compressedAir < BALLAST_AIR_COST);

  const diving = !controlsDisabled && isBoatExposed(boat) && boat.targetDepth >= DEPTHS.periscope;
  let status = `${boat.targetDepth} m ordered`;
  if (boat.blowingBallast) status = 'Emergency ascent';
  else if (diving) {
    const remaining = secondsUntilSubmerged(boat, state.sub);
    status = Number.isFinite(remaining) ? `${boat.targetDepth} m · Exposed ${Math.ceil(remaining - 1e-9)} s` : 'Dive controls offline';
  }
  setText(hud.depthOrder, status);
  hud.depthOrder.dataset.warning = String(diving || boat.blowingBallast);
  const gasDanger = peakChlorine(state.sub) >= CHLORINE_DANGER;
  hud.stress.hidden = boat.hull <= 0 || (!gasDanger && hullStress(boat) === 0);
  setText(hud.stress, gasDanger ? 'Chlorine danger' : 'Hull stress');
}

function updateHud(contacts) {
  const { boat, sub } = state;
  const controlsDisabled = boat.hull === 0 || campaignEnded(state);
  setText(hud.heading, formatHeading(boat.heading));
  hud.needle.setAttribute('transform', `rotate(${boat.heading} 60 60)`);
  setText(hud.speed, boat.speed.toFixed(1));
  setText(hud.speedLimit, `${Math.round(speedLimit(state) * 10) / 10} kn max`);
  updateDepthHud(boat, controlsDisabled);

  hud.dieselMeter.max = sub.resources.maxDieselLiters;
  hud.batteryMeter.max = sub.resources.maxBatteryCapacity;
  hud.dieselMeter.value = boat.diesel;
  hud.batteryMeter.value = boat.battery;
  setText(hud.dieselValue, `${numberFormat.format(Math.round(boat.diesel))} / ${numberFormat.format(sub.resources.maxDieselLiters)} L`);
  setText(hud.batteryValue, `${Math.round(boat.battery)} / ${sub.resources.maxBatteryCapacity}`);

  const assignment = patrolZone(state.patrolZoneId);
  const sector = assignment ?? patrolSectorAt(boat.position);
  const sectorName = sector?.name ?? 'Open waters';
  setText(hud.sectorCode, assignment ? assignment.gridCode.replace(/^Grid /, '') : sector?.code ?? '–');
  hud.sectorCode.dataset.assigned = String(Boolean(assignment));
  setText(hud.sectorName, sectorName);
  if (hud.sectorName.title !== sectorName) hud.sectorName.title = sectorName;
  setText(hud.course, courseText());
  setText(hud.coordinates, formatPosition(cursor ?? boat.position));
  setText(hud.hull, `${submarineDesignation(boat)} · Hull ${Math.ceil(boat.hull)}%`);
  hud.hull.dataset.damaged = String(boat.hull < 100);

  for (const button of telegraphButtons) {
    setPressed(button, button.dataset.telegraph === boat.telegraph);
    button.disabled = controlsDisabled;
  }
  for (const button of depthButtons) {
    setPressed(button, DEPTHS[button.dataset.depth] === boat.targetDepth);
    button.disabled = controlsDisabled;
  }
  for (const button of timeButtons) setPressed(button, Number(button.dataset.scale) === state.timeScale);
  updateClock();
  updateContactReadouts(contacts);
}

for (const [name, tab] of Object.entries(viewTabs)) tab.addEventListener('click', () => setView(name));
manual.open.addEventListener('click', () => useFieldManual('open'));
manual.save.addEventListener('click', () => useFieldManual('saveCopy'));
pause.open.addEventListener('click', openPauseMenu);
pause.resume.addEventListener('click', () => {
  pause.dialog.close();
  unlockEngineAudio();
});
pause.menu.addEventListener('click', returnToMainMenu);
pause.dialog.addEventListener('close', () => audio.setMuted(false));
pause.dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  returnToMainMenu();
});
window.addEventListener('click', (event) => {
  if (manual.options.open && !manual.options.contains(event.target)) manual.options.open = false;
});

weapons.mode.addEventListener('click', () => {
  const showTactical = activeView !== 'chart' || !tactical;
  setView('chart');
  setTactical(showTactical);
});
weapons.target.addEventListener('change', () => selectTarget(state, weapons.target.value));
for (const button of fireButtons) {
  button.addEventListener('click', () => {
    if (fireWeapon(state, button.dataset.fire)) playWeaponAudio(state.combat.projectiles.at(-1));
  });
}
weapons.claim.addEventListener('click', () => claimTonnage(state));
weapons.restart.addEventListener('click', () => {
  const classes = dataForYear(new Date(campaignTime(state)).getUTCFullYear()).submarines;
  nextPatrol(classes.find(({ id }) => id === state.boat.classId)?.id ?? classes[0]?.id);
});
log.open.addEventListener('click', () => {
  updateCampaignDialog();
  log.dialog.showModal();
});
log.close.addEventListener('click', () => log.dialog.close());
log.dialog.addEventListener('cancel', (event) => {
  if (storageBusy) event.preventDefault();
});
log.departure.addEventListener('input', () => updatePatrolChoices());
log.next.addEventListener('click', () => nextPatrol(log.submarine.value, nextDeparture()));
log.save.addEventListener('click', () => changeCampaignSave('save'));
log.load.addEventListener('click', () => changeCampaignSave('load'));

for (const button of timeButtons) {
  button.addEventListener('click', () => {
    const scale = Number(button.dataset.scale);
    if (TIME_SCALES.includes(scale)) state.timeScale = scale;
  });
}

for (const button of telegraphButtons) {
  button.addEventListener('click', () => {
    const order = button.dataset.telegraph;
    if (!Object.hasOwn(TELEGRAPH, order)) return;
    state.boat.telegraph = order;
    state.navigationNotice = '';
  });
}

for (const button of depthButtons) {
  button.addEventListener('click', () => {
    const order = button.dataset.depth;
    if (Object.hasOwn(DEPTHS, order)) orderDepth(state.boat, DEPTHS[order]);
  });
}
hud.orderedDepth.addEventListener('input', () => {
  orderDepth(state.boat, hud.orderedDepth.valueAsNumber);
});
function emergencySurface() {
  if (isPatrolPaused() || campaignEnded(state) || !blowBallast(state.boat)) return;
  audio.playBallastBlow();
}

hud.blowBallast.addEventListener('click', emergencySurface);
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'F1') {
    event.preventDefault();
    if (landing.active) landing.openManual();
    else useFieldManual('open');
    return;
  }
  if (event.code === 'Escape') {
    if (landing.active) landing.back();
    else if (!log.dialog.open) {
      event.preventDefault();
      if (pause.dialog.open) returnToMainMenu();
      else openPauseMenu();
    }
    return;
  }
  if (isPatrolPaused() || event.target?.closest?.('input, select, textarea, [contenteditable]')) return;
  if (event.code === 'KeyB') emergencySurface();
  else if (event.code === 'KeyC') setView(activeView === 'control' ? 'chart' : 'control');
});

hud.scan.addEventListener('click', () => {
  if (isPatrolPaused() || campaignEnded(state) || !hydrophoneAvailable(state)) return;
  const { bearings } = collectContacts(state, { includeVisualBearings: true });
  const report = bearings.sort((a, b) => a - b).map(formatHeading).join(' · ');
  setText(hud.scanResult, report ? `Hydrophone bearings ${report}` : 'No propellers heard in the listening sector');
  lastScan = { boat: state.boat, until: performance.now() + 6000 };
  audio.playSonarPing();
});

canvas.addEventListener('pointermove', (event) => {
  cursor = chart.pointAt(event.clientX, event.clientY);
});
canvas.addEventListener('pointerleave', () => { cursor = null; });

canvas.addEventListener('click', (event) => {
  if (event.button !== 0 || state.boat.hull === 0 || campaignEnded(state)) return;
  const point = chart.pointAt(event.clientX, event.clientY);
  const contact = point && chart.contactAt(point, collectContacts(state));
  if (contact && selectTarget(state, contact.id)) {
    setTactical(true);
    return;
  }
  if (!point || !isWater(point)) {
    plotFeedback = point ? 'Choose a waypoint in open water' : 'Choose a waypoint inside the chart';
    plotFeedbackUntil = performance.now() + 2400;
    return;
  }

  plotFeedbackUntil = 0;
  state.waypoints.push(point);
  state.navigationNotice = '';
});

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (state.boat.hull === 0 || campaignEnded(state)) return;
  cursor = null;
  plotFeedbackUntil = 0;
  state.waypoints.length = 0;
  state.navigationNotice = 'Course cleared';
});

drawCompassTicks();
function drawPatrolFrame() {
  updateEngineAudio(isPatrolPaused() || campaignEnded(state));
  const contacts = collectContacts(state);
  const lost = state.boat.hull === 0;
  if (lost && activeView === 'periscope') setView('chart');
  if (lost && !tactical) setTactical(true);
  weapons.mode.disabled = lost;
  viewTabs.periscope.disabled = lost;
  const target = contacts.visual.find(({ id }) => id === state.combat.track?.id);
  const fireControl = tactical ? getFireControl(state, target) : null;
  const now = performance.now();
  optics.update(contacts, now);
  controlRoom.update(now);
  if (activeView === 'chart') chart.draw(state, cursor, contacts, fireControl);
  updateHud(contacts);
  if (fireControl) updateFireConsole(contacts, fireControl);
}
