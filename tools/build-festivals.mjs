// Wikidata（CC0）の祭りから data/festivals.json を作る
//   node tools/build-festivals.mjs            キャッシュ（tools/.cache）があれば再利用
//   node tools/build-festivals.mjs --refresh  問い合わせ直す
// 日本：P31/P279* Q132241（祭り）かつ P17=Q17。座標は P625 → 会場 P276 → 関連（P361）→ 所在地 P131（都道府県より細かいもの）の順。
//       開催月は P837（定期的に起こる日）の値から。取れなければ月なし（座標だけ。季節の判子にしない）
// 世界：日本以外の祭りで、座標 P625 と P837 があるもの
// 上乗せ：tools/festival-extra.mjs（ユネスコ「山・鉾・屋台行事」33件・日本三大祭）。名前・座標・月は手で確かめた値で上書き
// 出力：data/festivals.json  { generatedAt, shape, items: [[id, name, lat, lng, months, country, pref, flags, en]] }
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UNESCO, SANDAI, DROP } from './festival-extra.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'tools', '.cache');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const HEADERS = {
  'User-Agent': 'tabigoyomi-build-festivals/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)',
  Accept: 'application/sparql-results+json',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
};
const refresh = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREF_ISO = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
// Wikidata で都道府県が取れない祭りを座標から補う（国土地理院の逆ジオコーダ。tools/build-spots.mjs と同じキャッシュ tools/.cache/gsi-pref.json）
const GSI_FILE = path.join(CACHE, 'gsi-pref.json');
async function gsiPref(id, lat, lng, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
  let p = '';
  try {
    const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    if (res.ok) { const code = Number(((await res.json()).results || {}).muniCd?.slice(0, 2)) || 0; if (code >= 1 && code <= 47) p = PREF_ISO[code - 1]; }
  } catch { /* 取れなければ空 */ }
  cache[id] = p;
  await writeFile(GSI_FILE, JSON.stringify(cache));
  await sleep(250);
  return p;
}
const qidOf = (u) => u.value.split('/').pop();
function parsePoint(v) { const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(v || ''); return m ? { lat: Number(m[2]), lng: Number(m[1]) } : null; }

