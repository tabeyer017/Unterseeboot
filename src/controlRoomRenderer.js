import { campaignEnded } from './campaign.js';
import {
  assignSquad, canPumpBilges, canVentilate, CHLORINE_DANGER, compartmentEfficiency,
  COMPARTMENTS, CREW_SQUADS, floodingLoad, peakChlorine, TRIM_SPEED_KNOTS,
} from './damageControl.js';
import { depthDrift } from './submarines.js';

// The hull bounds match the five HTML hit targets so the drawing scales with the panel.
const WIDTH = 1000;
const HEIGHT = 300;
const HULL_LEFT = 70;
const HULL_TOP = 111;
const HULL_BOTTOM = 225;
const ROOM_WIDTH = 860 / COMPARTMENTS.length;
const TAU = 2 * Math.PI;

function line(ctx, ...points) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let index = 2; index < points.length; index += 2) ctx.lineTo(points[index], points[index + 1]);
  ctx.stroke();
}

function circle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.stroke();
}

function drawEquipment(ctx, index) {
  ctx.save();
  ctx.translate(HULL_LEFT + (index + 0.5) * ROOM_WIDTH, 168);
  ctx.strokeStyle = '#acc2bc';
  ctx.fillStyle = '#284147';
  ctx.lineWidth = 1.5;
  switch (index) {
    case 0:
    case 4: {
      if (index === 4) ctx.scale(-1, 1);
      for (const y of [-20, 1, 22]) {
        ctx.fillRect(-28, y - 4, 65, 8);
        line(ctx, -44, y, -28, y - 6, 36, y - 6, 42, y, 36, y + 6, -28, y + 6, -44, y);
        line(ctx, 28, y - 6, 28, y + 6, 42, y);
      }
      line(ctx, -22, -32, -22, 33, 32, 33, 32, -32);
      break;
    }
    case 1:
      ctx.strokeRect(-52, -25, 41, 9);
      ctx.strokeRect(-52, -6, 41, 9);
      line(ctx, -52, -31, -52, 28, -11, 28, -11, -31);
      ctx.strokeRect(4, 7, 51, 23);
      ctx.strokeRect(12, -24, 37, 31);
      circle(ctx, 30, -9, 9);
      line(ctx, 29, -9, 35, -14);
      for (const x of [14, 30, 46]) circle(ctx, x, 18, 2);
      break;
    case 2:
      line(ctx, -48, 31, -48, -8, -34, -22, 34, -22, 48, -8, 48, 31, -48, 31);
      for (const x of [-25, 0, 25]) circle(ctx, x, -5, 7);
      circle(ctx, 0, 16, 10);
      line(ctx, -10, 16, 10, 16);
      line(ctx, 0, 6, 0, 26);
      line(ctx, -9, -22, -9, -56, 9, -56, 9, -22);
      break;
    case 3:
      ctx.strokeRect(-54, -12, 68, 34);
      line(ctx, -49, -12, -45, -25, 5, -25, 9, -12);
      for (const x of [-40, -26, -12, 2]) {
        ctx.strokeRect(x - 4, -8, 8, 24);
        ctx.strokeRect(x - 4, 28, 8, 8);
      }
      circle(ctx, 39, 4, 19);
      circle(ctx, 39, 4, 10);
      line(ctx, 13, 4, 30, 4);
      line(ctx, 49, 4, 66, 4);
      break;
  }
  ctx.restore();
}

function drawFlooding(ctx, x, level, time) {
  const top = HULL_BOTTOM - (HULL_BOTTOM - HULL_TOP) * level / 100;
  ctx.fillStyle = '#3ca6da73';
  ctx.beginPath();
  ctx.moveTo(x, top);
  for (let offset = 0; offset < ROOM_WIDTH; offset += 4) {
    ctx.lineTo(x + offset, top + Math.sin(offset * 0.07 + time * 3) * 2);
  }
  ctx.lineTo(x + ROOM_WIDTH, top);
  ctx.lineTo(x + ROOM_WIDTH, HULL_BOTTOM);
  ctx.lineTo(x, HULL_BOTTOM);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#80d6f8bf';
  line(ctx, x, top, x + ROOM_WIDTH, top);
}

