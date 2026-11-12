import { dataForYear, GAME_DATA, patrolZone } from './dataLoader.js';
import { DEFAULT_CAPTAIN, DEFAULT_PATROL_ZONE, FIRST_PATROL_YEAR, LAST_PATROL_YEAR, MAX_CAPTAIN_NAME_LENGTH, PATROL_START } from './state.js';
import { DEFAULT_SUBMARINE } from './submarines.js';

const TAU = Math.PI * 2;
const SWEEP_PERIOD_MS = 9600;
const SWEEP_TRAIL = 0.16;
const echoes = [[0.37, 0.42], [0.51, 1.44], [0.79, 2.56], [0.58, 3.74], [0.87, 5.08], [0.65, 5.9]];

function createSonarSweep(canvas) {
  const context = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame;
  let active = false;

  function draw(now) {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    const backingWidth = Math.round(width * pixelRatio);
    const backingHeight = Math.round(height * pixelRatio);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    const x = width * 0.67;
    const y = height * 0.5;
    const radius = Math.min(width, height) * 0.64;
    const angle = reducedMotion.matches ? -0.62 : now / SWEEP_PERIOD_MS * TAU - Math.PI / 2;
    const tail = SWEEP_TRAIL * TAU;

    context.save();
    context.translate(x, y);
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.clip();

    context.strokeStyle = '#6b929232';
    context.lineWidth = 1;
    context.beginPath();
    for (let grid = -8; grid <= 8; grid++) {
      const step = grid * radius / 8;
      context.moveTo(-radius, step);
      context.lineTo(radius, step);
      context.moveTo(step, -radius);
      context.lineTo(step, radius);
    }
    context.stroke();

    context.strokeStyle = '#8baea951';
    context.beginPath();
    for (let ring = 1; ring <= 4; ring++) {
      const range = radius * ring / 4;
      context.moveTo(range, 0);
      context.arc(0, 0, range, 0, TAU);
    }
    context.stroke();

    const sweep = context.createConicGradient(angle - tail, 0, 0);
    sweep.addColorStop(0, '#83c4ae00');
    sweep.addColorStop(SWEEP_TRAIL * 0.72, '#83c4ae18');
    sweep.addColorStop(SWEEP_TRAIL, '#a7d9be58');
    sweep.addColorStop(SWEEP_TRAIL + 0.003, '#83c4ae00');
    sweep.addColorStop(1, '#83c4ae00');
    context.fillStyle = sweep;
    context.fillRect(-radius, -radius, 2 * radius, 2 * radius);
    context.strokeStyle = '#b7dccc8c';
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    context.stroke();

    for (const [range, bearing] of echoes) {
      const age = ((angle - bearing) % TAU + TAU) % TAU;
      const intensity = 0.08 + 0.72 * Math.max(0, 1 - age / (tail * 1.5));
      context.fillStyle = `rgba(177, 221, 196, ${intensity})`;
      context.beginPath();
      context.arc(Math.cos(bearing) * radius * range, Math.sin(bearing) * radius * range, 2.2, 0, TAU);
      context.fill();
    }
    context.restore();
  }

  function animate(now) {
    draw(now);
    frame = active && !reducedMotion.matches ? requestAnimationFrame(animate) : undefined;
  }

  function refresh() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = active ? requestAnimationFrame(animate) : undefined;
  }

  window.addEventListener('resize', refresh);
  reducedMotion.addEventListener('change', refresh);
  return (running) => {
    active = running;
    refresh();
  };
}

function openFieldManual() {
  if (window.electronAPI?.openGameManual) return window.electronAPI.openGameManual();
  const manualUrl = new URL('./manual/manual.html', import.meta.url);
  const tab = window.open(manualUrl.href, '_blank');
  if (!tab) return { ok: false, message: 'Allow pop-ups to open the field manual.' };
  tab.opener = null;
  return { ok: true };
}

