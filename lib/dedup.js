import crypto from 'crypto';
import { decodeEntities } from './event-filter.js';

/**
 * Lowercase + collapse punctuation/whitespace runs.
 * @param {string} s
 * @returns {string}
 */
function normalizeTitle(s) {
  return decodeEntities(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // café → cafe
    .replace(/['’‘]/g, '')     // it's / it’s → its
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // punctuation → space
    .replace(/\s+/g, ' ')      // collapse whitespace runs
    .trim();
}

/**
 * Content-fingerprint: sha1 of normalizedTitle + '|' + startDate(yyyy-mm-dd) + '|' + normalizedVenue.
 * Including startDate prevents over-merging recurring weekly events.
 *
 * @param {string} title
 * @param {string|null} startDate  ISO date string or null
 * @param {string|null} venueName
 * @returns {string}  40-char hex sha1
 */
export function fingerprint(title, startDate, venueName) {
  const datePart = startDate ? startDate.slice(0, 10) : '';
  const key = `${normalizeTitle(title)}|${datePart}|${normalizeTitle(venueName)}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}
