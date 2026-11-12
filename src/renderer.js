import { BOUNDS, LANDMASSES, PLACES, SECTORS, isOnChart, isWater } from './chart.js';
import { createCombatOverlay, createTacticalProjection, drawFireSolution, drawTacticalBackdrop } from './combat-chart.js';
import { advancePosition, distanceTo, sampleLeg } from './navigation.js';
import { HYDROPHONE_HALF_ANGLE } from './sensors.js';
import { SHIPPING_LANES } from './ships.js';
import { submarineDesignation } from './submarines.js';

const MONO = '"IBM Plex Mono", monospace';
const SANS = 'Barlow, sans-serif';
const DEG = Math.PI / 180;

const LAND_LABELS = [
  ['IRELAND', -8.35, 53.38],
  ['GREAT BRITAIN', -2.55, 54.61],
  ['FRANCE', 2, 46.45],
  ['GERMANY', 9.65, 51.05],
  ['NORWAY', 8.58, 60.78],
];

const WATER_LABELS = [
  ['NORTH ATLANTIC', -18.85, 55.0, 15],
  ['CELTIC SEA', -9.55, 49.45, 11],
  ['ENGLISH CHANNEL', -1.75, 49.91, 9],
  ['BAY OF BISCAY', -7.3, 45.8, 11],
];

// These contours add the look of a period chart. Coastlines define navigable water.
const OCEAN_CONTOURS = [
  [[-23.9, 62.4], [-20.8, 58.5], [-21.5, 56], [-24.1, 52.1], [-23.2, 48.5], [-19.9, 44.3], [-20.4, 42.4]],
  [[-21.5, 62.3], [-18.5, 58.7], [-19.4, 56.8], [-22, 52.1], [-21.2, 48.6], [-18, 44.3], [-18.7, 42.4]],
  [[-18, 62.4], [-15, 58.2], [-16, 56], [-17, 53.3], [-16.5, 50.8], [-13.5, 48.2], [-12.7, 45.9], [-14.7, 43.3]],
  [[-13.4, 62.4], [-11.6, 59.1], [-12.9, 56.1], [-13.5, 53.4], [-13.2, 51.1], [-9.75, 48.35], [-8.6, 46.1], [-11.4, 43.6]],
  [[-11, 62.4], [-9.1, 59.0], [-10.8, 56.1], [-11.9, 53.6], [-11.6, 51.5], [-7.7, 48.95], [-6.8, 46.3], [-9.5, 43.5]],
];

function createProjection(width, height) {
  const left = width < 620 ? 34 : 42;
  const top = 25;
  const right = width - 30;
  const bottom = height - 25;
  const xScale = (right - left) / (BOUNDS.east - BOUNDS.west);
  const yScale = (bottom - top) / (BOUNDS.north - BOUNDS.south);
  return {
    left, right, top, bottom, xScale, yScale,
    project(lon, lat) {
      return { x: left + (lon - BOUNDS.west) * xScale, y: top + (BOUNDS.north - lat) * yScale };
    },
    invert(x, y) {
      return { lon: BOUNDS.west + (x - left) / xScale, lat: BOUNDS.north - (y - top) / yScale };
    },
  };
}

