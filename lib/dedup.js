import crypto from 'crypto';

/**
 * Lowercase + collapse punctuation/whitespace runs.
 * @param {string} s
 * @returns {string}
 */
function normalizeTitle(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // punctuation → space
    .replace(/\s+/g, ' ')      // collapse whitespace runs
    .trim();
}

/**
 * Content-fingerprint: sha1 of normalizedTitle + '|' + startDate(yyyy-mm-dd) + '|' + venueName.
 * Including startDate prevents over-merging recurring weekly events.
 *
 * @param {string} title
 * @param {string|null} startDate  ISO date string or null
 * @param {string|null} venueName
 * @returns {string}  40-char hex sha1
 */
export function fingerprint(title, startDate, venueName) {
  const datePart = startDate ? startDate.slice(0, 10) : '';
  const key = `${normalizeTitle(title)}|${datePart}|${(venueName ?? '').toLowerCase().trim()}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}
