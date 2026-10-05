// Pure CLI target routing for index.js. No I/O, no side effects.

export const CRAWLER_TARGETS = [
  'nyc-parks',
  'nyc-opendata',
  'rss-blogs',
  'ical-feeds',
  'riverside-park',
  'westsiderag',
  'nyccom',
  'seatgeek',
  'brooklyn-library',
  'queens-library',
  'van-cortlandt-park',
  'forest-park',
  'whitney',
  'bam',
  'lincoln-center',
  'carnegie-hall',
  'resident-advisor',
  'dice',
  'timeout',
];

export const TIER1 = ['nyc-parks', 'nyc-opendata', 'ical-feeds', 'riverside-park', 'van-cortlandt-park', 'forest-park', 'rss-blogs', 'queens-library',
                      'whitney', 'bam', 'lincoln-center', 'carnegie-hall', 'resident-advisor', 'dice', 'timeout'];
export const TIER2 = ['westsiderag', 'nyccom'];
export const ALL = [...TIER1, ...TIER2];

/**
 * @param {string|undefined} arg
 * @returns {{kind:'usage'}|{kind:'all',group:'tier1'|'tier2'|'all',targets:string[]}|{kind:'crawler',name:string}|{kind:'unknown',name:string}}
 */
export function resolveTarget(arg) {
  if (arg === undefined || arg === null || arg === '' || arg === '--help' || arg === '-h' || arg === 'help') {
    return { kind: 'usage' };
  }
  if (arg === 'all-tier1') return { kind: 'all', group: 'tier1', targets: TIER1 };
  if (arg === 'all-tier2') return { kind: 'all', group: 'tier2', targets: TIER2 };
  if (arg === 'all') return { kind: 'all', group: 'all', targets: ALL };
  if (CRAWLER_TARGETS.includes(arg)) return { kind: 'crawler', name: arg };
  return { kind: 'unknown', name: arg };
}
