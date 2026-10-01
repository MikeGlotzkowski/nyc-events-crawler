// Data-quality report. Pure: takes rows already read from Supabase, returns a markdown
// summary and the sources whose new events got worse. Used by health-check.js, which
// writes the summary to the job summary and adds the problems to the health alert issue.

export const QUALITY_DEFAULTS = {
  newHours: 24,        // "new" = created in the last this many hours
  minSample: 10,       // need at least this many new AND older upcoming events to compare
  dropPoints: 30,      // flag a field when new events have it this many points less often
  sampleTitles: 10,
};

export const FIELDS = [
  ['image', e => !!e.image],
  ['time', e => !!e.time?.trim()],
  ['category', e => !!e.canonical_category],
  ['borough', e => !!e.borough],
];

const pct = (rows, has) => rows.length ? Math.round(100 * rows.filter(has).length / rows.length) : null;
const cell = s => String(s ?? '').replace(/[|\r\n]+/g, ' ').replace(/</g, '&lt;').slice(0, 120);

/**
 * @param {object} p
 * @param {Array}  p.runs     crawl_runs rows from the last `newHours`: { source_name, status, events_found, events_new, error_count }
 * @param {Array}  p.events   visible upcoming events: { source, title, start_at, created_at, image, time, canonical_category, borough }
 * @param {Date}   p.now
 * @param {Function} [p.random]  for tests
 * @returns {{ markdown: string, problems: Array<{ key: string, text: string }> }}
 */
export function buildQualityReport({ runs, events, now, random = Math.random, opts = QUALITY_DEFAULTS }) {
  const newSince = now.getTime() - opts.newHours * 3600_000;
  const isNew = e => new Date(e.created_at).getTime() >= newSince;
  const problems = [];
  const lines = [`## Data quality, ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];

  // Crawl runs per crawler
  const byCrawler = new Map();
  for (const r of runs) {
    const c = byCrawler.get(r.source_name) ?? { runs: 0, found: 0, new: 0, errors: 0, statuses: new Set() };
    c.runs++;
    c.found += r.events_found ?? 0;
    c.new += r.events_new ?? 0;
    c.errors += r.error_count ?? 0;
    c.statuses.add(r.status);
    byCrawler.set(r.source_name, c);
  }
  lines.push(`### Crawls in the last ${opts.newHours}h`, '');
  if (byCrawler.size) {
    lines.push('| Crawler | Runs | Found | New | Errors | Status |', '|---|--:|--:|--:|--:|---|');
    for (const [name, c] of [...byCrawler].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${cell(name)} | ${c.runs} | ${c.found} | ${c.new} | ${c.errors} | ${[...c.statuses].sort().join(', ')} |`);
    }
  } else {
    lines.push('No crawl runs.');
  }

  // Upcoming events per source, with field coverage for all of them and for the new ones
  const bySource = new Map();
  for (const e of events) {
    const key = e.source ?? '(none)';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(e);
  }
  lines.push('', `### Upcoming events by source (${events.length} total)`, '',
    `Coverage is "all upcoming / new in the last ${opts.newHours}h".`, '',
    '| Source | Upcoming | New | ' + FIELDS.map(([field]) => `% ${field}`).join(' | ') + ' |',
    '|---|--:|--:|' + FIELDS.map(() => '--:').join('|') + '|');
  for (const [source, rows] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
    const fresh = rows.filter(isNew);
    const older = rows.filter(e => !isNew(e));
    const cols = FIELDS.map(([, has]) => {
      const all = pct(rows, has), n = pct(fresh, has);
      return n == null ? `${all}` : `${all} / ${n}`;
    });
    lines.push(`| ${cell(source)} | ${rows.length} | ${fresh.length} | ${cols.join(' | ')} |`);

    if (fresh.length < opts.minSample || older.length < opts.minSample) continue;
    for (const [field, has] of FIELDS) {
      const was = pct(older, has), is = pct(fresh, has);
      if (was - is >= opts.dropPoints) {
        problems.push({
          key: `${source}:quality-${field}`,
          text: `**${source}**: ${field} on only ${is}% of ${fresh.length} new events (older upcoming ones: ${was}%)`,
        });
      }
    }
  }

  // Random sample of titles, to eyeball
  const pool = [...events];
  const sample = [];
  while (sample.length < opts.sampleTitles && pool.length) {
    sample.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  sample.sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
  lines.push('', `### ${sample.length} random upcoming events`, '');
  for (const e of sample) {
    lines.push(`- ${String(e.start_at).slice(0, 10)} · ${cell(e.title)} _(${cell(e.source)})_`);
  }

  if (problems.length) lines.push('', '### Degraded', '', ...problems.map(p => `- ${p.text}`));
  return { markdown: lines.join('\n') + '\n', problems };
}
