/**
 * NYC.com Events Crawler
 * Refactored from index.js into a module that exports crawl().
 * Uses Playwright to scrape official.nyc.com across all event categories.
 * Results are upserted to Supabase instead of written to disk.
 */
import { chromium } from 'playwright';
import OpenAI from 'openai';
import { loadEnv } from '../env-loader.js';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvent } from '../lib/base-crawler.js';

loadEnv();

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_URL            = 'https://official.nyc.com/events/';
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const USE_LLM_EXTRACTION  = process.env.USE_LLM_EXTRACTION === 'true';
const PAGE_TIMEOUT        = 15000;
const WAIT_CONDITION      = 'domcontentloaded';

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ============================================================================
// LLM FALLBACK HELPER
// ============================================================================

async function extractEventDetailsWithLLM(html, url) {
  if (!openai) {
    log('⚠️  LLM extraction requested but OpenAI API key not configured');
    return null;
  }

  try {
    log(`🤖 Using enhanced LLM extraction for: ${url}`);

    const prompt = `You are an expert event data extraction assistant. Extract comprehensive event information from the HTML and return ONLY valid JSON.

IMPORTANT: Extract as much information as possible. Look for:
- Full detailed descriptions (combine multiple paragraphs if needed)
- All dates and times mentioned
- Complete venue/location information
- Price details and ticket information
- Event categories, genres, or types
- Organizer or host information
- Any special notes, requirements, or highlights
- Visual content (images, videos)

Return ONLY valid JSON matching this exact schema:

{
  "source": "NYC.com",
  "sourceUrl": "${url}",
  "title": "string (required)",
  "description": "string - combine all relevant paragraphs, aim for 200-500 words if available",
  "startDate": "ISO date string or null",
  "endDate": "ISO date string or null",
  "time": "string or null",
  "location": {
    "name": "string or null",
    "address": "string or null",
    "city": "string or null",
    "lat": null,
    "lng": null
  },
  "price": {
    "min": null,
    "max": null,
    "currency": "USD",
    "isFree": boolean or null
  },
  "categories": ["array of strings - all categories/genres/types mentioned"],
  "tags": ["array of strings - keywords, themes, features"],
  "organizer": "string or null - venue name, host, or organization",
  "attendance": null,
  "ticketUrl": "string or null",
  "images": ["array of all image URLs found"],
  "rawText": "string - any additional context or notes"
}

HTML:
${html.substring(0, 12000)}

Return ONLY the JSON object, no markdown formatting, no explanation.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 3000,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty response from LLM');

    let jsonStr = content;
    if (content.startsWith('```')) {
      const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) jsonStr = match[1];
    }

    return JSON.parse(jsonStr);
  } catch (error) {
    logError('LLM extraction failed', error);
    return null;
  }
}

// ============================================================================
// EVENT ENRICHMENT PIPELINE
// ============================================================================

async function enrichWithWebResearch(event) {
  if (!openai) return event;

  try {
    log(`   🌐 Web research enrichment for: ${event.title}`);

    const prompt = `You are researching an NYC event to provide additional context.

Event: "${event.title}"
Venue: "${event.location?.name || 'Unknown'}"
Current Description: "${event.description?.substring(0, 200) || 'None'}"

Based on your knowledge, provide additional enrichment data:
1. Is this event/show/attraction well-known? What's its reputation?
2. Any notable reviews, awards, or recognition?
3. What type of audience would enjoy this? (families, couples, art enthusiasts, etc.)
4. Any interesting facts or context that would help someone decide to attend?
5. What makes this special or unique?

Return ONLY valid JSON with this structure:
{
  "enrichedDescription": "Enhanced description combining original + your additions (2-3 sentences)",
  "audienceTags": ["array of audience types"],
  "highlights": ["array of 2-3 key highlights or interesting facts"],
  "reputation": "brief reputation/popularity note or null"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return event;

    let jsonStr = content;
    if (content.startsWith('```')) {
      const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) jsonStr = match[1];
    }

    const enrichment = JSON.parse(jsonStr);

    if (enrichment.enrichedDescription && enrichment.enrichedDescription.length > (event.description?.length || 0)) {
      event.description = enrichment.enrichedDescription;
    }
    if (enrichment.audienceTags) {
      event.tags = [...new Set([...(event.tags || []), ...enrichment.audienceTags])];
    }
    if (enrichment.highlights) {
      event.rawText = event.rawText
        ? `${event.rawText}\n\nHighlights: ${enrichment.highlights.join('; ')}`
        : `Highlights: ${enrichment.highlights.join('; ')}`;
    }
    if (enrichment.reputation) {
      event.rawText = event.rawText
        ? `${event.rawText}\n\nReputation: ${enrichment.reputation}`
        : `Reputation: ${enrichment.reputation}`;
    }

    log('   ✅ Web research complete');
    return event;
  } catch (error) {
    logError('Web research enrichment failed', error);
    return event;
  }
}

