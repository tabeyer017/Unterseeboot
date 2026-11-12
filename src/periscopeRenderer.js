import { campaignTime } from './campaign.js';
import { GAME_DATA } from './dataLoader.js';
import { bearingDelta, bearingTo, distanceTo, METERS_PER_NM, wrapHeading } from './navigation.js';
import { drawOpticalProjectiles } from './opticalProjectiles.js';

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const roster = new Map(GAME_DATA.ships.map((ship) => [ship.id, ship.recognition]));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const noise = (index) => ((Math.sin(index * 91.3458 + 13.73) * 43758.5453) % 1 + 1) % 1;

export function opticalFieldOfView(mode, zoom) {
  return (mode === 'binoculars' ? 49 : 37) * 1.5 / zoom;
}

function makeLens(width, height, mode, zoom) {
  const binoculars = mode === 'binoculars';
  const radius = Math.min(height * 0.46, width * (binoculars ? 0.318 : 0.46));
  const separation = binoculars ? radius * 0.92 : 0;
  const x = width / 2;
  const y = height / 2;
  const centers = binoculars ? [x - separation / 2, x + separation / 2] : [x];
  const mask = new Path2D();
  if (binoculars) {
    const join = Math.acos(separation / (2 * radius));
    mask.arc(centers[0], y, radius, join, TAU - join);
    mask.arc(centers[1], y, radius, Math.PI + join, 3 * Math.PI - join);
  } else {
    mask.arc(x, y, radius, 0, TAU);
  }
  mask.closePath();
  const halfWidth = radius + separation / 2;
  const focal = halfWidth / Math.tan(opticalFieldOfView(mode, zoom) * RAD / 2);
  return { x, y, radius, halfWidth, focal, mask, binoculars };
}

export function silhouetteAspect(heading, observerBearing) {
  const angle = bearingDelta(heading, observerBearing);
  return { angle, side: Math.sin(angle * RAD), end: Math.cos(angle * RAD) };
}

function projectedHullWidth(profile, aspect) {
  return profile.lengthMeters * Math.abs(aspect.side) + profile.beamMeters * Math.abs(aspect.end);
}

export function projectOpticalContacts(boat, contacts, bearing, lens, horizon, storm = false) {
  const eyeHeight = lens.binoculars ? 7 : 1.6;
  return contacts.flatMap((contact) => {
    const profile = roster.get(contact.type);
    const trueBearing = bearingTo(boat.position, contact.position);
    const relative = bearingDelta(bearing, trueBearing) * RAD;
    if (!profile || Math.abs(relative) >= Math.PI / 2) return [];
    const range = distanceTo(boat.position, contact.position) * METERS_PER_NM;
    const sightline = 3570 * (Math.sqrt(eyeHeight) + Math.sqrt(profile.mastHeightMeters));
    if (range > sightline * (storm ? 0.49 : 1)) return [];
    const forward = Math.max(15, range * Math.cos(relative));
    const unit = lens.focal / forward;
    const x = lens.x + lens.focal * Math.tan(relative);
    const aspect = silhouetteAspect(contact.heading, bearingTo(contact.position, boat.position));
    const width = projectedHullWidth(profile, aspect) * unit;
    if (Math.abs(x - lens.x) > lens.halfWidth + width / 2) return [];
    return [{ contact, profile, trueBearing, aspect, unit, x, y: horizon + unit * eyeHeight, width, distance: forward }];
  }).sort((left, right) => right.distance - left.distance);
}

