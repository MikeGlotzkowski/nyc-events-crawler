/**
 * Fixture harness: runs a crawler's real crawl() with the network swapped out.
 *
 *   record — real requests; each response is saved under fixtures/<crawler>/
 *   replay — requests are answered from those saved files; anything not saved gets a 404
 *
 * Both modes freeze Date at the capture time, so date-based request URLs and
 * forward windows come out the same on replay. Supabase, the LLM extractor and
 * og:image page lookups are stubbed; the events handed to upsertEvents are the result.
 *
 * Needs --experimental-test-module-mocks. Import this before any crawler.
 */
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Crawlers with fixtures: every enabled source (nyccom, brooklyn-library and Prospect Park are off). */
export const CRAWLERS = [
  'nyc-parks', 'nyc-opendata', 'ical-feeds', 'riverside-park', 'van-cortlandt-park',
  'forest-park', 'rss-blogs', 'queens-library', 'westsiderag',
];

// Saved bodies are cut down so fixtures stay small.
const MAX_JSON_ROWS = 60;
const MAX_FEED_ITEMS = 10;

// ── Module mocks ─────────────────────────────────────────────────

const realBase = await import('../lib/base-crawler.js?real');
const realLlm  = await import('../lib/llm-extract.js?real');
const realOg   = await import('../lib/og-image.js?real');

let captured = [];

mock.module('../lib/base-crawler.js', {
  namedExports: {
    ...realBase,
    log: () => {},
    logError: () => {},
    startCrawlRun: async () => 'fixture-run',
    finishCrawlRun: async () => {},
    upsertEvents: async (events) => {
      captured.push(...events);
      return { new: events.length, updated: 0, errors: [] };
    },
  },
});

// No LLM: echo the post back as one event, so the expected events show which posts
// passed looksLikeEventPost and the text the parser would have sent to the model.
mock.module('../lib/llm-extract.js', {
  namedExports: {
    ...realLlm,
    extractEventsFromPost: async ({ title, content, pubDate }) => [
      { title, description: content.slice(0, 300), startDate: pubDate },
    ],
  },
});

mock.module('../lib/og-image.js', {
  namedExports: { ...realOg, fetchPageImage: async () => null },
});

// westsiderag: page.evaluate() runs the crawler's own DOM walker against a jsdom of the page.
mock.module('playwright', {
  namedExports: {
    chromium: {
      launch: async () => ({
        close: async () => {},
        newContext: async ({ userAgent } = {}) => ({
          newPage: async () => {
            let dom = null;
            return {
              goto: async (url) => {
                const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                dom = new JSDOM(await res.text(), { url });
              },
              waitForTimeout: async () => {},
              evaluate: async (fn) => {
                const prev = globalThis.document;
                globalThis.document = dom.window.document;
                try { return fn(); } finally { globalThis.document = prev; }
              },
            };
          },
        }),
      }),
    },
  },
});

// ── Saving and loading responses ────────────────────────────────

const manifestPath = (crawler) => path.join(FIXTURES_DIR, crawler, 'manifest.json');

export function loadManifest(crawler) {
  return JSON.parse(fs.readFileSync(manifestPath(crawler), 'utf8'));
}

function trimBody(body, contentType) {
  if (/json/.test(contentType)) {
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data) && data.length > MAX_JSON_ROWS) return JSON.stringify(data.slice(0, MAX_JSON_ROWS));
    } catch { /* not JSON after all; keep as is */ }
    return body;
  }
  if (/xml|rss|atom/.test(contentType) || /^\s*<\?xml/.test(body)) {
    for (const tag of ['item', 'entry']) {
      const open = new RegExp(`<${tag}[\\s>]`, 'g');
      const starts = [...body.matchAll(open)].map(m => m.index);
      if (starts.length > MAX_FEED_ITEMS) {
        const close = `</${tag}>`;
        const cut = body.indexOf(close, starts[MAX_FEED_ITEMS - 1]) + close.length;
        const tail = body.slice(body.lastIndexOf(close) + close.length);
        return body.slice(0, cut) + tail;
      }
    }
  }
  return body;
}

