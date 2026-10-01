/**
 * Event image discovery
 * Pulls a representative image from a source page (og:image, twitter:image, JSON-LD)
 * or from an HTML fragment such as an RSS item body. Never throws.
 */

const UA = 'fomo3-events-bot/1.0 (+https://github.com/fomo3)';
const MAX_BYTES = 300_000;
const JUNK_RE = /logo|favicon|placeholder|default-image|blank\.(gif|png)|\.svg(\?|$)/i;
const PIXEL_RE = /pixel|feeds\.feedburner|gravatar|stats\.wp\.com/i;
const JUNK_HOST_RE = /(^|\.)(gravatar\.com|feedburner\.com|doubleclick\.net)$/i;

// ── Helpers ───────────────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'");
}

/** Resolve + validate a candidate image URL. Returns an absolute http(s) URL or null. */
export function cleanImageUrl(raw, baseUrl) {
  if (!raw || typeof raw !== 'string') return null;
  const value = decodeEntities(raw.trim());
  if (!value || value.startsWith('data:')) return null;
  let url;
  try {
    url = baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (JUNK_RE.test(url.pathname) || JUNK_HOST_RE.test(url.hostname)) return null;
  return url.href;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function jsonLdImage(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = jsonLdImage(n);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    if (node.image) return jsonLdImage(node.image);
    if (node.url && (node['@type'] === 'ImageObject' || !node['@type'])) return jsonLdImage(node.url);
    if (node['@graph']) return jsonLdImage(node['@graph']);
  }
  return null;
}

// ── Extraction ────────────────────────────────────────────────────

/** First usable image declared in a page's metadata, or null. */
export function extractImageFromHtml(html, pageUrl) {
  if (!html) return null;

  const metas = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (key && content && !(key in metas)) metas[key] = content;
  }
  for (const key of ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
    const url = cleanImageUrl(metas[key], pageUrl);
    if (url) return url;
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if ((attr(tag, 'rel') ?? '').toLowerCase() === 'image_src') {
      const url = cleanImageUrl(attr(tag, 'href'), pageUrl);
      if (url) return url;
    }
  }

  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(ldRe)) {
    try {
      const url = cleanImageUrl(jsonLdImage(JSON.parse(m[1])), pageUrl);
      if (url) return url;
    } catch {
      // malformed JSON-LD is common; ignore
    }
  }

  return null;
}

/** First real <img> in an HTML fragment (e.g. an RSS item body), skipping tracking pixels. */
export function extractImageFromContent(html, baseUrl) {
  if (!html) return null;
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (attr(tag, 'width') === '1' || attr(tag, 'height') === '1') continue;
    const src = attr(tag, 'data-src') ?? attr(tag, 'src');
    if (!src || PIXEL_RE.test(src)) continue;
    const url = cleanImageUrl(src, baseUrl);
    if (url) return url;
  }
  return null;
}

// ── Fetch ─────────────────────────────────────────────────────────

const cache = new Map();

export function clearImageCache() {
  cache.clear();
}

async function readHead(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  while (html.length < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    // Metadata lives in <head>; keep reading past it only when it had none (JSON-LD may sit in <body>).
    if (/<\/head>/i.test(html) && /og:image|twitter:image/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

async function fetchUncached(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null;
    return extractImageFromHtml(await readHead(res), res.url || url);
  } catch {
    return null;
  }
}

/** Fetch a page and return its declared image URL, or null. Memoized per URL; never throws. */
export function fetchPageImage(url) {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) cache.set(url, fetchUncached(url));
  return cache.get(url);
}