async function sparql(query, name) {
  const file = path.join(CACHE, `${name}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(10000 * i);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: HEADERS, body: 'query=' + encodeURIComponent(query) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const rows = (await res.json()).results.bindings;
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, JSON.stringify(rows));
      return rows;
    } catch (err) { console.log(`${name}: 失敗 ${err.message}（再試行）`); }
  }
  throw new Error(`${name}: 取得できませんでした`);
}

const JP = '?s wdt:P31/wdt:P279* wd:Q132241 ; wdt:P17 wd:Q17 .';
const WORLD = '?s wdt:P31/wdt:P279* wd:Q132241 ; wdt:P625 ?wc ; wdt:P837 [] ; wdt:P17 ?cn . FILTER NOT EXISTS { ?s wdt:P17 wd:Q17 }';
const LABELS = 'OPTIONAL { ?s rdfs:label ?ja FILTER(LANG(?ja) = "ja") } OPTIONAL { ?s rdfs:label ?en FILTER(LANG(?en) = "en") }';

// P837 の値（「8月15日」「7月」「8月の第1土曜日」のような項目）から月を取る。旧暦・季節だけ・年を指すものは月にしない
function monthOfDayItem(ja, en) {
  if (/旧暦|Chinese|lunar/i.test((ja || '') + (en || ''))) return null;
  if (ja === '春分' || ja === '春分の日') return 3;
  if (ja === '秋分' || ja === '秋分の日') return 9;
  const m = /(\d{1,2})月/.exec(ja || '');
  if (m && /^(\d{1,2}月|\d{1,2}月\d{1,2}日|\d{1,2}月の)/.test(ja)) return Number(m[1]);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const e = /^(?:(?:first|second|third|fourth|last) \w+ in )?(January|February|March|April|May|June|July|August|September|October|November|December)\b/.exec(en || '');
  return e ? names.indexOf(e[1]) + 1 : null;
}

async function main() {
  // --- 日本 ---
  const base = await sparql(`SELECT ?s ?ja ?en ?c WHERE { ${JP} ${LABELS} OPTIONAL { ?s wdt:P625 ?c } }`, 'fest-jp-base');
  const venue = await sparql(`SELECT ?s ?c WHERE { ${JP} ?s wdt:P276 ?v . ?v wdt:P625 ?c }`, 'fest-jp-venue');
  const part = await sparql(`SELECT ?s ?c WHERE { ${JP} ?s wdt:P361 ?v . FILTER(?v != wd:Q28686576) ?v wdt:P625 ?c }`, 'fest-jp-part');
  const loc = await sparql(`SELECT ?s ?c WHERE { ${JP} ?s wdt:P131 ?v . ?v wdt:P625 ?c ; wdt:P131 ?pp . ?pp wdt:P31 wd:Q50337 }`, 'fest-jp-loc');
  // 都道府県は、条件の重い問い合わせでタイムアウトしないよう、取れた id を VALUES で渡して引く
  const jpIds = [...new Set(base.map((r) => qidOf(r.s)))];
  const pref = [];
  for (let i = 0; i < jpIds.length; i += 300) {
    pref.push(...await sparql(`SELECT ?s ?pl WHERE { VALUES ?s { ${jpIds.slice(i, i + 300).map((q) => 'wd:' + q).join(' ')} }
      ?s wdt:P131+ ?p . ?p wdt:P31 wd:Q50337 ; rdfs:label ?pl FILTER(LANG(?pl) = "ja") }`, `fest-jp-pref-${i}`));
  }
  const dayJp = await sparql(`SELECT ?s ?v WHERE { ${JP} ?s wdt:P837 ?v }`, 'fest-jp-day');
  // --- 世界 ---
  const worldRows = await sparql(`SELECT ?s ?ja ?en ?wc ?cn ?cja ?cen WHERE { ${WORLD} ${LABELS}
    OPTIONAL { ?cn rdfs:label ?cja FILTER(LANG(?cja) = "ja") } OPTIONAL { ?cn rdfs:label ?cen FILTER(LANG(?cen) = "en") } }`, 'fest-world');
  const dayWorld = await sparql(`SELECT ?s ?v WHERE { ${WORLD} ?s wdt:P837 ?v }`, 'fest-world-day');
  // P837 の値の名前
  const dayIds = [...new Set([...dayJp, ...dayWorld].map((r) => qidOf(r.v)))].filter((q) => /^Q\d+$/.test(q));
  const dayMonth = new Map();
  for (let i = 0; i < dayIds.length; i += 200) {
    const chunk = dayIds.slice(i, i + 200);
    const rows = await sparql(`SELECT ?v ?ja ?en WHERE { VALUES ?v { ${chunk.map((q) => 'wd:' + q).join(' ')} }
      OPTIONAL { ?v rdfs:label ?ja FILTER(LANG(?ja) = "ja") } OPTIONAL { ?v rdfs:label ?en FILTER(LANG(?en) = "en") } }`, `fest-day-${i}`);
    for (const r of rows) dayMonth.set(qidOf(r.v), monthOfDayItem(r.ja && r.ja.value, r.en && r.en.value));
  }

  const items = new Map(); // id → { id, ja, en, lat, lng, src, months:Set, country, pref, flags:Set }
  const get = (id) => { if (!items.has(id)) items.set(id, { id, ja: '', en: '', lat: null, lng: null, src: 0, months: new Set(), country: '日本', pref: '', flags: new Set() }); return items.get(id); };
  const setCoord = (it, p, rank) => { if (p && (it.src === 0 || rank < it.src)) { it.lat = p.lat; it.lng = p.lng; it.src = rank; } };
  for (const r of base) {
    const it = get(qidOf(r.s));
    if (r.ja && !it.ja) it.ja = r.ja.value;
    if (r.en && !it.en) it.en = r.en.value;
    if (r.c) setCoord(it, parsePoint(r.c.value), 1);
  }
  for (const [rows, rank] of [[venue, 2], [part, 3], [loc, 4]]) for (const r of rows) setCoord(get(qidOf(r.s)), parsePoint(r.c.value), rank);
  for (const r of pref) { const it = get(qidOf(r.s)); if (!it.pref) it.pref = r.pl.value; }
  for (const r of dayJp) { const m = dayMonth.get(qidOf(r.v)); if (m) get(qidOf(r.s)).months.add(m); }
  const rankCount = [0, 0, 0, 0, 0];
  const stats = { jpTotal: items.size };

  // 世界
  const worldIds = new Set();
  for (const r of worldRows) {
    const id = qidOf(r.s);
    if (items.has(id) && items.get(id).country === '日本') continue;
    worldIds.add(id);
    const it = get(id);
    if (r.ja && !it.ja) it.ja = r.ja.value;
    if (r.en && !it.en) it.en = r.en.value;
    it.country = (r.cja && r.cja.value) || (r.cen && r.cen.value) || '';
    if (r.wc) setCoord(it, parsePoint(r.wc.value), 1);
  }
  for (const r of dayWorld) { const m = dayMonth.get(qidOf(r.v)); if (m && worldIds.has(qidOf(r.s))) get(qidOf(r.s)).months.add(m); }

  // 上乗せ：ユネスコ「山・鉾・屋台行事」と日本三大祭（手で確かめた名前・座標・月で上書き）
  for (const q of DROP) items.delete(q);
  const overlay = (e, flag) => {
    const id = e.qid || `u_${e.key}`;
    const it = get(id);
    it.ja = e.name; it.lat = e.lat; it.lng = e.lng; it.src = 1; it.months = new Set(e.months); it.pref = e.pref || it.pref; it.country = '日本';
    it.flags.add(flag);
  };
  for (const e of UNESCO) overlay(e, 'yama');
  for (const e of SANDAI) overlay(e, 'sandai');

  let gsi = {};
  try { gsi = JSON.parse(await readFile(GSI_FILE, 'utf8')); } catch { /* なければ空 */ }
  for (const it of items.values()) if (it.country === '日本' && !it.pref && it.lat !== null) it.pref = await gsiPref(it.id, it.lat, it.lng, gsi);
  const out = [];
  for (const it of items.values()) {
    if (it.country !== '日本' && /古代|帝国$/.test(it.country)) continue; // 歴史上の国の祭り（古代ローマなど）は外す
    if (it.lat === null) continue;
    const name = it.ja || it.en;
    if (!name) continue;
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lng)) continue;
    // 開催月が4つを超えるものは「いつの祭りか」が定まらないので月なしにする
    const months = it.months.size && it.months.size <= 4 ? [...it.months].sort((a, b) => a - b) : [];
    rankCount[it.src]++;
    out.push([it.id, name, Math.round(it.lat * 1e5) / 1e5, Math.round(it.lng * 1e5) / 1e5, months, it.country, it.pref, [...it.flags], it.ja ? '' : it.en]);
  }
  out.sort((a, b) => (a[7].length === b[7].length ? a[0].localeCompare(b[0], 'en', { numeric: true }) : b[7].length - a[7].length));
  await writeFile(path.join(root, 'data', 'festivals.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), source: 'Wikidata (CC0)', shape: '[id, name, lat, lng, months, country, pref, flags, en]', items: out,
  }));
  const jp = out.filter((r) => r[5] === '日本');
  const wd = out.filter((r) => r[5] !== '日本');
  console.log(`日本の祭り（Wikidata）${stats.jpTotal} 件 → 座標あり ${jp.length}（開催月あり ${jp.filter((r) => r[4].length).length}）`);
  console.log(`  座標の出どころ：P625 ${rankCount[1]}・会場 ${rankCount[2]}・関連 ${rankCount[3]}・所在地 ${rankCount[4]}`);
  console.log(`ユネスコ山・鉾・屋台行事 ${jp.filter((r) => r[7].includes('yama')).length} / ${UNESCO.length}、日本三大祭 ${jp.filter((r) => r[7].includes('sandai')).length}`);
  console.log(`世界の祭り ${wd.length}（${new Set(wd.map((r) => r[5])).size} か国）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
