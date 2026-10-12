// Wikidata（SPARQL）から場所のデータを作る
//   node tools/build-spots.mjs            キャッシュがあれば再利用する
//   node tools/build-spots.mjs --refresh  問い合わせ直す
// 出力：data/spots/<0.5度区画>.json、data/spots/meta.json、data/lists.json、data/seasons-coords.json
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { tileKey } from '../logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'tools', '.cache');
const OUT = path.join(root, 'data');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const HEADERS = {
  'User-Agent': 'tabigoyomi-build-spots/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)',
  Accept: 'application/sparql-results+json',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
};
const refresh = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一覧の定義。cond は ?s の絞り込み
const LISTS = [
  { key: 'heritage', name: '世界遺産', note: '日本の世界遺産の構成資産', tier: 'far', radius: 500, cond: '?s wdt:P757 [] ; wdt:P17 wd:Q17 .' },
  { key: 'meisui', name: '名水百選', note: '環境省選定', tier: 'day', radius: 50, cond: '?s wdt:P361 wd:Q10917783 .' },
  { key: 'judenken', name: '重伝建', note: '重要伝統的建造物群保存地区', tier: 'far', radius: 300, cond: '?s wdt:P1435 wd:Q850649 .' },
];
const TIER_RANK = { town: 0, day: 1, far: 2 };

