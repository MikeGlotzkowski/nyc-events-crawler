// TEMPORARY: probe candidate feeds from a GitHub runner. Removed before merge.
import { fetchFeed } from '../crawlers/rss-blogs.js';
import { looksLikeEventPost } from '../lib/llm-extract.js';

const CANDIDATES = [
  'https://w42st.com/feed/',
  'https://www.amny.com/tag/hells-kitchen/feed/',
  'https://jacksonheightspost.com/feed/',
  'https://qns.com/tag/jackson-heights/feed/',
  'https://licpost.com/feed/',
  'https://qns.com/tag/long-island-city/feed/',
  'https://queenspost.com/feed/',
  'https://kelleymacdonald.substack.com/feed',
  'https://parkslopewalk.substack.com/feed',
  'https://www.brooklynpaper.com/tag/park-slope/feed/',
  'https://www.brooklynpaper.com/tag/williamsburg/feed/',
  'https://freewilliamsburg.com/feed/',
  'https://www.brooklynvegan.com/feed/',
  'https://siparent.com/feed/',
  'https://statenislandmuseum.org/feed/',
  'https://snug-harbor.org/feed/',
  'https://www.silive.com/arc/outboundfeeds/rss/category/entertainment/?outputType=xml',
  'https://www.historicrichmondtown.org/feed/',
];

for (const url of CANDIDATES) {
  try {
    const items = await fetchFeed(url);
    const dates = items.map(i => Date.parse(i.pubDate)).filter(Number.isFinite).sort((a, b) => b - a);
    const newest = dates[0] ? new Date(dates[0]).toISOString().slice(0, 10) : '-';
    const recent = dates.filter(d => d > Date.now() - 14 * 864e5).length;
    const eventy = items.filter(i => looksLikeEventPost(i.title, i.content)).length;
    console.log(`PROBE OK  ${url} items=${items.length} newest=${newest} last14d=${recent} eventLike=${eventy}`);
    for (const i of items.slice(0, 6)) console.log(`      - ${i.title}`);
  } catch (err) {
    console.log(`PROBE ERR ${url} ${err.message}`);
  }
}
