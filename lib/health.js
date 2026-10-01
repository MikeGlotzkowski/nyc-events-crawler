// Source health rules. Pure: takes rows already read from Supabase, returns problems.
// Used by health-check.js, which turns the problems into one GitHub issue.

export const DEFAULTS = {
  failStreak: 3,         // this many finished runs in a row with status 'error'
  staleHours: 48,        // no run that found events for this long
  minUpcoming7d: 75,     // fewer upcoming events in the next 7 days than this
  windowDays: 14,        // how much crawl_runs history the caller passes in
};

/**
 * @param {object}   p
 * @param {Array}    p.configs        crawler_config rows: { source_name, enabled }
 * @param {Array}    p.runs           crawl_runs rows: { source_name, status, started_at, events_found, error_messages }
 * @param {number}   p.upcoming7d     count of events starting in the next 7 days
 * @param {Date}     p.now
 * @returns {Array<{ key: string, text: string }>}  empty when everything is healthy
 */
export function evaluateHealth({ configs, runs, upcoming7d, now, opts = DEFAULTS }) {
  const problems = [];
  const staleBefore = now.getTime() - opts.staleHours * 3600_000;

  for (const { source_name: source } of configs.filter(c => c.enabled !== false)) {
    const mine = runs
      .filter(r => r.source_name === source && r.status !== 'running')
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    let streak = 0;
    while (streak < mine.length && mine[streak].status === 'error') streak++;
    if (streak >= opts.failStreak) {
      const lastError = firstError(mine[0].error_messages);
      problems.push({
        key: `${source}:failing`,
        text: `**${source}** failed its last ${streak} runs${lastError ? `. Last error: \`${lastError}\`` : ''}`,
      });
    }

    const lastProducing = mine.find(r => (r.events_found ?? 0) > 0);
    if (!lastProducing || new Date(lastProducing.started_at).getTime() < staleBefore) {
      problems.push({
        key: `${source}:stale`,
        text: lastProducing
          ? `**${source}** has found no events since ${lastProducing.started_at.slice(0, 10)}`
          : `**${source}** has found no events in the last ${opts.windowDays} days`,
      });
    }
  }

  if (upcoming7d < opts.minUpcoming7d) {
    problems.push({
      key: 'upcoming:low',
      text: `Only **${upcoming7d}** events start in the next 7 days (alert below ${opts.minUpcoming7d})`,
    });
  }

  return problems;
}

// First error message, one line, without query strings (they can carry API keys).
function firstError(messages) {
  const m = Array.isArray(messages) ? messages[0] : null;
  if (!m) return null;
  const text = typeof m === 'string' ? m : (m.message ?? JSON.stringify(m));
  return text.replace(/\?\S*/g, '?…').replace(/[`\s]+/g, ' ').trim().slice(0, 200);
}