async function enrichWithVenueIntelligence(event) {
  if (!openai || !event.location?.name) return event;

  try {
    log(`   🏛️  Venue intelligence for: ${event.location.name}`);

    const prompt = `You are a NYC venue expert. Provide information about this venue:

Venue Name: "${event.location.name}"
Address: "${event.location.address || 'Unknown'}"

Provide venue intelligence:
1. What type of venue is this? (museum, theater, concert hall, park, sports arena, etc.)
2. Is this a famous or historic venue in NYC?
3. What's the typical capacity or size?
4. Any accessibility or visitor information people should know?

Return ONLY valid JSON:
{
  "venueType": "string - venue type",
  "venueDescription": "1-2 sentence description of the venue or null",
  "isHistoric": boolean,
  "estimatedCapacity": "string like 'Large (1000+)', 'Medium (200-1000)', 'Small (under 200)' or null"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return event;

    let jsonStr = content;
    if (content.startsWith('```')) {
      const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) jsonStr = match[1];
    }

    const venueInfo = JSON.parse(jsonStr);

    if (venueInfo.venueType) {
      event.tags = [...new Set([...(event.tags || []), venueInfo.venueType])];
    }
    if (venueInfo.venueDescription) {
      event.location.description = venueInfo.venueDescription;
    }
    if (venueInfo.isHistoric) {
      event.tags = [...new Set([...(event.tags || []), 'Historic Venue'])];
    }
    if (venueInfo.estimatedCapacity) {
      event.attendance = venueInfo.estimatedCapacity;
    }

    log('   ✅ Venue intelligence complete');
    return event;
  } catch (error) {
    logError('Venue intelligence enrichment failed', error);
    return event;
  }
}

async function enrichWithSmartCategories(event) {
  if (!openai) return event;

  try {
    log(`   🏷️  Smart categorization for: ${event.title}`);

    const prompt = `You are an event categorization expert. Analyze this NYC event and assign relevant categories.

Title: "${event.title}"
Description: "${event.description?.substring(0, 300) || 'None'}"
Venue: "${event.location?.name || 'Unknown'}"
Current Categories: ${JSON.stringify(event.categories || [])}

Assign 2-5 relevant categories from this list (or suggest new ones if none fit):
- Arts & Culture
- Music & Concerts
- Theater & Broadway
- Museums & Exhibitions
- Sports & Recreation
- Food & Dining
- Nightlife & Entertainment
- Family & Kids
- Tours & Sightseeing
- Comedy
- Dance & Ballet
- Opera & Classical
- Film & Cinema
- Festivals & Events
- Outdoor & Nature
- History & Heritage
- Technology & Innovation
- Fashion & Design
- Literary & Books
- Health & Wellness

Also determine if it's suitable for:
- Families with children
- Date night
- Solo travelers
- Groups
- Tourists vs Locals

Return ONLY valid JSON:
{
  "categories": ["array of 2-5 main categories"],
  "audienceTypes": ["array of suitable audience types"],
  "bestFor": ["array of 1-3 use cases like 'date night', 'family outing', etc."]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return event;

    let jsonStr = content;
    if (content.startsWith('```')) {
      const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) jsonStr = match[1];
    }

    const categorization = JSON.parse(jsonStr);

    if (categorization.categories) {
      event.categories = event.categories && event.categories.length > 0
        ? [...new Set([...event.categories, ...categorization.categories])]
        : categorization.categories;
    }
    if (categorization.audienceTypes) {
      event.tags = [...new Set([...(event.tags || []), ...categorization.audienceTypes])];
    }
    if (categorization.bestFor) {
      event.tags = [...new Set([...(event.tags || []), ...categorization.bestFor])];
    }

    log('   ✅ Smart categorization complete');
    return event;
  } catch (error) {
    logError('Smart categorization enrichment failed', error);
    return event;
  }
}

