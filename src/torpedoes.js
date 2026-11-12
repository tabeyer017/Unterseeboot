import { dataForYear, GAME_DATA } from './dataLoader.js';
import { advancePosition, METERS_PER_NM } from './navigation.js';

const models = new Map(GAME_DATA.torpedoes.map((torpedo) => [torpedo.id, torpedo]));
export const LEGACY_TORPEDO = 'legacy_torpedo';
models.set(LEGACY_TORPEDO, {
  id: LEGACY_TORPEDO, speedKnots: 32, maxRangeMeters: 6 * METERS_PER_NM, hullDamage: 160,
  reliability: { dudProbability: 0.07 }, stealth: { bubbleWakeVisibility: 0.75 },
});

export function torpedoModel(id) {
  return models.get(id);
}

export function patrolTorpedo(year, caliber) {
  return dataForYear(year).torpedoes.filter((model) => model.caliberMm === caliber)
    .reduce((latest, model) => !latest || model.serviceYears[0] > latest.serviceYears[0] ? model : latest, null);
}

export function wakeLength(projectile) {
  const { bubbleWakeVisibility } = torpedoModel(projectile.torpedoId).stealth;
  return Math.min(projectile.traveled, 0.5 * bubbleWakeVisibility);
}

export function wakePoint(projectile, offset) {
  return advancePosition(projectile.origin, projectile.bearing, projectile.traveled - offset);
}
