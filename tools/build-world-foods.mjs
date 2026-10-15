// 日本以外の国のご当地（料理）：Wikidata（CC0）の「料理（Q746549）とその下位」で、原産国（P495）が国のものを、国ごとに
// Wikipedia の言語版の数（sitelinks）が多い順に上位 PER_COUNTRY 品まで取り、data/world-foods.json に置く。
//   node tools/build-world-foods.mjs            キャッシュ（tools/.cache/world-foods）があれば再利用する
//   node tools/build-world-foods.mjs --refresh  取り直す
// 名前は日本語のラベル、無ければ英語。説明は Wikidata の description（日本語、無ければ英語）。
// 写真：P18（Commons）→ Commons の API で幅500のサムネイル・作者・ライセンス（build-photos.mjs と同じ。ライセンスが分からない写真は出さない）。
// 国名は data/countries.geojson（Natural Earth の日本語名）にそろえる。そろわない国は COUNTRY_NAME で手当てする（出力しない国は最後に一覧）。
// 出力 data/world-foods.json: [{ key: 'w_Q123', name, country, desc, photo: [サムネイルのパス, 作者, ライセンス] | なし }]（日本は入れない。農水省の郷土料理があるので）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'tools', '.cache', 'world-foods');
const UA = 'tabigoyomi-build-world-foods/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)';
const refresh = process.argv.includes('--refresh');
const PER_COUNTRY = 10;
const MIN_SITELINKS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFIX = 'https://upload.wikimedia.org/wikipedia/commons/';
// Wikidata の日本語ラベル → Natural Earth の日本語名（app.js の COUNTRY_ALIAS と同じ考え）
const COUNTRY_NAME = {
  'スペイン王国': 'スペイン', 'ノルウェー王国': 'ノルウェー', 'パレスチナ国': 'パレスチナ', 'チェコ共和国': 'チェコ', 'ギニアビサウ共和国': 'ギニアビサウ',
  'ドイツ連邦共和国': 'ドイツ', 'フランス共和国': 'フランス', 'イタリア共和国': 'イタリア', 'ロシア連邦': 'ロシア', 'アメリカ': 'アメリカ合衆国', 'ベラルーシ共和国': 'ベラルーシ',
  '中国': '中華人民共和国', '朝鮮': '大韓民国', 'イングランド': 'イギリス', 'スコットランド': 'イギリス',
};

async function cached(name, fn) {
  const file = path.join(CACHE, name + '.json');
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const v = await fn();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(v));
  return v;
}
async function getJson(url, init, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(8000 * i);
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (e) { console.log('失敗', e.message, '再試行'); }
  }
  throw new Error('取得できませんでした: ' + url.slice(0, 100));
}
const sparql = (q) => getJson('https://query.wikidata.org/sparql', { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'query=' + encodeURIComponent(q) });
const plain = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const qidOf = (u) => u.split('/').pop();