function drawShip(ctx, { profile, aspect, unit, x, y }, color, highlight) {
  const { lengthMeters, beamMeters, mastHeightMeters, bridge, masts, funnels } = profile;
  const width = projectedHullWidth(profile, aspect);
  const half = width / 2;
  const freeboard = mastHeightMeters * (aspect.end < -0.75 ? 0.23 : 0.18);
  const deck = -freeboard;
  const bow = aspect.side <= 0 ? -1 : 1;
  const offset = (position) => -position * lengthMeters * aspect.side;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(unit, unit);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-half, deck - freeboard * (bow < 0 ? 0.42 : 0));
  ctx.quadraticCurveTo(-half * 0.93, -freeboard * 0.35, -half * 0.73, 0);
  ctx.lineTo(half * 0.8, 0);
  ctx.quadraticCurveTo(half * 0.98, -freeboard * 0.3, half, deck - freeboard * (bow > 0 ? 0.42 : 0));
  ctx.lineTo(half * 0.62, deck);
  ctx.lineTo(-half * 0.62, deck);
  ctx.closePath();
  ctx.fill();

  const bridgeWidth = beamMeters * (0.63 + Math.abs(aspect.side) * 0.5);
  const bridgeX = offset(bridge);
  ctx.fillRect(bridgeX - bridgeWidth * 0.72, deck - mastHeightMeters * 0.18, bridgeWidth * 1.44, mastHeightMeters * 0.19);
  ctx.fillRect(bridgeX - bridgeWidth * 0.44, deck - mastHeightMeters * 0.32, bridgeWidth * 0.88, mastHeightMeters * 0.15);
  for (const funnel of funnels) {
    const stackX = offset(funnel);
    const stackWidth = beamMeters * 0.27;
    ctx.fillRect(stackX - stackWidth / 2, -mastHeightMeters * 0.66, stackWidth, mastHeightMeters * 0.49);
    ctx.fillRect(stackX - stackWidth * 0.61, -mastHeightMeters * 0.69, stackWidth * 1.22, mastHeightMeters * 0.06);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.38 / unit, 0.42);
  for (const mast of masts) {
    const mastX = offset(mast);
    ctx.beginPath();
    ctx.moveTo(mastX, deck);
    ctx.lineTo(mastX - 0.7, -mastHeightMeters);
    ctx.moveTo(mastX - beamMeters * 0.18, -mastHeightMeters * 0.8);
    ctx.lineTo(mastX + beamMeters * 0.17, -mastHeightMeters * 0.8);
    ctx.stroke();
  }
  if (unit > 0.35) {
    ctx.strokeStyle = highlight;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.moveTo(-half * 0.75, -freeboard * 0.42);
    ctx.lineTo(half * 0.77, -freeboard * 0.42);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawRecognitionProfile(canvas, vessel) {
  const ctx = canvas.getContext('2d');
  const profile = vessel.recognition;
  const { width, height } = canvas;
  const unit = Math.min((width - 18) / profile.lengthMeters, (height - 12) / profile.mastHeightMeters);
  ctx.strokeStyle = '#8ca39a80';
  ctx.beginPath();
  ctx.moveTo(3, height - 7.5);
  ctx.lineTo(width - 3, height - 7.5);
  ctx.stroke();
  drawShip(ctx, { profile, aspect: silhouetteAspect(0, 90), unit, x: width / 2, y: height - 8 }, '#d1d0b2', '#566d66');
}

function mix(low, high, amount) {
  return `rgb(${low.map((channel, index) => Math.round(channel + (high[index] - channel) * amount)).join(',')})`;
}

function lighting(state) {
  const date = new Date(campaignTime(state));
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + state.boat.position.lon / 15;
  const sun = Math.sin((hours - 6) * TAU / 24);
  const light = clamp((sun + 0.36) / 0.86, 0, 1);
  return { light, dusk: Math.max(0, 1 - Math.abs(sun) * 3.2) };
}

function drawAtmosphere(ctx, state, width, height, horizon, time, palette) {
  const { light, dusk } = palette;
  const storm = state.weather === 'storm';
  const illumination = storm ? light * 0.55 : light;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, mix([21, 36, 46], [107, 132, 139], illumination));
  sky.addColorStop(0.68, mix([60, 76, 83], [157, 176, 174], illumination));
  sky.addColorStop(1, mix([82, 97, 101], [204, 203, 182], illumination * 0.8 + dusk * 0.2));
  ctx.fillStyle = sky;
  ctx.fillRect(-30, -30, width + 60, horizon + 31);

  // Thin cloud banks with soft edges and subdued North Atlantic color.
  for (let i = 0; i < 17; i++) {
    const x = ((noise(i + 20) * width + time * (2 + i % 4)) % (width + 180)) - 90;
    const y = horizon * (0.08 + 0.75 * noise(i + 61));
    const size = 58 + 160 * noise(i + 88);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.08 + 0.16 * noise(i + 3));
    const cloud = ctx.createRadialGradient(0, 0, 0, 0, 0, size);
    cloud.addColorStop(0, storm ? '#2e424b8c' : '#d4d5bf32');
    cloud.addColorStop(1, storm ? '#2e424b00' : '#d4d5bf00');
    ctx.fillStyle = cloud;
    ctx.fillRect(-size, -size, size * 2, size * 2);
    ctx.restore();
  }

  const water = ctx.createLinearGradient(0, horizon, 0, height);
  water.addColorStop(0, mix([64, 85, 90], [106, 129, 128], illumination));
  water.addColorStop(0.45, mix([38, 60, 65], [70, 98, 97], illumination));
  water.addColorStop(1, mix([16, 34, 42], [35, 62, 65], illumination));
  ctx.fillStyle = water;
  ctx.fillRect(-30, horizon, width + 60, height - horizon + 40);

  for (let row = 0; row < 43; row++) {
    const depth = (row + 1) / 44;
    const y = horizon + depth ** 2 * (height - horizon + 21);
    const amplitude = (0.15 + depth ** 2 * 3.6) * (storm ? 2 : 1);
    ctx.beginPath();
    for (let x = -24; x <= width + 28; x += 9) {
      const wave = Math.sin(x / (7 + depth * 62) + row * 0.91 - time * (1.15 + depth))
        + 0.46 * Math.sin(x / (5 + depth * 19) - row * 0.47 + time * 1.43);
      ctx.lineTo(x, y + wave * amplitude);
    }
    ctx.strokeStyle = row % 3 === 0 ? '#d6dfd13b' : '#152e394c';
    ctx.lineWidth = 0.45 + depth * 0.8;
    ctx.stroke();
  }

  const fog = ctx.createLinearGradient(0, horizon - 43, 0, horizon + 28);
  fog.addColorStop(0, '#abbcbb00');
  fog.addColorStop(0.58, storm ? '#a9b8b7a4' : '#a9b8b745');
  fog.addColorStop(1, '#abbcbb00');
  ctx.fillStyle = fog;
  ctx.fillRect(-30, horizon - 43, width + 60, 71);
}

