import { LANDMASSES } from './chart.js';
import { torpedoModel, wakeLength, wakePoint } from './torpedoes.js';

const DEG = Math.PI / 180;

export function createTacticalProjection(width, height, origin) {
  const left = 24;
  const right = width - 24;
  const top = 22;
  const bottom = height - 22;
  const x = width / 2;
  const y = height / 2;
  const radius = 6.8;
  const pixelsPerNm = Math.min(right - left, bottom - top) / (2 * radius);
  const yScale = pixelsPerNm * 60;
  const xScale = yScale * Math.cos(origin.lat * DEG);
  return {
    left, right, top, bottom, xScale, yScale, pixelsPerNm, radius, origin,
    project(lon, lat) { return { x: x + (lon - origin.lon) * xScale, y: y - (lat - origin.lat) * yScale }; },
    invert(px, py) { return { lon: origin.lon + (px - x) / xScale, lat: origin.lat - (py - y) / yScale }; },
  };
}

export function drawTacticalBackdrop(ctx, chart, width, height) {
  const { left, right, top, bottom, pixelsPerNm, origin } = chart;
  const center = chart.project(origin.lon, origin.lat);
  ctx.fillStyle = '#192522';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  const sea = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, width * 0.65);
  sea.addColorStop(0, '#29433e');
  sea.addColorStop(1, '#182e2e');
  ctx.fillStyle = sea;
  ctx.fillRect(left, top, right - left, bottom - top);

  const northwest = chart.invert(left, top);
  const southeast = chart.invert(right, bottom);
  ctx.beginPath();
  for (const land of LANDMASSES) {
    if (land.west > southeast.lon || land.east < northwest.lon || land.south > northwest.lat || land.north < southeast.lat) continue;
    land.ring.forEach(([lon, lat], index) => {
      const { x, y } = chart.project(lon, lat);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = '#535942';
  ctx.strokeStyle = '#ac9c76';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = '#9bb1a134';
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.moveTo(center.x, top);
  ctx.lineTo(center.x, bottom);
  ctx.moveTo(left, center.y);
  ctx.lineTo(right, center.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#aab8a5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const nm of [2, 4, 6]) {
    const range = nm * pixelsPerNm;
    ctx.beginPath();
    ctx.arc(center.x, center.y, range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${nm} NM`, center.x, center.y - range - 4);
  }
  ctx.restore();

  ctx.strokeStyle = '#737760';
  ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
  ctx.fillStyle = '#b9ba9c';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', center.x, top - 6);
}

export function drawFireSolution(ctx, chart, boat, control) {
  const { target, solution } = control;
  if (!target || target.source === 'lost') return;
  const origin = chart.project(boat.position.lon, boat.position.lat);
  const contact = chart.project(target.position.lon, target.position.lat);
  ctx.save();
  ctx.strokeStyle = boat.depth === 0 ? '#e5be7c' : '#9de0d1';
  ctx.lineWidth = 1.4;
  if (target.source === 'estimated') ctx.setLineDash([2, 3]);
  ctx.strokeRect(contact.x - 10, contact.y - 10, 20, 20);

  if (boat.depth === 0) {
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(contact.x, contact.y);
    ctx.stroke();
  } else if (solution) {
    const intercept = chart.project(solution.point.lon, solution.point.lat);
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(intercept.x, intercept.y);
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(contact.x, contact.y);
    ctx.lineTo(intercept.x, intercept.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(intercept.x, intercept.y - 5);
    ctx.lineTo(intercept.x + 5, intercept.y);
    ctx.lineTo(intercept.x, intercept.y + 5);
    ctx.lineTo(intercept.x - 5, intercept.y);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function drawProjectile(ctx, chart, projectile, elapsed) {
  ctx.beginPath();
  if (projectile.kind === 'torpedo') {
    const { bubbleWakeVisibility } = torpedoModel(projectile.torpedoId).stealth;
    const length = wakeLength(projectile);
    const bubbles = Math.max(1, Math.ceil(length * (chart.pixelsPerNm ?? 6) / 2));
    ctx.fillStyle = '#f1f7f9';
    for (let i = 0; i < bubbles; i++) {
      const age = i / bubbles;
      const { lon, lat } = wakePoint(projectile, length * age);
      const { x, y } = chart.project(lon, lat);
      ctx.globalAlpha = bubbleWakeVisibility * (0.55 - age * 0.44);
      ctx.beginPath();
      ctx.arc(x, y + Math.sin(i * 2.3) * age, 0.8 + age * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  } else {
    const { origin, aim, launchAt, impactAt } = projectile;
    const start = chart.project(origin.lon, origin.lat);
    const end = chart.project(aim.lon, aim.lat);
    const progress = Math.min(1, (elapsed - launchAt) / (impactAt - launchAt));
    const tail = Math.max(0, progress - 0.18);
    ctx.moveTo(start.x + (end.x - start.x) * tail, start.y + (end.y - start.y) * tail);
    ctx.lineTo(start.x + (end.x - start.x) * progress, start.y + (end.y - start.y) * progress);
    ctx.strokeStyle = projectile.owner === 'player' ? '#ffe4a3' : '#fa866d';
    ctx.lineWidth = 2;
  }
  ctx.stroke();
}

function drawBurst(ctx, point, kind, progress) {
  const isExplosion = kind === 'explosion';
  const isSplash = kind === 'splash';
  const count = isExplosion ? 25 : 10;
  const spread = (isExplosion ? 39 : isSplash ? 24 : 15) * Math.sqrt(progress);
  ctx.globalAlpha = (1 - progress) ** 1.4;
  for (let index = 0; index < count; index++) {
    const angle = index * 2.39996;
    const distance = spread * (0.35 + (index % 7) / 9);
    const x = point.x + Math.cos(angle) * distance;
    const y = point.y + Math.sin(angle) * distance * 0.72 - (isExplosion ? 14 * progress : 0);
    ctx.fillStyle = isSplash ? '#bfdfdf' : ['#ffdfa1', '#e99348', '#f6be6c', '#9e5c43'][index % 4];
    ctx.beginPath();
    ctx.arc(x, y, 0.8 + (index % 3) * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }
  if (isExplosion || isSplash) {
    ctx.strokeStyle = isExplosion ? '#f5c587' : '#c4e7e4';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(point.x, point.y, 3 + progress * 31, 2 + progress * 16, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawWreck(ctx, chart, record, progress) {
  const { x, y } = chart.project(record.position.lon, record.position.lat);
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  ctx.strokeStyle = '#b2cfc7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, y, 5 + progress * 19, 3 + progress * 12, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.translate(x, y + 10 * progress);
  const heading = record.heading * DEG;
  ctx.rotate(Math.atan2(Math.sin(heading) * chart.xScale / Math.cos(record.position.lat * DEG),
    Math.cos(heading) * chart.yScale) + progress * 0.95);
  ctx.scale(1 - progress * 0.5, 1 - progress * 0.72);
  ctx.fillStyle = '#b68c71';
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(4, -5);
  ctx.lineTo(4, 8);
  ctx.lineTo(-4, 8);
  ctx.lineTo(-4, -5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function createCombatOverlay() {
  const firstFrame = new WeakMap();

  function progress(event, now, duration) {
    if (!firstFrame.has(event)) firstFrame.set(event, now);
    return (now - firstFrame.get(event)) / duration;
  }

  return (ctx, chart, state) => {
    const now = performance.now();
    ctx.save();
    for (const projectile of state.combat.projectiles) drawProjectile(ctx, chart, projectile, state.elapsed);
    // Real-time animation keeps impacts readable even when the simulation runs at 50×.
    for (const effect of state.combat.effects) {
      const duration = effect.kind === 'wreck' ? 4700 : effect.kind === 'explosion' ? 1750 : 850;
      const age = progress(effect, now, duration);
      if (age >= 1) continue;
      if (effect.kind === 'wreck') drawWreck(ctx, chart, effect, age);
      else drawBurst(ctx, chart.project(effect.position.lon, effect.position.lat), effect.kind, age);
    }
    ctx.restore();
  };
}