async function main() {
  const geo = JSON.parse(await readFile(path.join(root, 'data', 'countries.geojson'), 'utf8'));
  const known = new Set(geo.features.map((f) => f.properties.n));

  // 1. 料理（Q746549 とその下位）× 原産国（国・主権国家のもの）× sitelinks
  const rows = await cached('dishes', async () => {
    const j = await sparql(`SELECT ?item ?c ?sl WHERE {
      ?item wdt:P31/wdt:P279* wd:Q746549 .
      ?item wdt:P495 ?c .
      ?item wikibase:sitelinks ?sl .
      FILTER(?sl >= ${MIN_SITELINKS})
    }`);
    return j.results.bindings.map((r) => [qidOf(r.item.value), qidOf(r.c.value), Number(r.sl.value)]);
  });
  console.log('料理×国', rows.length);

  // 2. ラベル・説明・P18（50件ずつ、wbgetentities）
  const ids = [...new Set(rows.flatMap((r) => [r[0], r[1]]))];
  const ent = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const part = await cached('ent-' + createHash('md5').update(chunk.join('|')).digest('hex').slice(0, 12), async () => {
      const j = await getJson('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions|claims&languages=ja|en&ids=' + chunk.join('|'), { headers: { 'User-Agent': UA } });
      await sleep(800);
      const out = {};
      for (const [id, e] of Object.entries(j.entities || {})) {
        const p18 = (e.claims && e.claims.P18 || []).filter((c) => c.rank !== 'deprecated' && c.mainsnak.datavalue);
        p18.sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'));
        out[id] = { ja: e.labels && e.labels.ja && e.labels.ja.value, en: e.labels && e.labels.en && e.labels.en.value, dja: e.descriptions && e.descriptions.ja && e.descriptions.ja.value, den: e.descriptions && e.descriptions.en && e.descriptions.en.value, img: p18.length ? p18[0].mainsnak.datavalue.value : '' };
      }
      return out;
    });
    Object.assign(ent, part);
  }

  // 3. 国ごとに上位。国名を Natural Earth の日本語名にそろえる
  const unmatched = new Map();
  const byCountry = new Map();
  for (const [item, c, sl] of rows) {
    const e = ent[c] || {};
    const raw = e.ja || '';
    const name = COUNTRY_NAME[raw] || raw;
    if (!known.has(name)) { unmatched.set(raw || e.en || c, (unmatched.get(raw || e.en || c) || 0) + 1); continue; }
    if (name === '日本') continue;
    if (!byCountry.has(name)) byCountry.set(name, new Map());
    const m = byCountry.get(name);
    if (!m.has(item) || m.get(item) < sl) m.set(item, sl);
  }
  const picked = []; // { item, country, sl }
  for (const [country, m] of byCountry) {
    for (const [item, sl] of [...m].sort((a, b) => b[1] - a[1]).slice(0, PER_COUNTRY)) {
      const e = ent[item] || {};
      if (!(e.ja || e.en)) continue;
      picked.push({ item, country, sl });
    }
  }
  console.log('国', byCountry.size, '料理', new Set(picked.map((p) => p.item)).size, '（国×料理', picked.length, '）');

  // 4. 写真（Commons API）
  const files = [...new Set(picked.map((p) => (ent[p.item] || {}).img).filter((f) => /\.(jpe?g|png)$/i.test(f || '')))];
  const info = {};
  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    const pages = await cached('commons-' + createHash('md5').update(chunk.join('|')).digest('hex').slice(0, 12), async () => {
      const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|mime|extmetadata&iiextmetadatafilter=Artist|LicenseShortName&iiurlwidth=500&redirects=1&titles='
        + encodeURIComponent(chunk.map((f) => 'File:' + f).join('|'));
      const j = await getJson(url, { headers: { 'User-Agent': UA } });
      await sleep(1000);
      const redirects = Object.fromEntries((j.query.redirects || []).map((r) => [r.from, r.to]));
      return { redirects, pages: (j.query.pages || []).filter((p) => p.imageinfo).map((p) => ({ title: p.title, ii: p.imageinfo[0] })) };
    });
    const byTitle = new Map(pages.pages.map((p) => [p.title, p.ii]));
    for (const f of chunk) { const t = 'File:' + f; const ii = byTitle.get(pages.redirects[t] || t); if (ii) info[f] = ii; }
  }

  // 5. 出力（料理は1つにまとめ、原産国が複数なら先頭の国で出す。国ごとの重複は国×料理で別の行にする）
  const out = [];
  let withPhoto = 0;
  for (const p of picked.sort((a, b) => (a.country < b.country ? -1 : a.country > b.country ? 1 : b.sl - a.sl))) {
    const e = ent[p.item];
    const f = e.img;
    const ii = f && info[f];
    let photo = null;
    if (ii && ['image/jpeg', 'image/png'].includes(ii.mime) && ii.thumburl) {
      const u = ii.thumburl.replace('https://thumb.wikimedia.org/', 'https://upload.wikimedia.org/').split('?')[0];
      const license = plain((ii.extmetadata.LicenseShortName || {}).value);
      if (license && u.startsWith(PREFIX)) { photo = [u.slice(PREFIX.length), plain((ii.extmetadata.Artist || {}).value).slice(0, 80), license]; withPhoto++; }
    }
    const row = { key: `w_${p.item}`, name: e.ja || e.en, country: p.country, desc: (e.dja || e.den || '').slice(0, 80) };
    if (!e.ja && e.en) row.en = true; // 日本語のラベルが無く英語
    if (photo) row.photo = photo;
    out.push(row);
  }
  // 同じ料理が複数の国に入る場合は key を国ごとに分ける（記録はどちらの国でも別々に付く）
  const seen = new Map();
  for (const r of out) { const n = (seen.get(r.key) || 0) + 1; seen.set(r.key, n); if (n > 1) r.key += `_${n}`; }
  await writeFile(path.join(root, 'data', 'world-foods.json'), JSON.stringify(out));
  console.log(`出力 ${out.length} 件、写真つき ${withPhoto} 件、日本語ラベル ${out.filter((r) => !r.en).length} 件`);
  console.log('国名がそろわず除いた:', [...unmatched].map(([k, n]) => `${k}(${n})`).join(' '));
}
main().catch((e) => { console.error(e); process.exit(1); });