async function sparql(query, name) {
  const file = path.join(CACHE, `${name}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  for (let i = 0; i < 4; i++) {
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

const qidOf = (uri) => uri.value.split('/').pop();
function parsePoint(v) {
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(v || '');
  return m ? { lat: Number(m[2]), lng: Number(m[1]) } : null;
}

// 1つの一覧を取る：[{ id, name, lat, lng, pref }]（id 重複は1つに）
async function fetchList(list) {
  const base = await sparql(`SELECT ?s ?l ?c WHERE { ${list.cond}
    OPTIONAL { ?s wdt:P625 ?c }
    OPTIONAL { ?s rdfs:label ?l FILTER(LANG(?l) = "ja") } }`, `${list.key}-base`);
  const prefRows = await sparql(`SELECT ?s ?pl WHERE { ${list.cond}
    ?s wdt:P131+ ?p . ?p wdt:P31 wd:Q50337 . ?p rdfs:label ?pl FILTER(LANG(?pl) = "ja") }`, `${list.key}-pref`);
  const prefOf = new Map();
  for (const r of prefRows) { const id = qidOf(r.s); if (!prefOf.has(id)) prefOf.set(id, r.pl.value); }
  const items = new Map();
  for (const r of base) {
    const id = qidOf(r.s);
    const it = items.get(id) || { id, name: '', lat: null, lng: null, pref: prefOf.get(id) || '' };
    if (r.l && !it.name) it.name = r.l.value;
    const p = r.c && parsePoint(r.c.value);
    if (p && it.lat === null) { it.lat = p.lat; it.lng = p.lng; }
    items.set(id, it);
  }
  return [...items.values()].filter((it) => it.name) // 日本語の名前がないものは載せない
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

// 季節の名所の座標：名前で wbsearchentities（日本語）→ 候補の座標と都道府県を SPARQL で調べ、都道府県が合う最初の候補を使う。
// 合うものがなければ入れない（推測しない）。結果は data/seasons-coords.json（key → { lat, lng, qid }）
async function searchIds(name) {
  const file = path.join(CACHE, `search-${encodeURIComponent(name)}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const terms = [...new Set([name, name.replace(/[（(].*$/, '').trim(), name.split(/[ 　]/).pop()])].filter(Boolean);
  const ids = [];
  for (const t of terms) {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=ja&uselang=ja&limit=8&search=${encodeURIComponent(t)}`;
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
      if (res.ok) { for (const r of (await res.json()).search || []) if (!ids.includes(r.id)) ids.push(r.id); break; }
      await sleep(3000 * (i + 1));
    }
    await sleep(300);
  }
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(ids));
  return ids;
}

async function fetchSeasonCoords() {
  const { default: seasons } = await import(pathToFileURL(path.join(root, 'themes', 'seasons.js')).href);
  const out = {};
  const missing = [];
  const byName = new Map(); // name → { pref, ids, found }
  for (const s of seasons) {
    if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) continue;
    if (!byName.has(s.name + '|' + s.pref)) byName.set(s.name + '|' + s.pref, { name: s.name, pref: s.pref, qid: s.qid || null });
  }
  const entries = [...byName.values()];
  for (const e of entries) e.ids = e.qid ? [e.qid] : await searchIds(e.name);
  const allIds = [...new Set(entries.flatMap((e) => e.ids))];
  const info = new Map(); // qid → { p: {lat,lng}, prefs: Set }
  for (let i = 0; i < allIds.length; i += 60) {
    const chunk = allIds.slice(i, i + 60);
    const values = chunk.map((q) => 'wd:' + q).join(' ');
    const rows = await sparql(`SELECT ?s ?c ?pl WHERE { VALUES ?s { ${values} } ?s wdt:P625 ?c .
      OPTIONAL { ?s wdt:P131* ?p . ?p wdt:P31 wd:Q50337 . ?p rdfs:label ?pl FILTER(LANG(?pl) = "ja") } }`, `seasons-info-${i}`);
    for (const r of rows) {
      const id = qidOf(r.s);
      const cur = info.get(id) || { p: parsePoint(r.c.value), prefs: new Set() };
      if (r.pl) cur.prefs.add(r.pl.value);
      info.set(id, cur);
    }
  }
  const resolved = new Map();
  for (const e of entries) {
    const hit = e.ids.find((id) => info.has(id) && info.get(id).prefs.has(e.pref));
    resolved.set(e.name + '|' + e.pref, hit ? { ...info.get(hit).p, qid: hit } : null);
  }
  for (const s of seasons) {
    if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) continue;
    const r = resolved.get(s.name + '|' + s.pref);
    if (r) out[s.key] = r; else missing.push(`${s.name}（${s.pref}）${s.label}`);
  }
  await writeFile(path.join(OUT, 'seasons-coords.json'), JSON.stringify(out));
  return { total: seasons.length, got: Object.keys(out).length, missing };
}

async function main() {
  await mkdir(path.join(OUT, 'spots'), { recursive: true });
  const spots = new Map(); // id → [id, kind, name, lat, lng, tier, radius, lists, pref]
  const listsOut = [];
  const counts = {};
  for (const list of LISTS) {
    const items = await fetchList(list);
    counts[list.key] = { total: items.length, withCoord: items.filter((i) => i.lat !== null).length };
    console.log(`${list.name}: ${items.length} 件（座標あり ${counts[list.key].withCoord}）`);
    listsOut.push({ key: list.key, name: list.name, note: list.note, tier: list.tier, items: items.map((i) => [i.id, i.name, i.pref, i.lat !== null ? 1 : 0]) });
    for (const it of items) {
      if (it.lat === null) continue;
      const cur = spots.get(it.id);
      if (!cur) { spots.set(it.id, [it.id, list.key, it.name, it.lat, it.lng, list.tier, list.radius, [list.key], it.pref]); continue; }
      cur[7].push(list.key);
      if (TIER_RANK[list.tier] > TIER_RANK[cur[5]]) cur[5] = list.tier;
      cur[6] = Math.max(cur[6], list.radius);
      if (!cur[8]) cur[8] = it.pref;
    }
  }
  // 区画ごとに書く（古いファイルは消す）
  for (const f of await readdir(path.join(OUT, 'spots'))) await rm(path.join(OUT, 'spots', f));
  const tiles = new Map();
  for (const s of spots.values()) {
    const k = tileKey(s[3], s[4]);
    if (!tiles.has(k)) tiles.set(k, []);
    tiles.get(k).push(s);
  }
  for (const [k, list] of tiles) await writeFile(path.join(OUT, 'spots', `${k}.json`), JSON.stringify(list));
  await writeFile(path.join(OUT, 'spots', 'meta.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), source: 'Wikidata (CC0)', spots: spots.size, tiles: [...tiles.keys()].sort(), counts,
    shape: '[id, kind, name, lat, lng, tier, radius, lists, pref]',
  }));
  // lists.json：items は [id, 名前, 都道府県, 座標あり(1/0)]
  await writeFile(path.join(OUT, 'lists.json'), JSON.stringify({ lists: listsOut }));
  console.log(`地点 ${spots.size} 件、区画 ${tiles.size} 個`);
  const sc = await fetchSeasonCoords();
  console.log('季節の名所の座標: ' + sc.got + ' / ' + sc.total);
  if (sc.missing.length) console.log(['座標を取れなかった名所:', ...sc.missing].join('\n  '));
}
main().catch((e) => { console.error(e); process.exit(1); });