async function enrichEvent(event) {
  if (!event || !openai) return event;

  log(`🔬 Starting enrichment pipeline for: ${event.title}`);

  try {
    const [enriched1, enriched2, enriched3] = await Promise.all([
      enrichWithWebResearch(event),
      enrichWithVenueIntelligence(event),
      enrichWithSmartCategories(event),
    ]);

    log(`✅ Enrichment pipeline complete for: ${event.title}`);
    return enriched3;
  } catch (error) {
    logError('Event enrichment failed', error);
    return event;
  }
}

// ============================================================================
// EVENT DETAIL EXTRACTION
// ============================================================================

async function extractEventDetails(page, url) {
  try {
    log(`📄 Extracting details from: ${url}`);
    log('   ⏳ Loading page...');

    await page.goto(url, { waitUntil: WAIT_CONDITION, timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(5000);

    const isCloudflare = await page.evaluate(() => {
      return document.body.textContent.includes('Verify you are human') ||
             document.body.textContent.includes('Enable JavaScript and cookies');
    });

    if (isCloudflare) {
      log('   ⚠️  Cloudflare challenge detected, waiting longer...');
      await page.waitForTimeout(5000);
    }

    log('   ✓ Page loaded');

    if (USE_LLM_EXTRACTION) {
      log('   🤖 Using LLM extraction (deterministic disabled)...');
      const html = await page.content();
      const event = await extractEventDetailsWithLLM(html, url);

      const finalEvent = event || {
        source: 'NYC.com', sourceUrl: url, title: 'Extraction Failed',
        description: null, startDate: null, endDate: null, time: null,
        location: { name: null, address: null, city: 'New York', lat: null, lng: null },
        price: { min: null, max: null, currency: 'USD', isFree: null },
        categories: [], tags: [], organizer: null, attendance: null,
        ticketUrl: null, images: [], rawText: null,
      };

      if (finalEvent?.title) {
        finalEvent.id = generateEventId(url, finalEvent.title);
      }
      return finalEvent;
    }

    // Deterministic extraction
    const event = await page.evaluate((sourceUrl) => {
      const data = {
        id: null, source: 'NYC.com', sourceUrl,
        title: null, description: null, startDate: null, endDate: null, time: null,
        location: { name: null, address: null, city: 'New York', lat: null, lng: null },
        price: { min: null, max: null, currency: 'USD', isFree: null },
        categories: [], tags: [], organizer: null, attendance: null,
        ticketUrl: null, images: [], rawText: null,
        neighborhood: null, borough: null,
      };

      const h1 = document.querySelector('h1');
      if (h1) data.title = h1.textContent.trim();
      if (!data.title) {
        const titleMeta = document.querySelector('meta[property="og:title"]');
        if (titleMeta) data.title = titleMeta.getAttribute('content');
      }

      const bodyText = document.body.textContent;

      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc) data.description = ogDesc.getAttribute('content');

      if (!data.description || data.description.length < 100) {
        const paragraphs = Array.from(document.querySelectorAll('p'));
        const longParagraphs = paragraphs
          .map(p => p.textContent.trim())
          .filter(text => text.length > 100 && text.length < 2000)
          .filter(text => !text.includes('©') && !text.includes('Terms'));
        if (longParagraphs.length > 0) {
          data.description = longParagraphs.join(' ').substring(0, 1000);
        }
      }

      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const imgUrl = ogImage.getAttribute('content');
        if (imgUrl?.startsWith('http')) data.images.push(imgUrl);
      }

      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(' ')[0];
        if (src?.startsWith('http') &&
            !src.includes('icon') && !src.includes('logo') &&
            !src.includes('facebook') && !src.includes('twitter') &&
            (img.width > 100 || img.naturalWidth > 100)) {
          if (!data.images.includes(src)) data.images.push(src);
        }
      });

      const timeMatch = bodyText.match(/START TIME\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
      if (timeMatch) data.time = timeMatch[1];
      if (!data.time) {
        const fromMatch = bodyText.match(/From\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
        if (fromMatch) data.time = fromMatch[1];
      }

      const datePatterns = [
        /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\s+\w+/gi,
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
        /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g,
      ];
      for (const pattern of datePatterns) {
        const matches = bodyText.match(pattern);
        if (matches?.[0]) { data.startDate = matches[0]; break; }
      }

      const venueLinks = document.querySelectorAll('a[href*="arts__attractions"], a[href*="venue"]');
      if (venueLinks.length > 0) data.location.name = venueLinks[0].textContent.trim();

      const addressMatch = bodyText.match(/(\d+\s+[A-Za-z\s]+(?:Avenue|Street|Road|Boulevard|Drive|Lane|Way|Place)[^,\n]*(?:,\s*New York)?[^,\n]*NY[^,\n]*\d{5}(?:-\d{4})?)/i);
      if (addressMatch) {
        data.location.address = addressMatch[1].trim();
        if (!data.location.name) {
          const venueMatch = bodyText.match(/([A-Za-z\s\(\)]+)\s*\d+\s+[A-Za-z\s]+(?:Avenue|Street)/i);
          if (venueMatch) data.location.name = venueMatch[1].trim();
        }
      }

      const pricePatterns = [
        /(?:ADMISSION|PRICE)?\s*FROM\s+\$(\d+(?:\.\d{2})?)/i,
        /\$(\d+(?:\.\d{2})?)\s*(?:-|\sto\s)\s*\$(\d+(?:\.\d{2})?)/i,
        /\$(\d+(?:\.\d{2})?)/,
      ];
      for (const pattern of pricePatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          data.price.min = parseFloat(match[1]);
          if (match[2]) data.price.max = parseFloat(match[2]);
          data.price.isFree = false;
          break;
        }
      }
      if (!data.price.min) {
        const freeLower = bodyText.toLowerCase();
        if (freeLower.includes('free admission') || freeLower.includes('free entry') || freeLower.includes('no charge')) {
          data.price.isFree = true;
        }
      }

      const categoryMatch = bodyText.match(/CATEGORY\s+([A-Za-z\s&]+)/i);
      if (categoryMatch) data.categories.push(categoryMatch[1].trim());
      document.querySelectorAll('a[href*="/category/"], a[href*="category"]').forEach(el => {
        const cat = el.textContent.trim();
        if (cat && cat.length < 50 && cat.length > 2 && !data.categories.includes(cat)) {
          data.categories.push(cat);
        }
      });

      const ticketLinks = document.querySelectorAll('a[href*="ticket"], a[href*="admission"], a[href*="buy"]');
      for (const link of ticketLinks) {
        const linkText = link.textContent.toLowerCase();
        if (linkText.includes('ticket') || linkText.includes('buy') || linkText.includes('admission')) {
          if (link.href?.startsWith('http')) { data.ticketUrl = link.href; break; }
        }
      }

      const websiteLinks = document.querySelectorAll('a[href*="http"]');
      websiteLinks.forEach(link => {
        const text = link.textContent.toLowerCase();
        if (text.includes('website') || text.includes('official')) {
          if (!data.organizer && link.href) {
            const domain = link.href.match(/https?:\/\/([^\/]+)/);
            if (domain) data.organizer = domain[1];
          }
        }
      });

      const mainContent = document.querySelector('main, article, [role="main"], .content');
      data.rawText = (mainContent || document.body).textContent.substring(0, 2000).trim();

      return data;
    }, url);

    const needsLLM = !event.title || !event.description || !event.location.name ||
                     !event.time || event.images.length === 0;

    if (needsLLM && openai) {
      log(`   ⚠️  Incomplete data, trying LLM fallback...`);
      const html = await page.content();
      const llmEvent = await extractEventDetailsWithLLM(html, url);

      if (llmEvent) {
        return {
          ...event,
          title:       llmEvent.title       || event.title,
          description: llmEvent.description || event.description,
          startDate:   llmEvent.startDate   || event.startDate,
          endDate:     llmEvent.endDate     || event.endDate,
          time:        llmEvent.time        || event.time,
          location: {
            name:    llmEvent.location?.name    || event.location.name,
            address: llmEvent.location?.address || event.location.address,
            city:    llmEvent.location?.city    || event.location.city || 'New York',
            lat:     llmEvent.location?.lat     || event.location.lat,
            lng:     llmEvent.location?.lng     || event.location.lng,
          },
          price: {
            min:      llmEvent.price?.min      ?? event.price.min,
            max:      llmEvent.price?.max      ?? event.price.max,
            currency: llmEvent.price?.currency || event.price.currency,
            isFree:   llmEvent.price?.isFree   ?? event.price.isFree,
          },
          organizer:  llmEvent.organizer  || event.organizer,
          ticketUrl:  llmEvent.ticketUrl  || event.ticketUrl,
          images:     [...new Set([...event.images, ...(llmEvent.images || [])])],
          categories: [...new Set([...event.categories, ...(llmEvent.categories || [])])],
          tags:       [...new Set([...event.tags, ...(llmEvent.tags || [])])],
        };
      }
    } else if (!needsLLM) {
      log('   ✅ Complete deterministic extraction');
    }

    if (event?.title) {
      event.id = generateEventId(url, event.title);
    }
    return event;
  } catch (error) {
    logError(`Failed to extract event details from ${url}`, error);
    return null;
  }
}

