// Pure CLI target routing for index.js. No I/O, no side effects.

export const CRAWLER_TARGETS = [
  'nyc-parks',
  'nyc-opendata',
  'rss-blogs',
  'ical-feeds',
  'calendar-harvest',
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
  'ticketmaster',
];

export const TIER1 = ['nyc-parks', 'nyc-opendata', 'ical-feeds', 'calendar-harvest', 'riverside-park', 'van-cortlandt-park', 'forest-park', 'rss-blogs', 'queens-library',
                      'whitney', 'bam', 'lincoln-center', 'carnegie-hall', 'resident-advisor', 'dice', 'timeout', 'ticketmaster', 'seatgeek'];
export const TIER2 = ['westsiderag', 'nyccom'];
export const ALL = [...TIER1, ...TIER2];

// Non-crawl jobs — same `node index.js <target>` entry point, no crawler_config row.
export const TASK_TARGETS = ['topic-pages'];

// The heavy API-crawl sources were placed last in TIER1 and so were structurally
// dropped whenever the single 60-minute CI job ran out of time. The nightly
// workflow now runs these in their own job so a slow source cannot starve them.
export const TICKETING = ['ticketmaster', 'seatgeek'];

/** TIER1 minus the ticketing APIs — the sources the workflow `core` job runs. */
export const TIER1_CORE = TIER1.filter((name) => !TICKETING.includes(name));

/**
 * @param {string|undefined} arg
 * @returns {{kind:'usage'}|{kind:'all',group:'tier1'|'tier2'|'all',targets:string[]}|{kind:'crawler',name:string}|{kind:'task',name:string}|{kind:'unknown',name:string}}
 */
export function resolveTarget(arg) {
  if (arg === undefined || arg === null || arg === '' || arg === '--help' || arg === '-h' || arg === 'help') {
    return { kind: 'usage' };
  }
  if (arg === 'all-tier1') return { kind: 'all', group: 'tier1', targets: TIER1 };
  if (arg === 'tier1-core') return { kind: 'all', group: 'tier1', targets: TIER1_CORE };
  if (arg === 'ticketing') return { kind: 'all', group: 'tier1', targets: TICKETING };
  if (arg === 'all-tier2') return { kind: 'all', group: 'tier2', targets: TIER2 };
  if (arg === 'all') return { kind: 'all', group: 'all', targets: ALL };
  if (TASK_TARGETS.includes(arg)) return { kind: 'task', name: arg };
  if (CRAWLER_TARGETS.includes(arg)) return { kind: 'crawler', name: arg };
  return { kind: 'unknown', name: arg };
}
