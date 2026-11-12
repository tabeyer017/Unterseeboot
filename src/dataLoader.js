let loading;

export function loadGameData() {
  loading ??= Promise.all([
    import('./data/submarine.json', { with: { type: 'json' } }),
    import('./data/ships.json', { with: { type: 'json' } }),
    import('./data/torpedoes.json', { with: { type: 'json' } }),
    import('./data/patrol_zones.json', { with: { type: 'json' } }),
  ]).then(([submarines, ships, torpedoes, patrolZones]) => ({
    submarines: submarines.default.classes,
    ships: ships.default.vessels,
    torpedoes: torpedoes.default.torpedoes,
    patrolZones: patrolZones.default.zones,
  }));
  return loading;
}

// Every module using the roster waits here before constructing simulation state.
export const GAME_DATA = await loadGameData();

export function availableInYear(item, year) {
  const years = item.serviceYears ?? item.spawnYears;
  return !years || (years[0] <= year && year <= years[1]);
}

export function patrolZone(id) {
  return GAME_DATA.patrolZones.find((zone) => zone.id === id);
}

export function dataForYear(year) {
  return Object.fromEntries(Object.entries(GAME_DATA).map(([key, items]) => [key, items.filter((item) => availableInYear(item, year))]));
}
