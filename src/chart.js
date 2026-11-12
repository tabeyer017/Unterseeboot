import { LAND } from './coastline.js';

export const BOUNDS = Object.freeze({ west: -25, east: 13, south: 44, north: 62 });

export const SECTORS = [
  {
    code: 'A', name: 'Western Approaches', label: [-16.8, 48.9],
    ring: [[-23.2, 53.7], [-12, 53.7], [-10.2, 49.1], [-12.6, 46.8], [-23.2, 46.8]],
  },
  {
    code: 'B', name: 'North Atlantic Patrol', label: [-13.1, 57.9],
    ring: [[-18.5, 59.9], [-8.6, 59.9], [-7.5, 57], [-9.5, 55.8], [-18.5, 55.8]],
  },
  {
    code: 'C', name: 'North Sea Patrol', label: [3.4, 56.2],
    ring: [[-0.7, 58.8], [5.7, 58.8], [7.5, 54.5], [2, 53.3], [-0.7, 54.3]],
  },
];

export const PLACES = [
  { name: 'Cork', lon: -8.27, lat: 51.85, dx: 8, dy: 12 },
  { name: 'Liverpool', lon: -3.02, lat: 53.41, dx: -8, dy: -8, align: 'right' },
  { name: 'Plymouth', lon: -4.14, lat: 50.36, dx: -7, dy: -7, align: 'right' },
  { name: 'Brest', lon: -4.49, lat: 48.39, dx: 8, dy: 13 },
  { name: 'Wilhelmshaven', lon: 8.14, lat: 53.52, dx: 8, dy: -10 },
];

// Precompute extents so each simulation tick tests only nearby coastlines.
export const LANDMASSES = LAND.map((ring) => ({
  ring,
  west: Math.min(...ring.map(([lon]) => lon)),
  east: Math.max(...ring.map(([lon]) => lon)),
  south: Math.min(...ring.map(([, lat]) => lat)),
  north: Math.max(...ring.map(([, lat]) => lat)),
}));

function containsPoint({ lon, lat }, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

export function isOnChart({ lon, lat }) {
  return lon >= BOUNDS.west && lon <= BOUNDS.east && lat >= BOUNDS.south && lat <= BOUNDS.north;
}

export function isLand(point) {
  const { lon, lat } = point;
  return LANDMASSES.some((land) => (
    lon >= land.west && lon <= land.east && lat >= land.south && lat <= land.north
      && containsPoint(point, land.ring)
  ));
}

export function isWater(point) {
  return isOnChart(point) && !isLand(point);
}

export function patrolSectorAt(point) {
  return SECTORS.find((sector) => containsPoint(point, sector.ring));
}
