/**
 * Borough and neighborhood for an event, from what a source knows about its location.
 *
 *   resolveArea({ name, address, lat, lng, borough, neighborhood })
 *
 * name/address are the location text; borough/neighborhood are the source's own defaults,
 * used when the location says nothing better. Evidence, strongest first: a known venue,
 * a neighborhood named in the text, the ZIP code, "<Borough>, NY", Manhattan cross
 * streets, then the nearest neighborhood to lat/lng. Boroughs come out canonical
 * (Manhattan, Brooklyn, Queens, Bronx, Staten Island).
 */
import { NEIGHBORHOODS, NEIGHBORHOOD_ALIASES, AMBIGUOUS_NAMES, VENUES, ZIPS } from './nyc-area-data.js';

export const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];

const BOROUGH_ALIASES = {
  'manhattan': 'Manhattan', 'mn': 'Manhattan', 'new york county': 'Manhattan',
  'brooklyn': 'Brooklyn', 'bk': 'Brooklyn', 'kings': 'Brooklyn', 'kings county': 'Brooklyn',
  'queens': 'Queens', 'qn': 'Queens', 'queens county': 'Queens',
  'bronx': 'Bronx', 'the bronx': 'Bronx', 'bx': 'Bronx', 'bronx county': 'Bronx',
  'staten island': 'Staten Island', 'si': 'Staten Island', 'richmond': 'Staten Island', 'richmond county': 'Staten Island',
};

/** 'The Bronx', 'BX', 'brooklyn' … → canonical borough name, or null. */
export function normalizeBorough(raw) {
  if (typeof raw !== 'string') return null;
  return BOROUGH_ALIASES[raw.trim().toLowerCase()] ?? null;
}

const HOOD_BOROUGH = new Map(NEIGHBORHOODS.map(([name, borough]) => [name, borough]));

// ── Venues ───────────────────────────────────────────────────────

const VENUE_KEYS = Object.keys(VENUES).sort((a, b) => b.length - a.length);

export function findVenue(text) {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const key = VENUE_KEYS.find(k => t.includes(k));
  return key ? { borough: VENUES[key][0], neighborhood: VENUES[key][1] } : null;
}

// ── Neighborhood named in the text ───────────────────────────────

// A name followed by one of these is a street or a park, not the neighborhood itself
// (Flatbush Avenue, Jamaica Bay, Harlem River, Belmont Park).
const NOT_A_PLACE_AFTER = '(?!\\s+(?:ave|avenue|blvd|boulevard|st|street|pkwy|parkway|rd|road|pl|place|dr|drive|ln|lane|expy|expressway|tpke|turnpike|bay|river|park)\\b)';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]?");

const NAME_PATTERNS = [
  ...[...HOOD_BOROUGH.keys()].filter(name => !AMBIGUOUS_NAMES.has(name)).map(name => [name, name]),
  ...Object.entries(NEIGHBORHOOD_ALIASES),
]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([text, name]) => [new RegExp(`(?<![\\w-])${escape(text)}(?![\\w-])${NOT_A_PLACE_AFTER}`, 'i'), name]);

export function findNeighborhoodName(text) {
  const hit = NAME_PATTERNS.find(([re]) => re.test(text));
  return hit ? { borough: HOOD_BOROUGH.get(hit[1]), neighborhood: hit[1] } : null;
}

// ── ZIP code ─────────────────────────────────────────────────────

export function boroughFromZip(zip) {
  const z = String(zip);
  if (/^10[0-2]\d\d$/.test(z)) return 'Manhattan';
  if (/^103\d\d$/.test(z))     return 'Staten Island';
  if (/^104\d\d$/.test(z))     return 'Bronx';
  if (/^112\d\d$/.test(z))     return 'Brooklyn';
  if (/^(1100[45]|11[1346]\d\d)$/.test(z)) return 'Queens';
  return null;
}

/** The ZIP in an address ('New York, NY 10031', 'Brooklyn, New York, 11238'), if it is an NYC one. */
export function findZip(text) {
  const matches = [...text.matchAll(/(?:\bNY|New York|,)\s*,?\s*(1[01]\d{3})(?:-\d{4})?\b/gi)];
  const zip = matches.at(-1)?.[1];
  const borough = zip ? boroughFromZip(zip) : null;
  return borough ? { borough, neighborhood: ZIPS[zip] ?? null } : null;
}

