// Telegram alerting for the source health check.
//
// Two parts, deliberately split:
//   buildTelegramMessage(problems, now)  — PURE: problems in, message out. No network.
//   sendTelegram(text)                   — network: POSTs to the Telegram Bot API.
//
// health-check.js calls the pure builder once, then sends the same text from both the
// GitHub-token path and the no-token (local) path, so a ping still fires when the issue
// sync is skipped. Plain text only (no parse_mode) so problem text — which may contain
// `*`, `_`, `[` or backticks — cannot break Markdown parsing.

export const MAX_MESSAGE = 3900; // Telegram's hard cap is 4096; leave headroom.

const HINT = 'Disable a source in crawler_config.enabled to silence it';

/**
 * Build the Telegram message for a health check.
 *
 * @param {Array<{key: string, text: string}>} problems  from evaluateHealth + buildQualityReport
 * @param {Date} now
 * @returns {{ kind: 'open' | 'all-clear', text: string }}
 */
export function buildTelegramMessage(problems, now) {
  const ts = `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  if (!problems || problems.length === 0) {
    return {
      kind: 'all-clear',
      text: `✅ All-clear: every crawler source is healthy again (checked ${ts}).\n\n${HINT}`,
    };
  }

  const header = `🚨 Crawler health alert: ${problems.length} problem${problems.length === 1 ? '' : 's'} (checked ${ts})`;
  const bullets = problems.map(p => `• ${p.text}`);
  const assemble = (n, omitted) =>
    [header, '', ...bullets.slice(0, n), ...(omitted ? [omitted] : []), '', HINT].join('\n');

  let text = assemble(bullets.length, '');
  if (text.length > MAX_MESSAGE) {
    // Drop trailing bullets until it fits, keeping an explicit "omitted" line.
    let n = bullets.length;
    for (; n >= 0; n--) {
      text = assemble(n, n < bullets.length ? `• …${bullets.length - n} more problem(s) omitted` : '');
      if (text.length <= MAX_MESSAGE) break;
    }
  }

  return { kind: 'open', text };
}

/**
 * Send one plain-text message. A no-op (logged, not an error) when creds are absent,
 * so local runs and forks never fail on a missing Telegram config.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  injectable for tests
 * @param {object}   [opts.env]        injectable for tests
 * @param {Function} [opts.log]
 * @returns {Promise<{ sent: boolean, skipped: boolean }>}
 */
export async function sendTelegram(text, { fetchImpl = globalThis.fetch, env = process.env, log = console.log } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log('Telegram not configured; skipping');
    return { sent: false, skipped: true };
  }

  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No parse_mode: plain text, so problem text cannot break Markdown parsing.
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    // Never echo the URL — it carries the bot token.
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  }
  return { sent: true, skipped: false };
}
