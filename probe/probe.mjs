// Temporary: fetches probe/urls.txt from a GitHub runner so a cloud session can read venue sites.
import fs from 'node:fs';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const urls = fs.readFileSync('probe/urls.txt', 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
fs.rmSync('probe/out', { recursive: true, force: true });
fs.mkdirSync('probe/out', { recursive: true });
const index = [];
await Promise.all(urls.map(async (line, i) => {
  const manual = line.startsWith('manual ');
  const url = line.replace(/^manual /, '');
  const entry = { i, url, manual };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: '*/*' }, signal: AbortSignal.timeout(30000), redirect: manual ? 'manual' : 'follow' });
    const body = await res.text();
    Object.assign(entry, { status: res.status, finalUrl: res.url, type: res.headers.get('content-type'), cf: res.headers.get('cf-mitigated'), server: res.headers.get('server'), location: res.headers.get('location'), cookie: res.headers.get('set-cookie'), size: body.length });
    fs.writeFileSync(`probe/out/${i}.txt`, body.slice(0, 1_500_000));
  } catch (e) { entry.error = String(e.cause ?? e.message); }
  index.push(entry);
}));
index.sort((a, b) => a.i - b.i);
fs.writeFileSync('probe/out/index.json', JSON.stringify(index, null, 2));
console.log(JSON.stringify(index, null, 2));
