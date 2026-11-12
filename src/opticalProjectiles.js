import { advancePosition, bearingDelta, bearingTo, distanceTo, METERS_PER_NM } from './navigation.js';
import { torpedoModel, wakeLength, wakePoint } from './torpedoes.js';

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;

function project(view, position, height) {
  const distance = distanceTo(view.position, position) * METERS_PER_NM;
  const angle = bearingDelta(view.bearing, bearingTo(view.position, position)) * RAD;
  const forward = distance * Math.cos(angle);
  if (forward < 4) return null;

  const scale = view.focal / forward;
  return {
    x: view.x + Math.sin(angle) * distance * scale,
    y: view.horizon + (view.eyeHeight - height) * scale,
    scale,
  };
}

function dot(ctx, point, radius) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, TAU);
  ctx.fill();
}

function drawTorpedo(ctx, torpedo, view) {
  const head = project(view, torpedo.position, -0.8);
  if (!head || Math.abs(head.x - view.x) > view.halfWidth + 18) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x - view.halfWidth, view.horizon, view.halfWidth * 2, view.radius * 2);
  ctx.clip();

  const { bubbleWakeVisibility } = torpedoModel(torpedo.torpedoId).stealth;
  const length = wakeLength(torpedo);
  const tailOffset = Math.min(length, 4 / METERS_PER_NM);
  ctx.fillStyle = '#d8efeb';
  for (let index = 11; index >= 0; index--) {
    const age = index / 12;
    const offset = tailOffset + (length - tailOffset) * age ** 1.7;
    const bubble = project(view, wakePoint(torpedo, offset), -0.65 * (1 - age));
    if (!bubble) continue;
    ctx.globalAlpha = bubbleWakeVisibility * (1 - age) * 0.86;
    const spread = Math.min(3.4, bubble.scale * 0.8 + 0.5);
    bubble.x += Math.sin(index * 2.4) * spread;
    dot(ctx, bubble, Math.min(2.1, 0.72 + bubble.scale * 0.32));
  }

  const forward = project(view, advancePosition(torpedo.position, torpedo.bearing, 6 / METERS_PER_NM), -0.8);
  const angle = forward ? Math.atan2(forward.y - head.y, forward.x - head.x) : -Math.PI / 2;
  const size = Math.max(3.4, Math.min(20, forward ? Math.hypot(forward.x - head.x, forward.y - head.y) : 0));
  ctx.globalAlpha = 0.95;
  ctx.translate(head.x, Math.max(head.y, view.horizon + 2));
  ctx.rotate(angle);
  ctx.fillStyle = '#11272b';
  ctx.strokeStyle = '#99d0cb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(-size * 0.35, 0, size * 0.63, Math.max(1.45, Math.min(4, head.scale * 0.3)), 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#d5efdf';
  dot(ctx, { x: size * 0.23, y: 0 }, 0.9);
  ctx.restore();
}

function shellPath(shell, view) {
  const distance = distanceTo(shell.origin, shell.aim);
  const bearing = bearingTo(shell.origin, shell.aim);
  const arcHeight = Math.min(82, Math.max(10, distance * METERS_PER_NM * 0.034));
  return (progress) => {
    // The simulation supplies horizontal flight and impact time. The arc is a sight effect.
    const height = 2.8 * (1 - progress) + 4 * arcHeight * progress * (1 - progress);
    return project(view, advancePosition(shell.origin, bearing, distance * progress), height);
  };
}

function drawTracer(ctx, pointAt, start, end, color, opacity) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  let previous = pointAt(start);
  for (let index = 1; index <= 8; index++) {
    const fraction = index / 8;
    const point = pointAt(start + (end - start) * fraction);
    if (previous && point) {
      ctx.globalAlpha = opacity * fraction;
      ctx.lineWidth = 0.7 + fraction * 1.6;
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    previous = point;
  }
  ctx.restore();
  return previous;
}

export function drawOpticalProjectiles(ctx, state, bearing, lens, horizon, recoil, now) {
  const view = { ...lens, position: state.boat.position, bearing, horizon, eyeHeight: lens.binoculars ? 7 : 1.6 };
  for (const projectile of state.combat.projectiles) {
    if (projectile.kind === 'torpedo') {
      drawTorpedo(ctx, projectile, view);
      continue;
    }

    const progress = Math.max(0, Math.min(1, (state.elapsed - projectile.launchAt) / (projectile.impactAt - projectile.launchAt)));
    const color = projectile.owner === 'player' ? '#ffcf79' : '#ff916d';
    const head = drawTracer(ctx, shellPath(projectile, view), Math.max(0, progress - 0.15), progress, color, 0.95);
    if (head) {
      ctx.fillStyle = color;
      dot(ctx, head, 2.5);
      ctx.fillStyle = '#fff6ce';
      dot(ctx, head, 1.4);
    }
  }

  // Retain a brief launch trace if time compression carries a shell through impact between frames.
  const launchAge = recoil ? (now - recoil.now) / 180 : 1;
  if (recoil?.projectile?.kind === 'shell' && launchAge < 1) {
    drawTracer(ctx, shellPath(recoil.projectile, view), 0.018, 0.24, '#ffd78c', (1 - launchAge) * 0.8);
  }
}