function drawRain(ctx, width, height, time) {
  ctx.beginPath();
  for (let i = 0; i < 100; i++) {
    const x = ((noise(i + 80) * (width + 80) - time * 105) % (width + 80) + width + 80) % (width + 80);
    const y = (noise(i + 42) * (height + 36) + time * (280 + 200 * noise(i + 2))) % (height + 36) - 18;
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, y + 8 + 11 * noise(i + 6));
  }
  ctx.strokeStyle = '#d4e0de48';
  ctx.lineWidth = 0.65;
  ctx.stroke();
}

function drawReticle(ctx, lens, bearing, zoom) {
  const { x, y, focal, radius, halfWidth, binoculars } = lens;
  const limit = radius * 0.57;
  ctx.strokeStyle = '#e6dcabac';
  ctx.fillStyle = '#ece4c3db';
  ctx.lineWidth = 1;
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.beginPath();
  ctx.moveTo(x - limit, y);
  ctx.lineTo(x - 7, y);
  ctx.moveTo(x + 7, y);
  ctx.lineTo(x + limit, y);
  ctx.moveTo(x, y - limit);
  ctx.lineTo(x, y - 7);
  ctx.moveTo(x, y + 7);
  ctx.lineTo(x, y + limit);
  ctx.moveTo(x - 4, y);
  ctx.lineTo(x + 4, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.stroke();

  const major = zoom === 6 ? 2 : 5;
  ctx.beginPath();
  for (let degree = Math.floor(bearing - 30); degree <= bearing + 30; degree++) {
    const dx = focal * Math.tan((degree - bearing) * RAD);
    if (Math.abs(dx) > halfWidth * 0.76 || Math.abs(dx) < 8) continue;
    const long = degree % major === 0;
    ctx.moveTo(x + dx, y - 4);
    ctx.lineTo(x + dx, y - (long ? 14 : 8));
    if (long && (binoculars || Math.abs(dx) > 29)) ctx.fillText(String(wrapHeading(degree)).padStart(3, '0'), x + dx, y - 21);
  }
  ctx.stroke();

  if (!binoculars) {
    const milStep = zoom === 6 ? 5 : 20;
    ctx.textAlign = 'left';
    ctx.fillText('MIL', x + 7, y - limit - 6);
    for (let mils = milStep; mils * focal / 1000 < limit; mils += milStep) {
      const offset = Math.tan(mils / 1000) * focal;
      if (offset < 8) continue;
      for (const sign of [-1, 1]) {
        const at = y + offset * sign;
        ctx.beginPath();
        ctx.arc(x, at, mils % (milStep * 2) === 0 ? 1.9 : 1.3, 0, TAU);
        ctx.fill();
        if (mils % (milStep * 2) === 0) ctx.fillText(String(mils), x + 7, at);
      }
    }
  } else {
    ctx.strokeRect(x - 13, y - 9, 26, 18);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + side * 33, y - 7);
      ctx.lineTo(x + side * 41, y - 7);
      ctx.lineTo(x + side * 41, y + 7);
      ctx.lineTo(x + side * 33, y + 7);
      ctx.stroke();
    }
  }
}