function extFor(contentType, body) {
  if (/json/.test(contentType)) return 'json';
  if (/calendar/.test(contentType) || body.startsWith('BEGIN:VCALENDAR')) return 'ics';
  if (/xml|rss|atom/.test(contentType) || /^\s*<\?xml/.test(body)) return 'xml';
  return 'html';
}

function makeStore(crawler, mode) {
  const dir = path.join(FIXTURES_DIR, crawler);
  const manifest = mode === 'replay' ? loadManifest(crawler) : { capturedAt: null, responses: {} };
  const used = new Set(Object.values(manifest.responses).map(r => r.file));

  return {
    manifest,
    get(url) {
      const entry = manifest.responses[url];
      if (!entry) return null;
      return { ...entry, body: fs.readFileSync(path.join(dir, entry.file), 'utf8') };
    },
    put(url, status, contentType, rawBody) {
      const body = trimBody(rawBody, contentType);
      const host = new URL(url).hostname.replace(/^www\./, '');
      const ext = extFor(contentType, body);
      let file = manifest.responses[url]?.file;
      if (!file) {
        file = `${host}.${ext}`;
        for (let n = 2; used.has(file); n++) file = `${host}-${n}.${ext}`;
        used.add(file);
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
      manifest.responses[url] = { file, status, contentType };
    },
    save() {
      fs.writeFileSync(manifestPath(crawler), JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}

// ── Network stubs ───────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realHttpsGet = https.get;

function installNetwork(store, mode) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (mode === 'record') {
      const res = await realFetch(input, init);
      const body = await res.text();
      const contentType = res.headers.get('content-type') ?? '';
      store.put(url, res.status, contentType, body);
      return new Response(store.get(url).body, { status: res.status, headers: { 'content-type': contentType } });
    }
    const hit = store.get(url);
    if (!hit) return new Response('not in fixtures', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.contentType } });
  };

  // queens-library talks to node:https directly. Replay answers with a plain (unzipped) body.
  https.get = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => req;
    const respond = (status, contentType, body) => {
      const res = Readable.from([Buffer.from(body)]);
      res.statusCode = status;
      res.headers = { 'content-type': contentType };
      callback(res);
    };
    if (mode === 'record') {
      realHttpsGet(url, options, (res) => {
        const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          const contentType = res.headers['content-type'] ?? '';
          store.put(String(url), res.statusCode, contentType, Buffer.concat(chunks).toString('utf8'));
          respond(res.statusCode, contentType, store.get(String(url)).body);
        });
        stream.on('error', err => req.emit('error', err));
      }).on('error', err => req.emit('error', err));
    } else {
      const hit = store.get(String(url));
      setImmediate(() => hit ? respond(hit.status, hit.contentType, hit.body) : respond(404, 'text/plain', 'not in fixtures'));
    }
    return req;
  };
}

function restoreNetwork() {
  globalThis.fetch = realFetch;
  https.get = realHttpsGet;
}

// ── Runner ──────────────────────────────────────────────────────

/** Run one crawler in 'record' or 'replay' mode; returns the events it would have upserted. */
export async function runCrawler(crawler, mode = 'replay') {
  const store = makeStore(crawler, mode);
  if (mode === 'record') store.manifest.capturedAt = new Date().toISOString();

  captured = [];
  mock.timers.enable({ apis: ['Date'], now: new Date(store.manifest.capturedAt) });
  installNetwork(store, mode);
  try {
    const { crawl } = await import(`../crawlers/${crawler}.js`);
    await crawl();
  } finally {
    restoreNetwork();
    mock.timers.reset();
  }

  if (mode === 'record') store.save();
  return JSON.parse(JSON.stringify(captured));
}

export const expectedPath = (crawler) => path.join(FIXTURES_DIR, crawler, 'expected.json');