// ============================================================================
// CATEGORY DISCOVERY
// ============================================================================

async function discoverCategories(page) {
  try {
    log('🔍 Discovering category pages...');
    const categories = new Set();

    const mainCategories = [
      'https://official.nyc.com/events/',
      'https://official.nyc.com/broadway_tickets/',
      'https://official.nyc.com/concert_tickets/',
      'https://official.nyc.com/sport_tickets/',
      // movies/ omitted — scrapes showtimes (Documentary spam), not real events
      'https://official.nyc.com/guided_tours/',
      'https://official.nyc.com/arts__attractions/',
    ];

    mainCategories.forEach(url => categories.add(url));

    for (const categoryUrl of mainCategories) {
      try {
        log(`   📂 Checking: ${categoryUrl}`);
        await page.goto(categoryUrl, { waitUntil: WAIT_CONDITION, timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(4000);

        const subcategories = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            const text = a.textContent.trim().toLowerCase();
            if (
              (href.includes('/concert_tickets/') && text.length < 30 && text.length > 3) ||
              (href.includes('/sport_tickets/') && text.length < 30 && text.length > 3) ||
              (href.includes('/category/') || href.includes('/type/')) ||
              (href.includes('/broadway_tickets/') && !href.match(/\.\d+/) && text.length < 30) ||
              // /movies/ excluded — showtimes section produces Documentary spam, not real events
              (href.includes('/guided_tours/') && text.length < 50 && text.length > 5)
            ) {
              if (!href.match(/\.\d+\/?$/)) links.push(href);
            }
          });
          return [...new Set(links)];
        });

        subcategories.forEach(url => categories.add(url));
        log(`   ✓ Found ${subcategories.length} subcategories`);
      } catch (error) {
        logError(`Failed to check category ${categoryUrl}`, error);
      }
    }

    const categoryList = Array.from(categories);
    log(`✅ Discovered ${categoryList.length} total category pages`);
    return categoryList;
  } catch (error) {
    logError('Failed to discover categories', error);
    return ['https://official.nyc.com/events/'];
  }
}