export function initLandingScreen({ onStartNewPatrol, onLoadSave, onResume, onQuit }) {
  const byId = (id) => document.getElementById(id);
  const landing = byId('landing-screen');
  const menu = byId('main-menu-actions');
  const setup = byId('new-patrol-panel');
  const captain = byId('input-captain');
  const year = byId('select-year');
  const submarine = byId('select-uboat');
  const sector = byId('select-zone');
  const briefing = byId('zone-briefing-text');
  const gridCode = byId('zone-briefing-grid');
  const status = byId('landing-status');
  const start = byId('btn-new-patrol');
  const resume = byId('btn-resume-patrol');
  const load = byId('btn-load-patrol');
  const manual = byId('btn-open-manual');
  const runSonar = createSonarSweep(byId('landing-bg-canvas'));
  let busy = false;

  captain.value = DEFAULT_CAPTAIN;
  captain.maxLength = MAX_CAPTAIN_NAME_LENGTH;
  for (let choice = FIRST_PATROL_YEAR; choice <= LAST_PATROL_YEAR; choice++) {
    year.add(new Option(String(choice), String(choice)));
  }
  year.value = String(new Date(PATROL_START).getUTCFullYear());
  sector.replaceChildren(...GAME_DATA.patrolZones.map((zone) => new Option(zone.name, zone.id)));
  sector.value = DEFAULT_PATROL_ZONE;

  function report(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function updateClasses() {
    const previous = submarine.value || DEFAULT_SUBMARINE;
    const choices = dataForYear(Number(year.value)).submarines;
    submarine.replaceChildren(...choices.map(({ id, name }) => new Option(name, id)));
    if (choices.some(({ id }) => id === previous)) submarine.value = previous;
    else if (choices.some(({ id }) => id === DEFAULT_SUBMARINE)) submarine.value = DEFAULT_SUBMARINE;
  }

  function updateBriefing() {
    const zone = patrolZone(sector.value);
    briefing.textContent = zone?.briefing ?? '';
    gridCode.textContent = zone?.gridCode ?? '';
  }

  function showMenu() {
    setup.hidden = true;
    menu.hidden = false;
    report('');
    (resume.hidden ? start : resume).focus({ preventScroll: true });
  }

  async function runAction(action, pending, failure) {
    if (busy || landing.hidden) return;
    busy = true;
    for (const button of [start, resume, load, manual]) button.disabled = true;
    report(pending);
    try {
      const result = await action();
      report(result.ok ? '' : result.message, !result.ok);
    } catch (error) {
      console.error(failure, error);
      report(failure, true);
    } finally {
      busy = false;
      for (const button of [start, resume, load, manual]) button.disabled = false;
    }
  }

  const openManual = () => runAction(openFieldManual, 'Preparing the field manual…', 'Could not open the field manual.');
  start.addEventListener('click', () => {
    menu.hidden = true;
    setup.hidden = false;
    report('');
    captain.focus({ preventScroll: true });
  });
  resume.addEventListener('click', onResume);
  load.addEventListener('click', () => runAction(onLoadSave, 'Loading saved patrol…', 'Could not load the saved patrol.'));
  manual.addEventListener('click', openManual);
  byId('btn-exit-desktop').addEventListener('click', onQuit);
  byId('btn-back-menu').addEventListener('click', showMenu);
  year.addEventListener('change', updateClasses);
  sector.addEventListener('change', updateBriefing);
  setup.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      onStartNewPatrol({ captainName: captain.value, year: Number(year.value), uboatClassId: submarine.value, patrolZoneId: sector.value });
    } catch (error) {
      report(error.message, true);
    }
  });

  updateClasses();
  updateBriefing();
  runSonar(true);
  return {
    get active() { return !landing.hidden; },
    openManual,
    back() { if (!setup.hidden) showMenu(); },
    hide() {
      runSonar(false);
      landing.hidden = true;
    },
    show() {
      resume.hidden = false;
      start.classList.remove('primary');
      landing.hidden = false;
      showMenu();
      runSonar(true);
    },
  };
}
