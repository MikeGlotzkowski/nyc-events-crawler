/**
 * Source health check — run by .github/workflows/source-health.yml.
 *
 * Reads crawler_config, recent crawl_runs and the upcoming-event count from Supabase,
 * applies the rules in lib/health.js, and keeps ONE open GitHub issue in sync:
 *   problems, no issue  → open it (assigned to the repo owner, so they get notified)
 *   problems, issue     → refresh the body; comment only when the set of problems changes
 *   no problems, issue  → comment and close it
 *
 * Without GITHUB_TOKEN (local runs) it just prints the report.
 */

import { supabase } from './lib/supabase.js';
import { evaluateHealth, DEFAULTS } from './lib/health.js';

const TITLE = 'Crawler health alert';

const now = new Date();

const [{ data: configs, error: cfgErr }, { data: runs, error: runsErr }, { count: upcoming7d, error: upErr }] = await Promise.all([
  supabase.from('crawler_config').select('source_name, enabled'),
  supabase.from('crawl_runs')
    .select('source_name, status, started_at, events_found, error_messages')
    .gte('started_at', new Date(now.getTime() - DEFAULTS.windowDays * 86400_000).toISOString())
    .order('started_at', { ascending: false })
    .limit(5000),
  supabase.from('events')
    .select('id', { count: 'exact', head: true })
    .gte('start_at', now.toISOString())
    .lt('start_at', new Date(now.getTime() + 7 * 86400_000).toISOString()),
]);
const dbErr = cfgErr || runsErr || upErr;
if (dbErr) throw new Error(`Supabase read failed: ${dbErr.message}`);

const problems = evaluateHealth({ configs, runs, upcoming7d, now });
const keys = problems.map(p => p.key).sort();

const body = [
  `Checked ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. This issue closes itself once every source is healthy again.`,
  '',
  ...problems.map(p => `- ${p.text}`),
  '',
  `Rules: ${DEFAULTS.failStreak} failed runs in a row, no events found for ${DEFAULTS.staleHours}h, or fewer than ${DEFAULTS.minUpcoming7d} events in the next 7 days. ` +
  'Disable a source in `crawler_config.enabled` to silence it.',
  '',
  `<!-- health-keys: ${keys.join(',')} -->`,
].join('\n');

console.log(problems.length ? `${problems.length} problem(s):\n${problems.map(p => `  ${p.key}`).join('\n')}` : 'All sources healthy.');

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.log('\nGITHUB_TOKEN/GITHUB_REPOSITORY not set; not syncing the issue.\n\n' + body);
  process.exit(0);
}

async function gh(method, path, payload) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const open = await gh('GET', '/issues?state=open&per_page=100');
const issue = open.find(i => i.title === TITLE && !i.pull_request);

if (!issue) {
  if (problems.length) {
    const created = await gh('POST', '/issues', { title: TITLE, body, assignees: [process.env.GITHUB_REPOSITORY_OWNER].filter(Boolean) });
    console.log(`Opened ${created.html_url}`);
  }
} else if (!problems.length) {
  await gh('POST', `/issues/${issue.number}/comments`, { body: 'All sources are healthy again. Closing.' });
  await gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  console.log(`Closed ${issue.html_url}`);
} else {
  const prevKeys = (issue.body?.match(/<!-- health-keys: (.*?) -->/)?.[1] ?? '').split(',').filter(Boolean);
  await gh('PATCH', `/issues/${issue.number}`, { body });
  const added = problems.filter(p => !prevKeys.includes(p.key));
  const resolved = prevKeys.filter(k => !keys.includes(k));
  if (added.length || resolved.length) {
    await gh('POST', `/issues/${issue.number}/comments`, {
      body: [
        ...(added.length ? ['New:', ...added.map(p => `- ${p.text}`)] : []),
        ...(resolved.length ? ['Resolved: ' + resolved.map(k => `\`${k}\``).join(', ')] : []),
      ].join('\n'),
    });
  }
  console.log(`Updated ${issue.html_url}`);
}