function addRing(path, ring, chart) {
  ring.forEach(([lon, lat], index) => {
    const { x, y } = chart.project(lon, lat);
    if (index === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  path.closePath();
}

function clipMap(ctx, chart) {
  ctx.beginPath();
  ctx.rect(chart.left, chart.top, chart.right - chart.left, chart.bottom - chart.top);
  ctx.clip();
}

function drawOcean(ctx, chart) {
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = '#7d9a7e29';
  for (const contour of OCEAN_CONTOURS) {
    const points = contour.map(([lon, lat]) => chart.project(lon, lat));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    // Use the midpoint of each pair to round the line through its control point.
    for (let i = 1; i < points.length - 1; i++) {
      const point = points[i];
      const next = points[i + 1];
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    ctx.lineTo(points.at(-1).x, points.at(-1).y);
    ctx.stroke();
  }
}

function drawSectors(ctx, chart) {
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1;
  ctx.fillStyle = '#a065482b';
  ctx.strokeStyle = '#b9866aaf';
  for (const sector of SECTORS) {
    const path = new Path2D();
    addRing(path, sector.ring, chart);
    ctx.fill(path);
    ctx.stroke(path);
  }
  ctx.restore();
}

function drawShippingLanes(ctx, chart) {
  ctx.save();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = '#9ac4b4a0';
  ctx.setLineDash([6, 5, 1, 5]);
  for (const lane of Object.values(SHIPPING_LANES)) {
    const points = lane.map(([lon, lat]) => ({ lon, lat }));
    const start = chart.project(...lane[0]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < points.length; i++) traceLeg(ctx, chart, points[i - 1], points[i]);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGrid(ctx, chart) {
  ctx.lineWidth = 0.65;
  const { left, right, top, bottom } = chart;
  for (let lon = -24; lon < BOUNDS.east; lon += 1) {
    if (lon % 2 !== 0 && lon % 5 !== 0) continue;
    const { x } = chart.project(lon, 0);
    ctx.strokeStyle = lon % 5 === 0 ? '#a2ab903a' : '#a2ab901a';
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let lat = BOUNDS.south + 1; lat < BOUNDS.north; lat += 1) {
    const { y } = chart.project(0, lat);
    ctx.strokeStyle = lat % 2 === 0 ? '#a2ab9033' : '#a2ab9013';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
}

function drawRulers(ctx, chart) {
  const { left, right, top, bottom } = chart;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#77765b';
  ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
  ctx.strokeStyle = '#a99b72';
  ctx.fillStyle = '#acac94';
  ctx.font = `10px ${MONO}`;
  ctx.beginPath();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let lon = BOUNDS.west + 1; lon < BOUNDS.east; lon++) {
    const { x } = chart.project(lon, 0);
    const major = lon % 5 === 0;
    const length = major ? 5 : 2;
    ctx.moveTo(x, top);
    ctx.lineTo(x, top - length);
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom + length);
    if (major) {
      const label = lon === 0 ? '0°' : `${Math.abs(lon)}°${lon < 0 ? 'W' : 'E'}`;
      ctx.fillText(label, x, top - 13);
      ctx.fillText(label, x, bottom + 13);
    }
  }
  ctx.textAlign = 'right';
  for (let lat = BOUNDS.south + 1; lat < BOUNDS.north; lat++) {
    const { y } = chart.project(0, lat);
    const major = lat % 2 === 0;
    const length = major ? 5 : 2;
    ctx.moveTo(left, y);
    ctx.lineTo(left - length, y);
    ctx.moveTo(right, y);
    ctx.lineTo(right + length, y);
    if (major) ctx.fillText(`${lat}°N`, left - 8, y);
  }
  ctx.stroke();
}

function makeGrain(ctx) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 96;
  const tileContext = tile.getContext('2d');
  const pixels = tileContext.createImageData(tile.width, tile.height);
  let seed = 371;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const tone = seed >>> 24;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = tone < 128 ? 0 : 255;
    pixels.data[i + 3] = tone % 14;
  }
  tileContext.putImageData(pixels, 0, 0);
  return ctx.createPattern(tile, 'repeat');
}

function drawLabels(ctx, chart, compact) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#a2b3a29e';
  for (const [name, lon, lat, size] of WATER_LABELS) {
    if (compact && name === 'ENGLISH CHANNEL') continue;
    const { x, y } = chart.project(lon, lat);
    ctx.font = `600 ${compact ? size - 1 : size}px ${SANS}`;
    ctx.letterSpacing = size >= 14 && !compact ? '3.5px' : '1.7px';
    ctx.fillText(name, x, y);
  }

  for (const [name, lon, lat] of LAND_LABELS) {
    const { x, y } = chart.project(lon, lat);
    ctx.fillStyle = '#ece3bd';
    ctx.strokeStyle = '#30382b';
    ctx.lineWidth = 2.5;
    ctx.letterSpacing = compact ? '0.8px' : '1.8px';
    ctx.font = `600 ${compact ? 10 : 12}px ${SANS}`;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
  }

  for (const sector of SECTORS) {
    const { x, y } = chart.project(...sector.label);
    ctx.letterSpacing = '1.7px';
    ctx.font = `600 ${compact ? 10 : 11}px ${SANS}`;
    ctx.fillStyle = '#d3a488';
    ctx.fillText(`WAR ZONE ${sector.code}`, x, y);
    ctx.letterSpacing = '0.25px';
    ctx.font = `${compact ? 10 : 12}px ${SANS}`;
    ctx.fillStyle = '#c8ab96';
    ctx.fillText(sector.name, x, y + 15);
  }

  ctx.letterSpacing = '0px';
  ctx.font = `11px ${SANS}`;
  for (const { name, lon, lat, dx, dy, align = 'left' } of PLACES) {
    if (compact && (name === 'Liverpool' || name === 'Wilhelmshaven')) continue;
    const { x, y } = chart.project(lon, lat);
    ctx.fillStyle = '#d1b587';
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    ctx.textAlign = align;
    ctx.strokeStyle = '#20302a';
    ctx.lineWidth = 2.5;
    ctx.strokeText(name, x + dx, y + dy);
    ctx.fillText(name, x + dx, y + dy);
  }
  ctx.restore();
}

function drawRose(ctx, chart, compact) {
  const radius = compact ? 23 : 30;
  const x = chart.left + radius + 16;
  const y = chart.bottom - radius - 16;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#a89a6d70';
  ctx.fillStyle = '#ae9d73';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, 2 * Math.PI);
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const length = i % 2 === 0 ? radius : radius * 0.62;
    ctx.beginPath();
    ctx.moveTo(0, -length);
    ctx.lineTo(-4, -4);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -length);
    ctx.lineTo(4, -4);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.rotate(Math.PI / 4);
  }
  ctx.font = `11px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -radius - 6);
  ctx.restore();
}

function drawScale(ctx, chart) {
  const scaleLatitude = 45;
  const start = chart.project(-4, 44.48);
  const nmPerDegree = distanceTo({ lon: -4, lat: scaleLatitude }, { lon: -3, lat: scaleLatitude });
  const length = 100 * chart.xScale / nmPerDegree;
  ctx.font = `9px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#c2bea3';
  ctx.fillText('100 NM AT 45°N', start.x + length / 2, start.y - 10);
  ctx.strokeStyle = '#b6ae89';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(start.x + length, start.y);
  for (const x of [start.x, start.x + length / 2, start.x + length]) {
    ctx.moveTo(x, start.y - 4);
    ctx.lineTo(x, start.y + 3);
  }
  ctx.stroke();
}

