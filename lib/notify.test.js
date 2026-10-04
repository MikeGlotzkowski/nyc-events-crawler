import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramMessage, sendTelegram, MAX_MESSAGE } from './notify.js';

const now = new Date('2026-10-01T12:00:00Z');
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

describe('buildTelegramMessage', () => {
  it('summarizes a mix of problems with count, text, timestamp and hint', () => {
    const problems = [
      { key: 'nyc-parks:failing', text: '**nyc-parks** failed its last 3 runs. Last error: `HTTP 405`' },
      { key: 'upcoming:low', text: 'Only **40** events start in the next 7 days (alert below 75)' },
      { key: 'BAM:quality-image', text: '**BAM**: image on only 0% of 12 new events (older upcoming ones: 100%)' },
    ];
    const { kind, text } = buildTelegramMessage(problems, now);
    assert.equal(kind, 'open');
    assert.match(text, /Crawler health alert: 3 problems/);
    assert.match(text, /2026-10-01 12:00 UTC/);
    for (const p of problems) assert.ok(text.includes(p.text), `missing: ${p.text}`);
    assert.match(text, /Disable a source in crawler_config\.enabled to silence it/);
    assert.match(text, /`HTTP 405`/); // sanitized problem text kept verbatim
  });

  it('uses the singular for a single problem', () => {
    const { text } = buildTelegramMessage([{ key: 'a:b', text: 'one thing' }], now);
    assert.match(text, /1 problem \(/);
    assert.doesNotMatch(text, /1 problems/);
  });

  it('returns an all-clear message when there are no problems', () => {
    const { kind, text } = buildTelegramMessage([], now);
    assert.equal(kind, 'all-clear');
    assert.match(text, /All-clear/);
    assert.match(text, /2026-10-01 12:00 UTC/);
    assert.match(text, /Disable a source in crawler_config\.enabled to silence it/);
    assert.doesNotMatch(text, /🚨/);
  });

  it('truncates a huge problem list safely under the limit', () => {
    const problems = many(300, i => ({ key: `src-${i}:stale`, text: `**src-${i}** has found no events in the last 14 days` }));
    const { kind, text } = buildTelegramMessage(problems, now);
    assert.equal(kind, 'open');
    assert.ok(text.length <= MAX_MESSAGE, `too long: ${text.length}`);
    assert.match(text, /Crawler health alert: 300 problems/);
    assert.match(text, /more problem\(s\) omitted/);
    assert.match(text, /Disable a source in crawler_config\.enabled/);
    assert.ok(text.endsWith('Disable a source in crawler_config.enabled to silence it'));
  });
});

describe('sendTelegram', () => {
  it('is a no-op that logs and does not fetch when creds are unset', async () => {
    const logs = [];
    let called = false;
    const res = await sendTelegram('hello', {
      env: {},
      fetchImpl: async () => { called = true; throw new Error('should not fetch'); },
      log: m => logs.push(m),
    });
    assert.deepEqual(res, { sent: false, skipped: true });
    assert.equal(called, false);
    assert.deepEqual(logs, ['Telegram not configured; skipping']);
  });

  it('posts plain text (no parse_mode) with chat_id when creds are set', async () => {
    let url, body;
    const res = await sendTelegram('hi *there*', {
      env: { TELEGRAM_BOT_TOKEN: 'tok123', TELEGRAM_CHAT_ID: '42' },
      fetchImpl: async (u, opts) => { url = u; body = JSON.parse(opts.body); return { ok: true, status: 200 }; },
      log: () => {},
    });
    assert.deepEqual(res, { sent: true, skipped: false });
    assert.equal(url, 'https://api.telegram.org/bottok123/sendMessage');
    assert.deepEqual(body, { chat_id: '42', text: 'hi *there*', disable_web_page_preview: true });
    assert.ok(!('parse_mode' in body));
  });

  it('throws without leaking the token when Telegram rejects', async () => {
    await assert.rejects(
      () => sendTelegram('x', {
        env: { TELEGRAM_BOT_TOKEN: 'tok123', TELEGRAM_CHAT_ID: '42' },
        fetchImpl: async () => ({ ok: false, status: 401 }),
        log: () => {},
      }),
      err => /HTTP 401/.test(err.message) && !err.message.includes('tok123'),
    );
  });
});