async function collectEventUrlsFromCategory(page, categoryUrl) {
  try {
    log(`🔗 Collecting event URLs from: ${categoryUrl}`);
    await page.goto(categoryUrl, { waitUntil: WAIT_CONDITION, timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(5000);

    const eventUrls = new Set();
    let previousCount = 0;
    let scrollAttempts = 0;
    const maxScrolls = 15;

    while (scrollAttempts < maxScrolls) {
      const urls = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href;
          if (
            (href.includes('/events/') && href.match(/\/events\/[^\/]+\.\d+\/?/)) ||
            (href.includes('/broadway_tickets/') && href.match(/\/broadway_tickets\/[^\/]+\.\d+\/?/)) ||
            (href.includes('/concert_tickets/') && href.match(/\/concert_tickets\/[^\/]+\.\d+\/?/)) ||
            (href.includes('/sport_tickets/') && href.match(/\/sport_tickets\/[^\/]+\.\d+\/?/)) ||
            // /movies/title/ excluded — showtimes, not real events
            (href.includes('/guided_tours/') && href.match(/\/guided_tours\/[^\/]+\.\d+\/?/)) ||
            (href.includes('/arts__attractions/') && href.match(/\/arts__attractions\/[^\/]+\.\d+\/?/))
          ) {
            links.push(href.split('?')[0].split('#')[0]);
          }
        });
        return [...new Set(links)];
      });

      urls.forEach(url => eventUrls.add(url));

      if (eventUrls.size === previousCount) {
        if (scrollAttempts >= 3) break;
      } else {
        log(`   Found ${eventUrls.size} unique event URLs so far...`);
      }

      previousCount = eventUrls.size;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1000);

      try {
        const loadMoreBtn = await page.$('button:text("Load More"), button:text("Show More"), a:text("Next"), button:text("See More")');
        if (loadMoreBtn) {
          log('   🔘 Clicking "Load More" button...');
          await loadMoreBtn.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) { /* no load more button */ }

      scrollAttempts++;
    }

    log(`✅ Collected ${eventUrls.size} event URLs from category`);
    return Array.from(eventUrls);
  } catch (error) {
    logError(`Failed to collect event URLs from ${categoryUrl}`, error);
    return [];
  }
}

