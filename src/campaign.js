export const FIRST_CAMPAIGN_DATE = Date.UTC(1914, 0, 1);
export const LAST_CAMPAIGN_DATE = Date.UTC(1919, 0, 1) - 1;

export function campaignTime(state) {
  return Math.min(LAST_CAMPAIGN_DATE, state.patrolStart + Math.round(state.elapsed * 1000));
}

export function campaignEnded(state) {
  return campaignTime(state) === LAST_CAMPAIGN_DATE;
}
