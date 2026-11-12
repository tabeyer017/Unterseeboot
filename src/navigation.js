import { isLand } from './chart.js';

const EARTH_RADIUS_NM = 3440.065;
const RADIANS = Math.PI / 180;

export const SECONDS_PER_HOUR = 3600;
export const METERS_PER_NM = 1852;
export const wrapHeading = (degrees) => ((degrees % 360) + 360) % 360;
export const bearingDelta = (from, to) => wrapHeading(to - from + 180) - 180;
export const moveToward = (value, target, delta) => value + Math.max(-delta, Math.min(delta, target - value));

export function distanceTo(from, to) {
  const halfLat = (to.lat - from.lat) * RADIANS / 2;
  const halfLon = (to.lon - from.lon) * RADIANS / 2;
  const haversine = Math.sin(halfLat) ** 2
    + Math.cos(from.lat * RADIANS) * Math.cos(to.lat * RADIANS) * Math.sin(halfLon) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(Math.min(haversine, 1)));
}

export function bearingTo(from, to) {
  const lat = from.lat * RADIANS;
  const targetLat = to.lat * RADIANS;
  const lonDelta = (to.lon - from.lon) * RADIANS;
  const east = Math.sin(lonDelta) * Math.cos(targetLat);
  const north = Math.cos(lat) * Math.sin(targetLat)
    - Math.sin(lat) * Math.cos(targetLat) * Math.cos(lonDelta);
  return wrapHeading(Math.atan2(east, north) / RADIANS);
}

export function advancePosition(position, heading, distance) {
  const course = heading * RADIANS;
  const arc = distance / EARTH_RADIUS_NM;
  const latitude = position.lat * RADIANS;
  const nextLatitude = Math.asin(Math.sin(latitude) * Math.cos(arc)
    + Math.cos(latitude) * Math.sin(arc) * Math.cos(course));
  const lonDelta = Math.atan2(Math.sin(course) * Math.sin(arc) * Math.cos(latitude),
    Math.cos(arc) - Math.sin(latitude) * Math.sin(nextLatitude));
  return { lon: position.lon + lonDelta / RADIANS, lat: nextLatitude / RADIANS };
}

// Chart lines, route followers, and sensor overlays use the same great-circle geometry.
export function sampleLeg(from, to, spacing = 65) {
  const distance = distanceTo(from, to);
  const bearing = bearingTo(from, to);
  const segments = Math.ceil(distance / spacing);
  const points = [];
  for (let i = 1; i < segments; i++) {
    points.push(advancePosition(from, bearing, distance * i / segments));
  }
  points.push(to);
  return points;
}

export function hasWaterLine(from, to) {
  return sampleLeg(from, to, 3).every((point) => !isLand(point));
}