async function collectAllEventUrls(page, context) {
  try {
    log(`\n${'='.repeat(70)}`);
    log('PHASE 1: DISCOVERING CATEGORIES');
    log(`${'='.repeat(70)}\n`);

    const categories = await discoverCategories(page);

    log(`\n${'='.repeat(70)}`);
    log(`PHASE 2: COLLECTING EVENT URLS FROM ${categories.length} CATEGORIES`);
    log(`${'='.repeat(70)}\n`);

    const allEventUrls = new Set();
    const CONCURRENCY = 2;

    for (let i = 0; i < categories.length; i += CONCURRENCY) {
      const batch = categories.slice(i, i + CONCURRENCY);
      log(`\n📦 Processing category batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(categories.length / CONCURRENCY)}`);

      const batchPromises = batch.map(async (categoryUrl) => {
        let categoryPage;
        try {
          categoryPage = await context.newPage();
          return await collectEventUrlsFromCategory(categoryPage, categoryUrl);
        } catch (error) {
          logError(`Failed to process category ${categoryUrl}`, error);
          return [];
        } finally {
          if (categoryPage) {
            try { await categoryPage.close(); } catch (e) { /* page already closed */ }
          }
        }
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.flat().forEach(url => allEventUrls.add(url));
      log(`📊 Total unique events so far: ${allEventUrls.size}`);
    }

    log(`\n✅ Discovered ${allEventUrls.size} total unique event URLs across all categories`);
    return Array.from(allEventUrls);
  } catch (error) {
    logError('Failed to discover events', error);
    return [];
  }
}

// ============================================================================
// PARALLEL EVENT EXTRACTION (Supabase upsert instead of file save)
// ============================================================================

async function extractEventsInParallel(context, eventUrls, runId) {
  log(`\n${'='.repeat(70)}`);
  log('PHASE 3: EXTRACTING EVENT DETAILS WITH ENRICHMENT (PARALLEL)');
  log(`${'='.repeat(70)}\n`);

  const CONCURRENCY    = 3;
  const ENABLE_ENRICHMENT = process.env.ENABLE_ENRICHMENT !== 'false';

  if (ENABLE_ENRICHMENT && openai) {
    log('✨ Enrichment pipeline ENABLED - events will be enhanced with AI');
  } else if (!openai) {
    log('⚠️  Enrichment DISABLED - OpenAI API key not configured');
  } else {
    log('⚠️  Enrichment DISABLED by configuration');
  }

  let completed = 0;
  let newCount = 0;
  let updatedCount = 0;
  const errors = [];

  for (let i = 0; i < eventUrls.length; i += CONCURRENCY) {
    const batch = eventUrls.slice(i, i + CONCURRENCY);
    const batchNum   = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(eventUrls.length / CONCURRENCY);

    log(`\n📦 Processing batch ${batchNum}/${totalBatches} (events ${i + 1}-${Math.min(i + CONCURRENCY, eventUrls.length)})`);

    const batchPromises = batch.map(async (url, idx) => {
      let eventPage;
      try {
        eventPage = await context.newPage();
        const globalIdx = i + idx + 1;
        log(`   [${globalIdx}/${eventUrls.length}] Starting: ${url}`);

        let event = await extractEventDetails(eventPage, url);

        if (event && ENABLE_ENRICHMENT && openai) {
          log(`   [${globalIdx}/${eventUrls.length}] 🔬 Enriching...`);
          event = await enrichEvent(event);
        }

        if (event) {
          log(`   [${globalIdx}/${eventUrls.length}] ✅ ${event.title || 'Untitled'}`);
          return event;
        } else {
          log(`   [${globalIdx}/${eventUrls.length}] ⚠️  Failed to extract`);
          return null;
        }
      } catch (error) {
        logError(`   [${i + idx + 1}/${eventUrls.length}] ❌ Error`, error);
        errors.push(error.message);
        return null;
      } finally {
        if (eventPage) {
          try { await eventPage.close(); } catch (e) { /* page already closed */ }
        }
      }
    });

    const batchResults = await Promise.all(batchPromises);

    for (const event of batchResults) {
      if (event) {
        const { status } = await upsertEvent(event);
        completed++;
        if (status === 'new') newCount++;
        else if (status === 'updated') updatedCount++;
        else if (status !== 'duplicate') errors.push(`Upsert error for: ${event.title}`);
      }
    }

    log(`📊 Progress: ${completed}/${eventUrls.length} events processed`);

    if (i + CONCURRENCY < eventUrls.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return { completed, newCount, updatedCount, errors };
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

export async function crawl() {
  const startTime = Date.now();
  log('🚀 Starting NYC.com Events Crawler...');
  log(`⚙️  Extraction Mode: ${USE_LLM_EXTRACTION ? 'LLM (AI-powered)' : 'DETERMINISTIC (pattern-based)'}`);

  const runId = await startCrawlRun('nyccom');

  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false', // set PLAYWRIGHT_HEADLESS=false locally to debug Cloudflare
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport:   { width: 1920, height: 1080 },
    locale:     'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    const allEventUrls = await collectAllEventUrls(page, context);

    if (allEventUrls.length === 0) {
      log('⚠️  No events found! The site may have changed structure or is blocking us.');
      await finishCrawlRun(runId, { sourceName: 'nyccom', eventsFound: 0, eventsNew: 0, eventsUpdated: 0, errors: ['No events found'] });
      return;
    }

    log(`\n📊 Total unique events found: ${allEventUrls.length}\n`);

    const TEST_MODE = process.env.TEST_MODE === 'true';
    const eventsToProcess = TEST_MODE ? allEventUrls.slice(0, 10) : allEventUrls;

    if (TEST_MODE) {
      log(`⚠️  TEST MODE: Processing only ${eventsToProcess.length} events\n`);
    }

    const { completed, newCount, updatedCount, errors } = await extractEventsInParallel(context, eventsToProcess, runId);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    log(`\n${'='.repeat(70)}`);
    log('🎉 CRAWL COMPLETE!');
    log(`${'='.repeat(70)}`);
    log(`✅ Successfully processed ${completed} events`);
    log(`⏱️  Total time: ${duration} minutes`);
    log(`${'='.repeat(70)}\n`);

    await finishCrawlRun(runId, {
      sourceName:    'nyccom',
      eventsFound:   completed,
      eventsNew:     newCount,
      eventsUpdated: updatedCount,
      errors,
    });
  } catch (error) {
    logError('Crawler failed', error);
    await finishCrawlRun(runId, {
      sourceName:    'nyccom',
      eventsFound:   0,
      eventsNew:     0,
      eventsUpdated: 0,
      errors:        [error.message],
    });
    throw error;
  } finally {
    await browser.close();
  }
}
