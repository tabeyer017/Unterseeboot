import { fireOpticalWeapon, getOpticalFireControl } from './combat.js';
import { GAME_DATA } from './dataLoader.js';
import { bearingDelta, wrapHeading } from './navigation.js';
import { createPeriscopeRenderer, drawRecognitionProfile, opticalFieldOfView } from './periscopeRenderer.js';
import { opticsMode } from './submarines.js';

const heading = (value) => `${String(Math.round(value) % 360).padStart(3, '0')}°`;

function buildRecognitionManual(container) {
  const profiles = GAME_DATA.ships.map((vessel) => {
    const entry = document.createElement('article');
    const title = document.createElement('h3');
    const image = document.createElement('canvas');
    const stats = document.createElement('p');
    entry.className = 'recognition-profile';
    title.textContent = vessel.name;
    image.width = 294;
    image.height = 80;
    image.setAttribute('aria-hidden', 'true');
    drawRecognitionProfile(image, vessel);
    stats.textContent = `Mast ${vessel.recognition.mastHeightMeters} m · Max ${vessel.maxSpeedKnots} kn`;
    entry.append(title, image, stats);
    return entry;
  });
  container.replaceChildren(...profiles);
}

export function createPeriscopeView({ state, playWeaponAudio, blocked, onChange, onToggle }) {
  const byId = (id) => document.getElementById(id);
  const panel = byId('optical-view');
  const viewport = byId('chart-viewport');
  const canvas = byId('periscope-canvas');
  const zoomButton = byId('optical-zoom');
  const manual = byId('recognition-manual');
  const manualButton = byId('recognition-toggle');
  const fire = byId('optical-fire');
  const bearingDisplay = byId('optical-bearing');
  const contactDisplay = byId('optical-contact');
  const blind = byId('optical-blind');
  const blindTitle = byId('optical-blind-title');
  const blindHelp = byId('optical-blind-help');
  const speed = byId('tdc-speed');
  const range = byId('tdc-range');
  const angle = byId('tdc-angle');
  const gyro = byId('tdc-gyro');
  const course = byId('tdc-course');
  const status = byId('optical-fire-status');
  const renderer = createPeriscopeRenderer(canvas);
  const keys = new Set();
  let active = false;
  let zoom = 1.5;
  let pan = 0;
  let centered = null;
  let drag;
  let previousFrame;
  let lastMode;
  let reportUntil = 0;
  let shotMessage = '';
  let lastReport = '';

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function setActive(value) {
    if (value === active || (value && !state.boat.hull)) return;
    active = value;
    panel.hidden = !value;
    viewport.classList.toggle('is-optical', value);
    keys.clear();
    drag = null;
    previousFrame = undefined;
    centered = null;
    reportUntil = 0;
    lastReport = state.combat.report;
    onChange();
  }

  function changeZoom() {
    zoom = zoom === 1.5 ? 6 : 1.5;
    zoomButton.firstChild.textContent = `${zoom}× `;
  }

  function readSight() {
    return { bearing: wrapHeading(state.boat.heading + pan), speed: speed.valueAsNumber,
      range: range.valueAsNumber, angleOnBow: angle.valueAsNumber };
  }

  zoomButton.addEventListener('click', changeZoom);
  manualButton.addEventListener('click', () => {
    const open = manual.hidden;
    manual.hidden = !open;
    manualButton.setAttribute('aria-expanded', String(open));
    byId('optical-body').classList.toggle('has-manual', open);
    if (open && !byId('recognition-profiles').childElementCount) buildRecognitionManual(byId('recognition-profiles'));
  });
  fire.addEventListener('click', () => {
    if (!active || blocked() || !centered) return;
    const sight = readSight();
    const { weapon } = getOpticalFireControl(state, sight, centered.contact);
    if (!fireOpticalWeapon(state, sight, centered.contact.id)) return;
    const now = performance.now();
    const projectile = state.combat.projectiles.at(-1);
    renderer.recoil(weapon, now, projectile);
    playWeaponAudio(projectile);
    shotMessage = state.combat.report;
    reportUntil = now + 1800;
  });

  window.addEventListener('keydown', (event) => {
    if (blocked() || event.altKey || event.ctrlKey || event.metaKey || event.target?.closest?.('input, select, textarea, [contenteditable]')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) onToggle();
    } else if (active && opticsMode(state.boat) && ['KeyA', 'KeyD', 'KeyZ'].includes(event.code)) {
      event.preventDefault();
      if (event.code === 'KeyZ') {
        if (!event.repeat) changeZoom();
      } else keys.add(event.code);
    }
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !opticsMode(state.boat)) return;
    drag = { id: event.pointerId, x: event.clientX, start: event.clientX, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId || !opticsMode(state.boat)) return;
    if (Math.abs(event.clientX - drag.start) > 4) drag.moved = true;
    if (!drag.moved) return;
    const width = canvas.getBoundingClientRect().width;
    pan = wrapHeading(pan - (event.clientX - drag.x) / width * opticalFieldOfView(opticsMode(state.boat), zoom));
    drag.x = event.clientX;
  });
  canvas.addEventListener('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return;
    if (!drag.moved) {
      const item = renderer.contactAt(event.clientX, event.clientY);
      if (item) pan = bearingDelta(state.boat.heading, item.trueBearing);
    }
    drag = null;
  });
  canvas.addEventListener('lostpointercapture', () => { drag = null; });

  return {
    get active() { return active; },
    setActive,
    update(contacts, now) {
      renderer.observeEffects(state.combat.effects, now);
      if (!active) return;
      const mode = opticsMode(state.boat);
      if (mode !== lastMode) {
        lastMode = mode;
        canvas.dataset.mode = mode ?? 'blind';
        blind.hidden = Boolean(mode);
        contactDisplay.hidden = !mode;
        for (const control of [zoomButton, speed, range, angle]) control.disabled = !mode;
        if (!mode) keys.clear();
        onChange();
      }
      if (!mode) {
        const tooDeep = state.boat.depth > 14;
        setText(blindTitle, tooDeep ? 'Periscope Submerged - Blind' : 'Optics unavailable at this depth');
        setText(blindHelp, tooDeep
          ? state.sub.sensors.hydrophoneEquipped ? 'Ascend to 12 m or scan with Hydrophones.' : 'Ascend to 12 m to use the periscope.'
          : 'Surface or set depth to 12 m.');
      }
      const delta = previousFrame === undefined ? 0 : Math.min(0.05, (now - previousFrame) / 1000);
      previousFrame = now;
      if (blocked()) keys.clear();
      const direction = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      pan = wrapHeading(pan + direction * opticalFieldOfView(mode, zoom) * delta * 0.82);
      const sight = readSight();
      centered = renderer.draw(state, contacts, { mode, bearing: sight.bearing, zoom }, now);
      if (state.combat.report !== lastReport) {
        lastReport = state.combat.report;
        if (lastReport) {
          shotMessage = lastReport;
          reportUntil = now + 1800;
        }
      }
      const { weapon, tube, solution, gyro: angleValue, reason } = mode
        ? getOpticalFireControl(state, sight, centered?.contact) : { reason: 'Weapons unavailable at this depth' };
      setText(bearingDisplay, heading(sight.bearing));
      const aspect = Math.abs(centered?.aspect.angle ?? 0);
      const profile = aspect < 22.5 ? 'bow-on' : aspect > 157.5 ? 'stern-on' : aspect > 67.5 && aspect < 112.5 ? 'broadside' : 'quartering';
      setText(contactDisplay, centered ? `Contact centered · ${profile}` : 'Center a ship in the reticle');
      setText(gyro, solution ? `${angleValue >= 0 ? '+' : '−'}${Math.abs(angleValue).toFixed(1)}°` : '—');
      setText(course, solution ? `${heading(solution.bearing)} true · ${tube}` : 'No firing solution');
      setText(fire, weapon === 'deck' ? 'Fire Deck Gun' : 'Fire Torpedo');
      fire.disabled = Boolean(reason) || blocked();
      setText(status, mode && now < reportUntil ? shotMessage : reason || (weapon === 'deck' ? 'Deck gun ready' : `${tube === 'bow' ? 'Bow' : 'Stern'} tube ready`));
    },
  };
}