function drawChlorine(ctx, x, level, time) {
  const haze = ctx.createRadialGradient(x + ROOM_WIDTH * 0.5, 187, 4, x + ROOM_WIDTH * 0.5, 187, ROOM_WIDTH * 0.62);
  haze.addColorStop(0, `rgba(158, 217, 86, ${level / 150})`);
  haze.addColorStop(1, 'rgba(158, 217, 86, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(x, HULL_TOP, ROOM_WIDTH, HULL_BOTTOM - HULL_TOP);
  ctx.strokeStyle = `rgba(174, 226, 125, ${level / 270})`;
  for (let index = 0; index < 3; index++) {
    const y = 156 + index * 17 + Math.sin(time * 1.4 + index) * 5;
    ctx.beginPath();
    ctx.moveTo(x + 14, y);
    ctx.bezierCurveTo(x + 55, y - 10, x + 83, y + 13, x + 151, y - 2);
    ctx.stroke();
  }
}

function drawSparks(ctx, x, level, time) {
  const y = 136;
  const bright = 0.6 + 0.4 * Math.max(0, Math.sin(time * 13 + x));
  ctx.strokeStyle = `rgba(255, 194, 111, ${bright})`;
  ctx.lineWidth = 2;
  line(ctx, x + 6, y - 12, x - 5, y + 1, x + 3, y + 1, x - 4, y + 12);
  const spread = 3 + level / 22;
  for (let index = 0; index < 4; index++) {
    const angle = time * 0.8 + index * Math.PI / 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    line(ctx, x + dx * 13, y + dy * 13, x + dx * (13 + spread), y + dy * (13 + spread));
  }
  ctx.lineWidth = 1.4;
}

export function createControlRoomRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const hull = new Path2D('M70 167 Q80 131 151 115 Q171 111 205 111 H795 Q862 111 900 137 L930 160 V182 Q892 222 805 225 H192 Q107 222 70 181 Z');
  const casing = new Path2D('M90 147 Q125 112 199 105 H400 L427 96 H452 L462 72 H535 L550 100 H741 Q841 101 905 141');
  let lastPaint = -Infinity;

  return function draw(sub, now) {
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * pixelRatio);
    const height = Math.round(canvas.clientHeight * pixelRatio);
    if (!width || !height) return;
    if (width !== canvas.width || height !== canvas.height) {
      canvas.width = width;
      canvas.height = height;
    } else if (now - lastPaint < 32) return;
    lastPaint = now;
    ctx.setTransform(width / WIDTH, 0, 0, height / HEIGHT, 0, 0);
    const time = now / 1000;

    const paper = ctx.createRadialGradient(490, 140, 30, 490, 140, 570);
    paper.addColorStop(0, '#233941');
    paper.addColorStop(1, '#101d24');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.lineWidth = 1;
    for (let x = 0; x <= WIDTH; x += 25) {
      ctx.strokeStyle = x % 100 === 0 ? '#405a625b' : '#3b52583d';
      line(ctx, x, 0, x, HEIGHT);
    }
    for (let y = 0; y <= HEIGHT; y += 25) {
      ctx.strokeStyle = y % 100 === 0 ? '#405a625b' : '#3b52583d';
      line(ctx, 0, y, WIDTH, y);
    }

    ctx.strokeStyle = '#829994';
    ctx.lineWidth = 1.7;
    ctx.stroke(casing);
    line(ctx, 476, 72, 476, 55, 484, 55);
    line(ctx, 501, 72, 501, 45, 517, 45);
    line(ctx, 522, 72, 522, 62, 531, 62);
    line(ctx, 280, 105, 286, 94, 306, 94, 318, 105);
    line(ctx, 295, 94, 293, 88, 264, 86);
    line(ctx, 924, 164, 948, 164, 948, 177, 929, 177);
    line(ctx, 950, 149, 958, 152, 958, 192, 950, 194, 950, 149);

    ctx.save();
    ctx.clip(hull);
    ctx.fillStyle = '#192e36';
    ctx.fillRect(HULL_LEFT, HULL_TOP, ROOM_WIDTH * COMPARTMENTS.length, HULL_BOTTOM - HULL_TOP);
    for (const [index, { id }] of COMPARTMENTS.entries()) {
      const x = HULL_LEFT + ROOM_WIDTH * index;
      const room = sub.compartments[id];
      if (index % 2 === 1) {
        ctx.fillStyle = '#91c4cb10';
        ctx.fillRect(x, HULL_TOP, ROOM_WIDTH, HULL_BOTTOM - HULL_TOP);
      }
      drawEquipment(ctx, index);
      if (room.floodingLevel > 0) drawFlooding(ctx, x, room.floodingLevel, time);
      if (room.chlorineGasLevel > 0) drawChlorine(ctx, x, room.chlorineGasLevel, time);
      if (room.mechanicalDamage > 0) drawSparks(ctx, x + ROOM_WIDTH * 0.82, room.mechanicalDamage, time);
    }
    ctx.strokeStyle = '#ccb184a8';
    ctx.lineWidth = 1.4;
    line(ctx, HULL_LEFT, 203, WIDTH - HULL_LEFT, 203);
    for (let index = 1; index < COMPARTMENTS.length; index++) {
      const x = HULL_LEFT + ROOM_WIDTH * index;
      line(ctx, x, HULL_TOP, x, HULL_BOTTOM);
      circle(ctx, x, 183, 6);
    }
    ctx.restore();
    ctx.strokeStyle = '#d6b886';
    ctx.lineWidth = 2.1;
    ctx.stroke(hull);
    ctx.strokeStyle = '#87a7ab7a';
    ctx.lineWidth = 1;
    line(ctx, 70, 273, 930, 273);
    for (let index = 0; index <= COMPARTMENTS.length; index++) {
      const x = HULL_LEFT + ROOM_WIDTH * index;
      line(ctx, x, 268, x, 278);
    }
  };
}