function drawChart(ctx, chart, width, height) {
  ctx.fillStyle = '#192522';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  clipMap(ctx, chart);

  const sea = ctx.createRadialGradient(width * 0.48, height * 0.4, 0, width * 0.48, height * 0.4, width * 0.78);
  sea.addColorStop(0, '#263d38');
  sea.addColorStop(1, '#132b2c');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, width, height);
  drawOcean(ctx, chart);

  const coast = new Path2D();
  for (const { ring } of LANDMASSES) addRing(coast, ring, chart);
  ctx.lineJoin = 'round';
  for (const lineWidth of [14, 7, 3]) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = '#94a58027';
    ctx.stroke(coast);
  }
  drawSectors(ctx, chart);
  drawShippingLanes(ctx, chart);

  const land = ctx.createLinearGradient(width * 0.6, 0, width, height);
  land.addColorStop(0, '#505844');
  land.addColorStop(1, '#66644e');
  ctx.fillStyle = land;
  ctx.fill(coast);
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = '#c1b389b5';
  ctx.stroke(coast);

  drawGrid(ctx, chart);
  ctx.fillStyle = makeGrain(ctx);
  ctx.fillRect(0, 0, width, height);
  drawLabels(ctx, chart, width < 660);
  drawRose(ctx, chart, width < 660);
  drawScale(ctx, chart);
  ctx.restore();
  drawRulers(ctx, chart);
}

function traceLeg(ctx, chart, from, to) {
  for (const { lon, lat } of sampleLeg(from, to)) {
    const { x, y } = chart.project(lon, lat);
    ctx.lineTo(x, y);
  }
}

function addRangeArc(path, chart, origin, range, firstBearing, span, segments) {
  for (let i = 0; i <= segments; i++) {
    const { lon, lat } = advancePosition(origin, firstBearing + i * span / segments, range);
    const { x, y } = chart.project(lon, lat);
    path.lineTo(x, y);
  }
  path.closePath();
}

function drawSensorRanges(ctx, chart, boat, ranges, weather) {
  const { left, top, right, bottom } = chart;
  const fog = new Path2D();
  fog.rect(left, top, right - left, bottom - top);
  const sight = new Path2D();
  if (ranges.sight > 0) {
    addRangeArc(sight, chart, boat.position, ranges.sight, 0, 360, 48);
    fog.addPath(sight);
  }

  ctx.save();
  ctx.fillStyle = weather === 'storm' ? '#09151d67' : '#08141543';
  ctx.fill(fog, 'evenodd');
  ctx.lineWidth = 1;

  if (ranges.hydrophone > 0) {
    const cone = new Path2D();
    const { x, y } = chart.project(boat.position.lon, boat.position.lat);
    cone.moveTo(x, y);
    addRangeArc(cone, chart, boat.position, ranges.hydrophone, boat.heading - HYDROPHONE_HALF_ANGLE,
      HYDROPHONE_HALF_ANGLE * 2, 24);
    ctx.fillStyle = '#79cdb634';
    ctx.fill(cone);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9bd1c7c7';
    ctx.stroke(cone);
    ctx.setLineDash([]);
  }

  ctx.fillStyle = '#d7ba771c';
  ctx.strokeStyle = '#d7ba77c0';
  ctx.fill(sight);
  ctx.stroke(sight);
  ctx.restore();
}