function drawImpact(ctx, effect, age, state, bearing, lens, horizon) {
  const range = distanceTo(state.boat.position, effect.position) * METERS_PER_NM;
  if (range < 15 || !['splash', 'explosion'].includes(effect.kind)) return;
  const relative = bearingDelta(bearing, bearingTo(state.boat.position, effect.position)) * RAD;
  if (Math.abs(relative) > 1) return;
  const x = lens.x + lens.focal * Math.tan(relative);
  if (Math.abs(x - lens.x) > lens.halfWidth + 30) return;
  const scale = clamp(lens.focal * 39 / range, 5, 65);
  const explosion = effect.kind === 'explosion';
  const progress = age / (explosion ? 1.6 : 1.05);
  if (progress >= 1) return;
  ctx.save();
  ctx.globalAlpha = (1 - progress) * 0.92;
  for (let i = 0; i < 17; i++) {
    const rise = scale * (0.18 + noise(i + 46)) * Math.sin(progress * Math.PI * 0.84);
    const dx = (noise(i + 7) - 0.5) * scale * (0.45 + progress);
    ctx.fillStyle = explosion ? (progress < 0.42 ? ['#ffe0a1', '#f19651', '#8a563e'][i % 3] : '#555052') : '#d8e2df';
    ctx.beginPath();
    ctx.ellipse(x + dx, horizon - rise, 0.8 + scale * (0.04 + progress * 0.11), 1.5 + scale * (explosion ? 0.12 : 0.07), 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

export function createPeriscopeRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const effectsSeen = new WeakMap();
  let projected = [];
  let recoil = null;

  return {
    observeEffects(effects, now) {
      for (const effect of effects) if (!effectsSeen.has(effect)) effectsSeen.set(effect, now);
    },
    recoil(weapon, now, projectile) { recoil = { weapon, now, projectile }; },
    contactAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return projected.findLast((item) => Math.abs(x - item.screenX) <= Math.max(10, item.width / 2 + 4)
        && y >= item.screenY - Math.max(12, item.profile.mastHeightMeters * item.unit) - 5 && y <= item.screenY + 9);
    },
    draw(state, contacts, { mode, bearing, zoom }, now) {
      const { width, height } = canvas.getBoundingClientRect();
      projected = [];
      if (!width || !height) return null;
      const pixelRatio = window.devicePixelRatio || 1;
      const pixelsWide = Math.round(width * pixelRatio);
      const pixelsHigh = Math.round(height * pixelRatio);
      if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
        canvas.width = pixelsWide;
        canvas.height = pixelsHigh;
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      if (!mode) {
        const water = ctx.createLinearGradient(0, 0, 0, height);
        water.addColorStop(0, '#0a1113');
        water.addColorStop(1, '#020405');
        ctx.fillStyle = water;
        ctx.fillRect(0, 0, width, height);
        return null;
      }
      const time = now / 1000;
      const lens = makeLens(width, height, mode, zoom);
      const { x, y, halfWidth, radius, mask } = lens;
      const housing = ctx.createRadialGradient(x, y, radius * 0.45, x, y, Math.max(width, height) * 0.7);
      housing.addColorStop(0, '#252b29');
      housing.addColorStop(1, '#0b1111');
      ctx.fillStyle = housing;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.clip(mask);
      const storm = state.weather === 'storm';
      const amplitude = storm ? 5.5 : 2.8;
      const kickAge = recoil ? (now - recoil.now) / 1000 : Infinity;
      const kick = kickAge < 0.48 ? Math.sin(kickAge * 30) * (1 - kickAge / 0.48) * (recoil.weapon === 'deck' ? 15 : 5) : 0;
      const horizon = y + radius * 0.015 + amplitude * Math.sin(time * 1.12) + kick;
      const roll = Math.sin(time * 0.83) * (storm ? 0.017 : 0.008);
      ctx.save();
      ctx.translate(x, horizon);
      ctx.rotate(roll);
      ctx.translate(-x, -horizon);
      const palette = lighting(state);
      drawAtmosphere(ctx, state, width, height, horizon, time, palette);
      projected = projectOpticalContacts(state.boat, contacts.visual, bearing, lens, horizon, storm);
      for (const item of projected) {
        const haze = clamp(item.distance / (storm ? 14000 : 26000), 0, 0.78);
        drawShip(ctx, item, mix([31, 42, 45], [119, 137, 138], haze), '#84938a');
        item.screenX = x + (item.x - x) * Math.cos(roll) - (item.y - horizon) * Math.sin(roll);
        item.screenY = horizon + (item.x - x) * Math.sin(roll) + (item.y - horizon) * Math.cos(roll);
      }
      drawOpticalProjectiles(ctx, state, bearing, lens, horizon, recoil, now);
      for (const effect of state.combat.effects) {
        const seen = effectsSeen.get(effect);
        if (seen !== undefined) drawImpact(ctx, effect, (now - seen) / 1000, state, bearing, lens, horizon);
      }
      ctx.restore();
      if (storm) drawRain(ctx, width, height, time);
      if (kickAge < 0.12 && recoil.weapon === 'deck') {
        ctx.fillStyle = `rgba(245, 199, 115, ${0.32 * (1 - kickAge / 0.12)})`;
        ctx.fillRect(0, y + radius * 0.52, width, radius);
      }

      const vignette = ctx.createRadialGradient(x, y, radius * 0.35, x, y, halfWidth * 1.02);
      vignette.addColorStop(0, '#070d0e00');
      vignette.addColorStop(0.64, '#070d0e12');
      vignette.addColorStop(1, '#070d0edb');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);
      drawReticle(ctx, lens, bearing, zoom);
      ctx.restore();

      ctx.save();
      ctx.clip(mask);
      ctx.strokeStyle = '#090f11';
      ctx.lineWidth = 6;
      ctx.stroke(mask);
      ctx.restore();
      ctx.strokeStyle = '#929b7752';
      ctx.lineWidth = 1.5;
      ctx.stroke(mask);

      let centered = null;
      let nearest = Infinity;
      for (const item of projected) {
        const offset = Math.abs(item.screenX - x);
        if (offset <= Math.max(14, item.width / 2 + 6) && offset < nearest) {
          centered = item;
          nearest = offset;
        }
      }
      return centered;
    },
  };
}
