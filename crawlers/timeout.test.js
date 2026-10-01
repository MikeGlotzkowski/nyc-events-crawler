import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let timeout;
before(async () => { timeout = await import('./timeout.js'); });

const tile = ({ title = '<span>1.</span>&nbsp;Taste of Sunnyside', ticket = true } = {}) => `
<article class="tile" data-testid="tile-zone-large-list_testID"><div>
  <a href="/newyork/things-to-do/taste-of-sunnyside" class="" data-testid="tile-link_testID"><h3>${title}</h3></a>
  <ul><li><span class="_text_1i2cm_68">Things to do</span></li><li><span class="_text_1i2cm_68">Food</span></li></ul>
  <img src="https://media.timeout.com/images/1/750/422/image.jpg" alt="">
  <div class="_p_1mmxl_1" data-testid="summary_testID"><p>Queens&rsquo; food crawl.</p>
  <p>Sunday, October 4, 1&ndash;7pm.</p></div>
  ${ticket ? '<a class="_a" href="https://tickets.example/tos?a=1&amp;b=2" data-testid="buy-now-button_testID">Buy ticket</a>' : ''}
</div></article>`;

describe('timeout', () => {
  it('reads the numbered tiles of the weekend list', () => {
    const html = `<time class="t" dateTime="2026-09-30T00:00:00-04:00">Wednesday</time>
      <article data-testid="tile-zone-zero_testID"><h3>Time Out Market</h3></article>${tile()}${tile({ ticket: false })}`;
    assert.equal(timeout.pageDate(html), '2026-09-30T00:00:00-04:00');
    const tiles = timeout.parseTiles(html);
    assert.equal(tiles.length, 2);
    assert.deepEqual(tiles[0], {
      title:     'Taste of Sunnyside',
      url:       'https://www.timeout.com/newyork/things-to-do/taste-of-sunnyside',
      image:     'https://media.timeout.com/images/1/750/422/image.jpg',
      tags:      ['Things to do', 'Food'],
      summary:   'Queens’ food crawl.\n\nSunday, October 4, 1–7pm.',
      ticketUrl: 'https://tickets.example/tos?a=1&b=2',
    });
    assert.equal(tiles[1].ticketUrl, null);
  });

  it('keeps the tile title and link, takes date and venue from the extractor, drops undated tiles', () => {
    const [t] = timeout.parseTiles(tile());
    assert.equal(timeout.mapTile(t, { title: 'Permanent', startDate: null }), null);
    const e = timeout.mapTile(t, {
      title: 'A Taste of Sunnyside 2026', startDate: '2026-10-04', time: '1:00 PM',
      location: { name: 'Sunnyside Arch', address: '46th St & Queens Blvd, Sunnyside, NY 11104' },
      categories: ['Food'],
    });
    assert.equal(e.title, 'Taste of Sunnyside');
    assert.equal(e.sourceUrl, t.url);
    assert.deepEqual(e.categories, ['Food']);
    assert.equal(e.ticketUrl, 'https://tickets.example/tos?a=1&b=2');
    assert.equal(e.borough, 'Queens');
  });
});