function screenHeading(chart, lat, heading) {
  const angle = heading * DEG;
  return Math.atan2(Math.sin(angle) * chart.xScale / Math.cos(lat * DEG), Math.cos(angle) * chart.yScale);
}

function drawVisualContact(ctx, chart, contact, point) {
  const { x, y } = point;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(screenHeading(chart, contact.position.lat, contact.heading));
  ctx.scale(contact.visibilityRadius, contact.visibilityRadius);
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(3.5, -2);
  ctx.lineTo(3.5, 5);
  ctx.lineTo(-3.5, 5);
  ctx.lineTo(-3.5, -2);
  ctx.closePath();
  ctx.strokeStyle = '#14211f';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = contact.armed ? '#e3a18b' : contact.flag === 'Neutral' ? '#c0d6db' : '#efe0b9';
  ctx.fill();
  ctx.restore();
}

function drawSoundContact(ctx, point) {
  const { x, y } = point;
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x + 4, y);
  ctx.lineTo(x, y + 4);
  ctx.lineTo(x - 4, y);
  ctx.closePath();
  ctx.fillStyle = '#193a36';
  ctx.strokeStyle = '#b0e0d3';
  ctx.lineWidth = 1.3;
  ctx.fill();
  ctx.stroke();
}

function drawContacts(ctx, chart, boat, contacts, cursor) {
  const pointer = cursor && chart.project(cursor.lon, cursor.lat);
  let hovered;
  let closest = 11;

  function checkHover(point, label, details) {
    if (!pointer) return;
    const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
    if (distance < closest) {
      closest = distance;
      hovered = { ...point, label, details };
    }
  }

  for (const contact of contacts.visual) {
    const { lon, lat } = contact.position;
    const point = chart.project(lon, lat);
    drawVisualContact(ctx, chart, contact, point);
    checkHover(point, contact.name, `${contact.label} · ${contact.activity}`);
  }

  for (const bearing of contacts.bearings) {
    // All sound returns share the same plot radius because their range is unknown.
    const { lon, lat } = advancePosition(boat.position, bearing, (chart.radius ?? contacts.ranges.hydrophone) * 0.8);
    const point = chart.project(lon, lat);
    drawSoundContact(ctx, point);
    checkHover(point, `Propellers · ${String(bearing).padStart(3, '0')}°`, 'Hydrophone bearing');
  }

  return hovered;
}

function drawContactLabel(ctx, chart, contact) {
  if (!contact) return;
  const { x, y, label, details } = contact;
  ctx.save();
  ctx.font = `600 13px ${SANS}`;
  const labelWidth = ctx.measureText(label).width;
  ctx.font = `11px ${SANS}`;
  const width = Math.ceil(Math.max(labelWidth, ctx.measureText(details).width) + 18);
  const left = Math.max(chart.left + 3, Math.min(x + 10, chart.right - width - 3));
  const top = y - 41 > chart.top ? y - 41 : y + 9;
  ctx.beginPath();
  ctx.roundRect(left, top, width, 36, 4);
  ctx.fillStyle = '#1a2927';
  ctx.strokeStyle = '#a49773';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e6d7ad';
  ctx.font = `600 13px ${SANS}`;
  ctx.fillText(label, left + 9, top + 14);
  ctx.fillStyle = '#bdc9bb';
  ctx.font = `11px ${SANS}`;
  ctx.fillText(details, left + 9, top + 28);
  ctx.restore();
}