// ── "<Borough>, NY" ──────────────────────────────────────────────

function findBoroughCity(text) {
  const m = text.match(/\b(manhattan|brooklyn|(?:the\s+)?bronx|queens|staten island)\s*,\s*(?:ny|new york)\b/i)
    ?? text.trim().match(/^(manhattan|brooklyn|(?:the\s+)?bronx|queens|staten island)$/i);
  return m ? { borough: normalizeBorough(m[1]), neighborhood: null } : null;
}

// ── Manhattan cross streets ──────────────────────────────────────

// Above 110th St, avenues east of Morningside/St. Nicholas Park mean Harlem, not the west side.
const HARLEM_AVENUES = /\b(lenox|malcolm x|adam clayton|powell|frederick douglass|8th ave|eighth ave|8 avenue|fifth|5th ave|5 avenue|madison|park ave|lexington|morningside ave|manhattan ave|mount morris|marcus garvey)\b/i;

/** 'W 68th Street', 'EAST  104 STREET' … → the Manhattan neighborhood for that street, or null. */
export function manhattanStreetNeighborhood(text) {
  const m = text.match(/\b(W|West|E|East)\.?\s+(\d{1,3})(?:st|nd|rd|th)?\s+(?:St|Street)\b/i);
  if (!m) return null;
  const n = Number(m[2]);
  if (/^w/i.test(m[1])) {
    if (n < 14)  return 'Greenwich Village';
    if (n < 34)  return 'Chelsea';
    if (n < 60)  return 'Midtown';
    if (n < 110) return 'Upper West Side';
    if (n < 155) return HARLEM_AVENUES.test(text) ? 'Harlem' : n < 125 ? 'Morningside Heights' : 'Hamilton Heights';
    if (n < 200) return 'Washington Heights';
    return 'Inwood';
  }
  if (n < 14)  return 'East Village';
  if (n < 34)  return 'Gramercy';
  if (n < 43)  return 'Murray Hill';
  if (n < 60)  return 'Midtown East';
  if (n < 97)  return 'Upper East Side';
  if (n < 143) return 'East Harlem';
  return null;
}

// ── Coordinates ──────────────────────────────────────────────────

const MAX_KM = 2.5;

/** Nearest neighborhood center within 2.5 km, optionally limited to one borough. */
export function nearestNeighborhood(lat, lng, borough = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 40.49 || lat > 40.92 || lng < -74.27 || lng > -73.68) return null;
  let best = null;
  for (const [name, b, hLat, hLng] of NEIGHBORHOODS) {
    if (borough && b !== borough) continue;
    const km = Math.hypot((lat - hLat) * 110.57, (lng - hLng) * 84.4);
    if (km <= MAX_KM && (!best || km < best.km)) best = { borough: b, neighborhood: name, km };
  }
  return best && { borough: best.borough, neighborhood: best.neighborhood };
}

// ── Resolver ─────────────────────────────────────────────────────

export function resolveArea({ name, address, lat, lng, borough, neighborhood } = {}) {
  const text = [name, address].filter(s => typeof s === 'string' && s.trim()).join(', ');
  const fallbackBorough = normalizeBorough(borough);
  let b = null;
  let n = null;
  const take = (hit) => {
    if (!hit?.borough) return;
    b ??= hit.borough;
    if (!n && hit.neighborhood && hit.borough === b) n = hit.neighborhood;
  };

  if (text) {
    const zip = findZip(text);
    const venue = findVenue(text);
    // A ZIP in another borough beats a venue name (a park's events held off-site).
    if (!zip || venue?.borough === zip.borough) take(venue);
    take(findNeighborhoodName(text));
    take(zip);
    take(findBoroughCity(text));
  }
  b ??= fallbackBorough;
  if (!n && b === 'Manhattan' && text) n = manhattanStreetNeighborhood(text);
  if (!n) take(nearestNeighborhood(lat, lng, b));
  if (!n && neighborhood && b === fallbackBorough) n = neighborhood;

  return { neighborhood: n, borough: b };
}
