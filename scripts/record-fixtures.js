/**
 * Re-capture crawler fixtures from the live sources, then regenerate expected.json.
 *   npm run fixtures:record                 # every crawler in fixtures/harness.js
 *   npm run fixtures:record -- forest-park  # just one
 *   npm run fixtures:expected               # only regenerate expected.json from saved fixtures
 * Run it from GitHub Actions (record-fixtures workflow): several sources block other networks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CRAWLERS, FIXTURES_DIR, runCrawler, expectedPath } from '../fixtures/harness.js';

const args = process.argv.slice(2);
const replayOnly = args.includes('--expected-only');
const names = args.filter(a => !a.startsWith('--'));
const failed = [];

for (const crawler of names.length ? names : CRAWLERS) {
  if (!CRAWLERS.includes(crawler)) throw new Error(`No fixture setup for ${crawler}`);
  try {
    if (!replayOnly) {
      fs.rmSync(path.join(FIXTURES_DIR, crawler), { recursive: true, force: true });
      await runCrawler(crawler, 'record');
    }
    const events = await runCrawler(crawler, 'replay');
    fs.writeFileSync(expectedPath(crawler), JSON.stringify(events, null, 2) + '\n');
    console.log(`${crawler}: ${events.length} events`);
    if (events.length === 0) failed.push(crawler);
  } catch (err) {
    console.error(`${crawler}: ${err.stack}`);
    failed.push(crawler);
  }
}

if (failed.length) {
  console.error(`No events from: ${failed.join(', ')}`);
  process.exitCode = 1;
}
