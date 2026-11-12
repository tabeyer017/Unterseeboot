const WEATHER_PERIOD = 40 * 60;
const STORM_START = 12 * 60;
const STORM_END = 20 * 60;

export function weatherAt(elapsed) {
  const phase = elapsed % WEATHER_PERIOD;
  return phase >= STORM_START && phase < STORM_END ? 'storm' : 'clear';
}

export function sightMultiplier(weather) {
  return weather === 'storm' ? 0.3 : 1;
}
