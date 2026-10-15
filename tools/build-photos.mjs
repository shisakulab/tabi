// 名所の写真：Wikidata の P18（画像）→ Wikimedia Commons の API で、サムネイル（幅640px）の URL・作者・ライセンスを取って data/photos/ に置く
//   node tools/build-photos.mjs            キャッシュがあれば再利用する
//   node tools/build-photos.mjs --refresh  取り直す
// 対象：data/lists.json にある Wikidata の場所（Q から始まる id）。写真そのものはリポジトリに置かず、アプリが Commons のサムネイルを読み込む
// 出力：data/photos/<0〜15>.json（id の数字 % 16 で分ける。1つのカードを開くときに1つだけ読む）
//   { "<Q の id>": ["<サムネイルのパス（upload.wikimedia.org/wikipedia/commons/ より後ろ）>", "<作者>", "<ライセンス名>", "<短い説明>"] }
//   写真が無い場所は最初の3つが空文字。説明は Wikidata の description（日本語、無ければ英語。CC0）。写真も説明も無い場所は入れない
//   Commons のファイルのページは、パスの 'thumb/a/ab/<ファイル名>/…' のファイル名から https://commons.wikimedia.org/wiki/File:<ファイル名> で作る
// 写真は jpeg / png だけ（svg・tif・pdf などは除く）
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadNamesJa, jaName, jaDesc } from './names-ja.mjs';
const NAMES_JA = loadNamesJa();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'tools', '.cache', 'photos');
const OUT = path.join(root, 'data', 'photos');
const UA = 'tabigoyomi-build-photos/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)';
const refresh = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFIX = 'https://upload.wikimedia.org/wikipedia/commons/';
export const SHARDS = 16;
export const shardOf = (qid) => Number(String(qid).slice(1)) % SHARDS;

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

const plain = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

async function main() {
  const lists = JSON.parse(await readFile(path.join(root, 'data', 'lists.json'), 'utf8')).lists;
  const ids = [...new Set(lists.flatMap((l) => l.items.map((i) => i[0])).filter((id) => /^Q\d+$/.test(id)))];
  console.log(`Wikidata の場所: ${ids.length} 件`);

  // 1. P18（最初の1枚。優先ランクがあればそれ）
  const p18 = {};
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await cached(`p18-${i}`, async () => {
      const q = `SELECT ?s ?img ?rank WHERE { VALUES ?s { ${chunk.map((x) => 'wd:' + x).join(' ')} } ?s p:P18 ?st . ?st ps:P18 ?img ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) }`;
      const j = await getJson('https://query.wikidata.org/sparql', { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'query=' + encodeURIComponent(q) });
      await sleep(1500);
      return j.results.bindings.map((r) => [r.s.value.split('/').pop(), r.img.value, r.rank.value.endsWith('PreferredRank') ? 1 : 0]);
    });
    for (const [id, img, pref] of rows) if (!p18[id] || (pref && !p18[id].pref)) p18[id] = { img, pref };
  }
  const fileOf = (url) => decodeURIComponent(url.split('/Special:FilePath/').pop()).replace(/_/g, ' ');
  const files = [...new Set(Object.values(p18).map((v) => fileOf(v.img)))].filter((f) => /\.(jpe?g|png)$/i.test(f));
  console.log(`P18 のある場所: ${Object.keys(p18).length} 件、画像ファイル ${files.length} 枚`);

  // 1b. 説明文（日本語、無ければ英語）
  const desc = {};
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await cached(`desc-${i}`, async () => {
      const q = `SELECT ?s ?l ?d WHERE { VALUES ?s { ${chunk.map((x) => 'wd:' + x).join(' ')} } ?s schema:description ?d . BIND(LANG(?d) AS ?l) FILTER(?l IN ("ja", "en")) }`;
      const j = await getJson('https://query.wikidata.org/sparql', { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'query=' + encodeURIComponent(q) });
      await sleep(1500);
      return j.results.bindings.map((r) => [r.s.value.split('/').pop(), r.l.value, r.d.value]);
    });
    for (const [id, l, d] of rows) { const cur = desc[id] || {}; cur[l] = d; desc[id] = cur; }
  }

  // 2. Commons API（50枚ずつ）：サムネイル・作者・ライセンス
  const info = {};
  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    const pages = await cached(`commons-${i}`, async () => {
      const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|mime|extmetadata&iiextmetadatafilter=Artist|LicenseShortName&iiurlwidth=640&redirects=1&titles='
        + encodeURIComponent(chunk.map((f) => 'File:' + f).join('|'));
      const j = await getJson(url, { headers: { 'User-Agent': UA } });
      await sleep(1000);
      const redirects = Object.fromEntries((j.query.redirects || []).map((r) => [r.from, r.to]));
      return { redirects, pages: (j.query.pages || []).filter((p) => p.imageinfo).map((p) => ({ title: p.title, ii: p.imageinfo[0] })) };
    });
    const byTitle = new Map(pages.pages.map((p) => [p.title, p.ii]));
    for (const f of chunk) {
      const t = 'File:' + f;
      const ii = byTitle.get(pages.redirects[t] || t);
      if (ii) info[f] = ii;
    }
    if ((i / 50) % 20 === 0) console.log(`Commons ${Math.min(i + 50, files.length)} / ${files.length}`);
  }

  // 3. 出力
  const shards = Array.from({ length: SHARDS }, () => ({}));
  let n = 0; let noLicense = 0;
  let nd = 0;
  for (const id of ids) {
    let entry = ['', '', ''];
    const v = p18[id];
    const ii = v && info[fileOf(v.img)];
    // サムネイルの URL：API は thumb.wikimedia.org で、?utm_ 付きで返す。upload.wikimedia.org・パラメータなしに直す
    // （幅は 640 をそのまま頼むと 960px に丸められる。いまの Commons は決まった幅（500・960 など）だけ受け付けるので、640 に近い 500 にする。元の画像が 960 より大きいときだけ thumb の URL になるので、500 も必ずある）
    if (ii && ii.thumburl) ii.thumburl = ii.thumburl.replace('https://thumb.wikimedia.org/', 'https://upload.wikimedia.org/').split('?')[0].replace('/960px-', '/500px-');
    if (ii && ['image/jpeg', 'image/png'].includes(ii.mime) && ii.thumburl && ii.thumburl.startsWith(PREFIX)) {
      const em = ii.extmetadata || {};
      const license = plain((em.LicenseShortName || {}).value);
      if (!license) noLicense++; // ライセンスが分からない写真は出さない
      else { entry = [ii.thumburl.slice(PREFIX.length), plain((em.Artist || {}).value).slice(0, 80), license]; n++; }
    }
    const dd = desc[id] || {};
    const text = jaDesc(NAMES_JA, (dd.ja || dd.en || '').trim().slice(0, 80)); // 英語の説明は tools/names-ja.json の訳に置き換える
    if (text) nd++;
    if (!entry[0] && !text) continue;
    shards[shardOf(id)][id] = [...entry, text];
  }
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (let k = 0; k < SHARDS; k++) await writeFile(path.join(OUT, `${k}.json`), JSON.stringify(shards[k]));
  console.log(`写真つき ${n} 件、説明つき ${nd} 件（ライセンス不明で除外 ${noLicense} 件）`);
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exit(1); });
