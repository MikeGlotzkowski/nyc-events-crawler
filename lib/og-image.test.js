import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractImageFromHtml, extractImageFromContent, cleanImageUrl } from './og-image.js';

const page = 'https://blog.example.com/2026/10/fall-fair/';

describe('extractImageFromHtml', () => {
  it('reads og:image with property before content', () => {
    const html = '<head><meta property="og:image" content="https://cdn.example.com/fair.jpg"></head>';
    assert.equal(extractImageFromHtml(html, page), 'https://cdn.example.com/fair.jpg');
  });

  it('reads og:image with content before property and single quotes', () => {
    const html = "<meta content='https://cdn.example.com/fair.jpg' property='og:image' />";
    assert.equal(extractImageFromHtml(html, page), 'https://cdn.example.com/fair.jpg');
  });

  it('prefers og:image:secure_url and decodes &amp;', () => {
    const html = '<meta property="og:image" content="http://x.com/a.jpg">'
      + '<meta property="og:image:secure_url" content="https://x.com/a.jpg?w=1200&amp;h=630">';
    assert.equal(extractImageFromHtml(html, page), 'https://x.com/a.jpg?w=1200&h=630');
  });

  it('falls back to twitter:image', () => {
    const html = '<meta name="twitter:image" content="https://x.com/t.png">';
    assert.equal(extractImageFromHtml(html, page), 'https://x.com/t.png');
  });

  it('resolves relative and protocol-relative URLs', () => {
    assert.equal(extractImageFromHtml('<meta property="og:image" content="/img/a.jpg">', page), 'https://blog.example.com/img/a.jpg');
    assert.equal(extractImageFromHtml('<meta property="og:image" content="//cdn.x.com/a.jpg">', page), 'https://cdn.x.com/a.jpg');
  });

  it('skips logos and svgs and moves on to the next candidate', () => {
    const html = '<meta property="og:image" content="https://x.com/site-logo.png">'
      + '<meta name="twitter:image" content="https://x.com/icon.svg">'
      + '<link rel="image_src" href="https://x.com/real.jpg">';
    assert.equal(extractImageFromHtml(html, page), 'https://x.com/real.jpg');
  });

  it('reads JSON-LD image as array and as ImageObject', () => {
    const arr = '<script type="application/ld+json">{"@type":"Event","image":["https://x.com/1.jpg","https://x.com/2.jpg"]}</script>';
    assert.equal(extractImageFromHtml(arr, page), 'https://x.com/1.jpg');
    const obj = '<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Article","image":{"@type":"ImageObject","url":"https://x.com/o.jpg"}}]}</script>';
    assert.equal(extractImageFromHtml(obj, page), 'https://x.com/o.jpg');
  });

  it('returns null when nothing usable is declared', () => {
    assert.equal(extractImageFromHtml('<html><head><title>x</title></head></html>', page), null);
    assert.equal(extractImageFromHtml('<meta property="og:image" content="data:image/png;base64,AAA">', page), null);
    assert.equal(extractImageFromHtml('', page), null);
  });
});

describe('extractImageFromContent', () => {
  it('returns the first real img, skipping tracking pixels', () => {
    const html = '<img src="https://feeds.feedburner.com/~r/x/~4/abc" width="1" height="1">'
      + '<p>Hi</p><img class="wp-image" src="/wp-content/uploads/fair.jpg">';
    assert.equal(extractImageFromContent(html, page), 'https://blog.example.com/wp-content/uploads/fair.jpg');
  });

  it('prefers data-src for lazy-loaded images', () => {
    const html = '<img src="data:image/gif;base64,R0l" data-src="https://x.com/lazy.jpg">';
    assert.equal(extractImageFromContent(html, page), 'https://x.com/lazy.jpg');
  });

  it('returns null without images', () => {
    assert.equal(extractImageFromContent('<p>No pictures</p>', page), null);
  });
});

describe('cleanImageUrl', () => {
  it('rejects non-http schemes and junk', () => {
    assert.equal(cleanImageUrl('javascript:alert(1)', page), null);
    assert.equal(cleanImageUrl('https://x.com/favicon.ico', page), null);
    assert.equal(cleanImageUrl(null, page), null);
    assert.equal(cleanImageUrl('https://secure.gravatar.com/avatar/abc?s=96', page), null);
  });
});