function drawCourse(ctx, chart, boat, waypoints, cursor) {
  const start = chart.project(boat.position.lon, boat.position.lat);
  if (waypoints.length) {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    let previous = boat.position;
    for (const waypoint of waypoints) {
      traceLeg(ctx, chart, previous, waypoint);
      previous = waypoint;
    }
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#16231dd0';
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#e3be78';
    ctx.stroke();

    waypoints.forEach(({ lon, lat }, index) => {
      const { x, y } = chart.project(lon, lat);
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = index === 0 ? '#d7b579' : '#25332a';
      ctx.fill();
      ctx.stroke();
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = index === 0 ? '#21251c' : '#efcea0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(index + 1, x, y + 0.5);
    });
  }

  if (cursor && isWater(cursor)) {
    const origin = waypoints.at(-1) ?? boat.position;
    const from = chart.project(origin.lon, origin.lat);
    const to = chart.project(cursor.lon, cursor.lat);
    if (Math.hypot(to.x - from.x, to.y - from.y) < 9) return;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    traceLeg(ctx, chart, origin, cursor);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#e5cc8c99';
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(to.x, to.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawBoat(ctx, chart, boat) {
  if (boat.hull === 0) return;
  const { x, y } = chart.project(boat.position.lon, boat.position.lat);
  const screenAngle = screenHeading(chart, boat.position.lat, boat.heading);
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.fillStyle = '#25352be6';
  ctx.fill();
  ctx.strokeStyle = '#e0b978a0';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  ctx.rotate(screenAngle);
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(0, -19);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(4.5, 6);
  ctx.lineTo(0, 3.5);
  ctx.lineTo(-4.5, 6);
  ctx.closePath();
  ctx.fillStyle = boat.depth === 0 ? '#edcc8a' : '#a8d0b7';
  ctx.fill();
  ctx.restore();

  const designation = submarineDesignation(boat);
  ctx.font = `10px ${MONO}`;
  const labelWidth = Math.max(34, Math.ceil(ctx.measureText(designation).width + 10));
  const labelX = Math.max(chart.left + 2 - x, Math.min(-labelWidth / 2, chart.right - labelWidth - 2 - x));
  const labelY = y + 30 < chart.bottom ? 15 : -31;
  ctx.fillStyle = '#1b2822';
  ctx.strokeStyle = '#9f875f';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, 16, 3);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ebce98';
  ctx.fillText(designation, labelX + labelWidth / 2, labelY + 8);
  ctx.restore();
}

export function createChartRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const backdrop = document.createElement('canvas');
  const backdropContext = backdrop.getContext('2d', { alpha: false });
  const drawCombat = createCombatOverlay();
  let atlanticChart;
  let activeChart;
  let dimensions;
  let dirty = true;

  new ResizeObserver(() => { dirty = true; }).observe(canvas);
  document.fonts.ready.then(() => { dirty = true; });

  function updateBackdrop() {
    const { width, height } = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    if (width < 80 || height < 70) return false;

    if (!dirty && dimensions?.pixelRatio === pixelRatio) return true;

    canvas.width = backdrop.width = Math.round(width * pixelRatio);
    canvas.height = backdrop.height = Math.round(height * pixelRatio);
    dimensions = { width, height, pixelRatio };
    atlanticChart = createProjection(width, height);
    backdropContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawChart(backdropContext, atlanticChart, width, height);
    dirty = false;
    return true;
  }

  function contactAt(position, contacts) {
    if (!activeChart || !position) return null;
    const pointer = activeChart.project(position.lon, position.lat);
    let closest = 9;
    let target = null;
    for (const contact of contacts.visual) {
      const point = activeChart.project(contact.position.lon, contact.position.lat);
      const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
      if (distance < closest) {
        closest = distance;
        target = contact;
      }
    }
    return target;
  }

  return {
    contactAt,
    draw(state, cursor, contacts, fireControl) {
      if (!updateBackdrop()) return;
      const { width, height, pixelRatio } = dimensions;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const chart = fireControl ? createTacticalProjection(width, height, state.boat.position) : atlanticChart;
      activeChart = chart;
      if (fireControl) drawTacticalBackdrop(ctx, chart, width, height);
      else ctx.drawImage(backdrop, 0, 0, width, height);
      ctx.save();
      clipMap(ctx, chart);
      drawSensorRanges(ctx, chart, state.boat, contacts.ranges, state.weather);
      drawCourse(ctx, chart, state.boat, state.waypoints, cursor && !contactAt(cursor, contacts) ? cursor : null);
      if (fireControl) drawFireSolution(ctx, chart, state.boat, fireControl);
      const hovered = drawContacts(ctx, chart, state.boat, contacts, cursor);
      drawBoat(ctx, chart, state.boat);
      drawCombat(ctx, chart, state);
      drawContactLabel(ctx, chart, hovered);
      ctx.restore();
    },
    pointAt(clientX, clientY) {
      if (!activeChart) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < activeChart.left || x > activeChart.right || y < activeChart.top || y > activeChart.bottom) return null;
      const point = activeChart.invert(x, y);
      return isOnChart(point) ? point : null;
    },
  };
}