const byId = (id) => document.getElementById(id);
const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
const setPressed = (button, value) => { if (button.ariaPressed !== String(value)) button.ariaPressed = String(value); };
const percent = (value) => `${Math.round(value)}%`;
const labels = new Map(COMPARTMENTS.map(({ id, label }) => [id, label]));

function makeButton(className, label, parent) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.ariaPressed = 'false';
  const title = document.createElement('span');
  title.textContent = label;
  button.append(title);
  parent.append(button);
  return button;
}

export function createControlRoomView({ state, blocked }) {
  const panel = byId('control-room');
  const tab = byId('control-room-tab');
  const zones = byId('cutaway-zones');
  const crew = byId('crew-squads');
  const rest = byId('crew-rest');
  const pump = byId('pump-bilges');
  const vent = byId('ventilate-hull');
  const banner = byId('damage-room-status');
  const trim = byId('damage-trim');
  const name = byId('compartment-name');
  const system = byId('compartment-system');
  const water = byId('compartment-water');
  const damage = byId('compartment-damage');
  const gas = byId('compartment-gas');
  const instructions = byId('crew-instruction');
  const pumpStatus = byId('bilge-status');
  const ventStatus = byId('vent-status');
  const draw = createControlRoomRenderer(byId('control-room-canvas'));
  let selectedRoom = COMPARTMENTS.find(({ id }) => id === 'control');
  let selectedSquad = null;
  let previousSub;

  const canIssueOrder = () => !blocked() && state.boat.hull > 0 && !campaignEnded(state);
  const zoneButtons = COMPARTMENTS.map((room) => {
    const button = makeButton('cutaway-zone', room.label, zones);
    button.ariaLabel = room.name;
    button.title = room.name;
    button.dataset.compartment = room.id;
    button.addEventListener('click', () => {
      selectedRoom = room;
      if (selectedSquad !== null && canIssueOrder()) assignSquad(state.sub, selectedSquad, room.id);
    });
    return button;
  });
  const squadButtons = CREW_SQUADS.map((letter, index) => {
    const button = makeButton('tactical-toggle crew-card', `Squad ${letter}`, crew);
    const assignment = document.createElement('span');
    const fatigue = document.createElement('small');
    button.append(assignment, fatigue);
    button.addEventListener('click', () => { selectedSquad = selectedSquad === index ? null : index; });
    return { button, assignment, fatigue };
  });

  rest.addEventListener('click', () => {
    if (selectedSquad !== null && canIssueOrder()) assignSquad(state.sub, selectedSquad, null);
  });
  pump.addEventListener('click', () => {
    if (canIssueOrder() && (state.sub.bilgePumpOn || canPumpBilges(state))) state.sub.bilgePumpOn = !state.sub.bilgePumpOn;
  });
  vent.addEventListener('click', () => {
    if (canIssueOrder() && (state.sub.ventilating || canVentilate(state))) state.sub.ventilating = !state.sub.ventilating;
  });

  return {
    setActive(active) { panel.hidden = !active; },
    update(now) {
      const { boat, sub } = state;
      const highestGas = peakChlorine(sub);
      const flooding = floodingLoad(sub) > 0;
      const impaired = Object.values(sub.compartments).some(({ mechanicalDamage }) => mechanicalDamage > 0);
      const alert = highestGas >= CHLORINE_DANGER ? 'gas' : flooding || impaired || highestGas > 0 ? 'damage' : '';
      const globalStatus = highestGas >= CHLORINE_DANGER ? 'Chlorine danger · surface and ventilate' : 'Compartment damage or flooding';
      if (tab.dataset.alert !== alert) {
        tab.dataset.alert = alert;
        tab.title = alert ? globalStatus : 'Damage and crew';
      }
      if (panel.hidden) return;
      if (sub !== previousSub) {
        previousSub = sub;
        selectedSquad = null;
      }

      const available = canIssueOrder();
      const drift = depthDrift(boat, sub);
      banner.parentElement.dataset.alert = alert;
      let status = 'Compartments dry';
      if (!boat.hull) status = 'Boat lost';
      else if (sub.ventilating) status = 'Ventilating hull';
      else if (highestGas >= CHLORINE_DANGER) status = boat.depth > 0 ? globalStatus : 'Chlorine danger · ventilate hull';
      else if (highestGas > 0) status = 'Chlorine detected';
      else if (flooding) status = 'Flooding reported';
      else if (impaired) status = 'Mechanical damage reported';
      setText(banner, status);
      let trimStatus = '';
      if (boat.blowingBallast) trimStatus = 'Blowing ballast';
      else if (boat.ballastHoldSeconds > 0) trimStatus = `Ballast holding ${Math.ceil(boat.ballastHoldSeconds)} s`;
      else if (drift > 0.01) trimStatus = `Downward trim · ${(drift * 60).toFixed(1)} m/min`;
      else if (flooding && boat.speed >= TRIM_SPEED_KNOTS) trimStatus = 'Forward speed holding trim';
      setText(trim, trimStatus);

      const selected = sub.compartments[selectedRoom.id];
      const efficiency = selectedRoom.id === 'quarters' && !sub.sensors.hydrophoneEquipped
        ? 'Hydrophone not fitted' : `${selectedRoom.system} · ${percent(compartmentEfficiency(sub, selectedRoom.id) * 100)}`;
      setText(name, selectedRoom.name);
      setText(system, efficiency);
      setText(water, percent(selected.floodingLevel));
      setText(damage, percent(selected.mechanicalDamage));
      setText(gas, percent(selected.chlorineGasLevel));
      for (const [index, button] of zoneButtons.entries()) {
        const room = COMPARTMENTS[index];
        const conditions = sub.compartments[room.id];
        setPressed(button, room === selectedRoom);
        button.dataset.affected = String(Object.values(conditions).some((value) => value > 0));
      }
      for (const [index, card] of squadButtons.entries()) {
        const squad = sub.crewSquads[index];
        setPressed(card.button, selectedSquad === index);
        card.button.dataset.incapacitated = String(squad.incapacitated);
        const station = labels.get(squad.assignment) ?? 'Resting';
        setText(card.assignment, squad.incapacitated ? 'Incapacitated' : station);
        setText(card.fatigue, `${percent(squad.fatigue)} tired`);
        card.button.title = `Squad ${CREW_SQUADS[index]} · ${station} · ${percent(squad.chlorineExposure)} gas exposure`;
      }

      const squad = selectedSquad === null ? null : sub.crewSquads[selectedSquad];
      rest.disabled = !available || !squad || squad.incapacitated || squad.assignment === null;
      pump.disabled = !available || (!sub.bilgePumpOn && !canPumpBilges(state));
      vent.disabled = !available || (!sub.ventilating && !canVentilate(state));
      setPressed(pump, sub.bilgePumpOn);
      setPressed(vent, sub.ventilating);
      setText(pumpStatus, sub.bilgePumpOn ? 'Draining · battery in use' : flooding && boat.battery <= 0 ? 'Battery depleted' : 'Battery powered');
      setText(ventStatus, sub.ventilating ? 'Hatches open' : boat.depth > 0 ? 'Surface to vent' : highestGas > 0 ? 'Ready to vent' : 'Air clear');
      let instruction = 'Select a squad, then click a compartment.';
      if (squad?.incapacitated) instruction = 'Squad incapacitated. Clear the gas for recovery.';
      else if (squad) instruction = `Squad ${CREW_SQUADS[selectedSquad]} · ${labels.get(squad.assignment) ?? 'Resting in Quarters'}. Click a compartment to assign.`;
      else if (drift > 0.01 && flooding) instruction = `Make ${TRIM_SPEED_KNOTS} kn or blow ballast to arrest sinking.`;
      setText(instructions, instruction);
      draw(sub, now);
    },
  };
}
