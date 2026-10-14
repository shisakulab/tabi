// data/lists.json の座標なし item に、できるだけ座標を見つけて足す
//   node tools/fill-coords.mjs
// 途中で止まっても、tools/out/fill-coords-cache.json に結果を残して続きから再開できる。
// 見つけた座標は data/lists.json と data/spots/<区画>.json・meta.json にも反映する。
// build-spots.mjs を後で回したときも同じ座標になるよう、このキャッシュ（found）を
// 「手作りの座標の上書き表」として build-spots.mjs 自身が読むようにしている（loadOverrides）。
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tileKey, distanceMeters } from '../logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS_FILE = path.join(root, 'data', 'lists.json');
const SPOTS_DIR = path.join(root, 'data', 'spots');
const META_FILE = path.join(SPOTS_DIR, 'meta.json');
const CACHE_FILE = path.join(root, 'tools', 'out', 'fill-coords-cache.json');
const UA = 'tabigoyomi-fill-coords/1.0 (https://github.com/shisakulab; personal project)';
const ENDPOINT = 'https://query.wikidata.org/sparql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一覧ごとの半径（build-spots.mjs の LISTS と同じ値）
const RADIUS = {
  heritage: 500, judenken: 300, meijo100: 300, zokumeijo: 300, meisui: 50, taki100: 150,
  kokuho: 150, ichinomiya: 150, meisho: 300, shiseki: 200, kanko: 300, michinoeki: 150,
};

async function loadCache() {
  try { return JSON.parse(await readFile(CACHE_FILE, 'utf8')); }
  catch { return { found: {}, failed: {}, defunct: {} }; }
}
async function saveCache(cache) {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 1));
}

async function sparqlQuery(query) {
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(8000 * i);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'query=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return (await res.json()).results.bindings;
    } catch (err) { console.log(`sparql失敗: ${err.message}（再試行）`); }
  }
  console.log('sparql: あきらめ');
  return [];
}
const qidOf = (uri) => uri.value.split('/').pop();
function parsePoint(v) {
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(v || '');
  return m ? { lat: Number(m[2]), lng: Number(m[1]) } : null;
}

// Nominatim は作業中に 429（混み合っている）が続き、間を置いても直らなかったので、
// 行儀よく諦めて使わない（これ以上たたくのは Nominatim の使い方ルールにも反する）。
// 代わりに 国土地理院の住所検索（日本の地名向け）と Wikidata のあいまい検索（wbsearchentities）を使う。
async function gsiSearch(q) {
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    try {
      const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } catch (err) { console.log(`gsi失敗(${q}): ${err.message}`); await sleep(3000 * (i + 1)); }
  }
  return [];
}
// Wikidata のあいまい検索（名前→候補 QID）。build-spots.mjs の searchIds と同じやり方
async function wbSearch(name, lang) {
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=${lang}&uselang=${lang}&limit=8&search=${encodeURIComponent(name)}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()).search || []).map((r) => r.id);
    } catch (err) { console.log(`wbsearch失敗(${name}): ${err.message}`); await sleep(3000 * (i + 1)); }
  }
  return [];
}

// Phase 1: Wikidata の P625 を直接見る（build 時点から増えているかもしれないので取り直す）
async function phaseWikidataDirect(items, cache) {
  const ids = [...new Set(items.map((m) => m.id))];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await sparqlQuery(`SELECT ?s ?c WHERE { VALUES ?s { ${chunk.map((q) => 'wd:' + q).join(' ')} } ?s wdt:P625 ?c . }`);
    for (const r of rows) {
      const id = qidOf(r.s); const p = r.c && parsePoint(r.c.value);
      if (p && !cache.found[id]) cache.found[id] = { lat: p.lat, lng: p.lng, method: 'wikidata-p625' };
    }
  }
  console.log(`Phase1 Wikidata P625: ${ids.filter((id) => cache.found[id]?.method === 'wikidata-p625').length} / ${ids.length}`);
}

// Phase 2: P527（has part）の子、逆向き P361（part of）の子の P625 の平均
async function phaseWikidataChildren(items, cache) {
  const ids = [...new Set(items.map((m) => m.id))];
  if (!ids.length) return;
  const childrenOf = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const values = chunk.map((q) => 'wd:' + q).join(' ');
    const rows = await sparqlQuery(`SELECT ?s ?child WHERE { VALUES ?s { ${values} } { ?s wdt:P527 ?child } UNION { ?child wdt:P361 ?s } }`);
    for (const r of rows) {
      const parent = qidOf(r.s); const child = qidOf(r.child);
      if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
      childrenOf.get(parent).add(child);
    }
  }
  const allChildIds = [...new Set([...childrenOf.values()].flatMap((s) => [...s]))];
  const childPoint = new Map();
  for (let i = 0; i < allChildIds.length; i += 300) {
    const chunk = allChildIds.slice(i, i + 300);
    const rows = await sparqlQuery(`SELECT ?s ?c WHERE { VALUES ?s { ${chunk.map((q) => 'wd:' + q).join(' ')} } ?s wdt:P625 ?c . }`);
    for (const r of rows) { const id = qidOf(r.s); const p = r.c && parsePoint(r.c.value); if (p) childPoint.set(id, p); }
  }
  let got = 0;
  for (const [parent, childSet] of childrenOf) {
    if (cache.found[parent]) continue;
    const pts = [...childSet].map((c) => childPoint.get(c)).filter(Boolean);
    if (!pts.length) continue;
    if (pts.length === 1) { cache.found[parent] = { lat: pts[0].lat, lng: pts[0].lng, method: 'wikidata-child' }; got++; continue; }
    let maxDist = 0;
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) maxDist = Math.max(maxDist, distanceMeters(pts[a], pts[b]));
    if (maxDist > 50000) continue; // 散らばりすぎる子は代表点に向かないので取らない
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    cache.found[parent] = { lat, lng, method: 'wikidata-children-avg' };
    got++;
  }
  console.log(`Phase2 Wikidata 子の平均: ${got} / ${ids.length}`);
}

// Phase 3: 日本の場所。国土地理院の住所検索（都道府県が合うものだけ）→ だめなら Wikidata のあいまい検索
// （候補 QID の P625・都道府県が合うものだけ採用。都道府県が分からない item は確認できないので入れない）
async function gsiLookup(m) {
  if (!m.pref) return null;
  const variants = [...new Set([m.name, m.name.replace(/(伝統的建造物群保存地区|地区)$/u, ''), m.name.replace(/^道の駅/u, '')])].filter(Boolean);
  for (const v of variants) {
    const results = await gsiSearch(v);
    const match = results.find((r) => (r.properties?.title || '').includes(m.pref));
    if (match) { const [lng, lat] = match.geometry.coordinates; return { lat, lng, method: 'gsi' }; }
  }
  return null;
}
async function wbLookupJapan(m) {
  if (!m.pref) return null;
  const ids = await wbSearch(m.name, 'ja');
  if (!ids.length) return null;
  const rows = await sparqlQuery(`SELECT ?s ?c ?pl WHERE { VALUES ?s { ${ids.map((q) => 'wd:' + q).join(' ')} } ?s wdt:P625 ?c .
    OPTIONAL { ?s wdt:P131* ?p . ?p wdt:P31 wd:Q50337 . ?p rdfs:label ?pl FILTER(LANG(?pl) = "ja") } }`);
  const info = new Map();
  for (const r of rows) {
    const id = qidOf(r.s); const cur = info.get(id) || { c: null, prefs: new Set() };
    const p = r.c && parsePoint(r.c.value); if (p) cur.c = p;
    if (r.pl) cur.prefs.add(r.pl.value);
    info.set(id, cur);
  }
  for (const id of ids) { const i = info.get(id); if (i && i.c && i.prefs.has(m.pref)) return { lat: i.c.lat, lng: i.c.lng, method: 'wikidata-search' }; }
  return null;
}
async function phaseJapanFallback(items, cache, persist) {
  let got = 0, tried = 0;
  for (const m of items) {
    if (cache.found[m.id] || cache.failed[m.id]) continue;
    tried++;
    const hit = await gsiLookup(m) || await wbLookupJapan(m);
    if (hit) { cache.found[m.id] = hit; got++; console.log(`  OK ${m.listKey} ${m.name}（${hit.method}）`); }
    else { cache.failed[m.id] = true; console.log(`  NG ${m.listKey} ${m.name}`); }
    if (tried % 10 === 0) await persist();
  }
  console.log(`Phase3 日本(GSI/Wikidata検索): ${got} / ${tried}`);
}

// Phase 4: 海外（世界遺産など）。Wikidata のあいまい検索（英語名→日本語名）の候補のうち、
// P625 があり国（P17）が合うものだけ採用。国が分からない item は確認できないので入れない
async function wbLookupGlobal(m) {
  if (!m.country) return null;
  const ids = [...new Set([...(await wbSearch(m.name, 'en')), ...(await wbSearch(m.name, 'ja'))])];
  if (!ids.length) return null;
  const rows = await sparqlQuery(`SELECT ?s ?c ?cl WHERE { VALUES ?s { ${ids.map((q) => 'wd:' + q).join(' ')} } ?s wdt:P625 ?c .
    OPTIONAL { ?s wdt:P17 ?co . ?co rdfs:label ?cl FILTER(LANG(?cl) = "ja") } }`);
  const info = new Map();
  for (const r of rows) {
    const id = qidOf(r.s); const cur = info.get(id) || { c: null, countries: new Set() };
    const p = r.c && parsePoint(r.c.value); if (p) cur.c = p;
    if (r.cl) cur.countries.add(r.cl.value);
    info.set(id, cur);
  }
  for (const id of ids) { const i = info.get(id); if (i && i.c && i.countries.has(m.country)) return { lat: i.c.lat, lng: i.c.lng, method: 'wikidata-search-global' }; }
  return null;
}
async function phaseGlobalFallback(items, cache, persist) {
  let got = 0, tried = 0;
  for (const m of items) {
    if (cache.found[m.id] || cache.failed[m.id]) continue;
    tried++;
    const hit = await wbLookupGlobal(m);
    if (hit) { cache.found[m.id] = hit; got++; console.log(`  OK ${m.listKey} ${m.name}`); }
    else { cache.failed[m.id] = true; console.log(`  NG ${m.listKey} ${m.name}`); }
    if (tried % 10 === 0) await persist();
  }
  console.log(`Phase4 海外(Wikidata検索): ${got} / ${tried}`);
}

// Phase 5: 解消できなかった item のうち、Wikidata で「廃止・終了・解体」日付を持つものは
// もう無い催し・アトラクションの可能性が高いので、無理に座標を入れず別枠で報告する
async function phaseDetectDefunct(items, cache) {
  const ids = [...new Set(items.filter((m) => !cache.found[m.id]).map((m) => m.id))];
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await sparqlQuery(`SELECT ?s WHERE { VALUES ?s { ${chunk.map((q) => 'wd:' + q).join(' ')} }
      { ?s wdt:P576 ?d } UNION { ?s wdt:P582 ?d } UNION { ?s wdt:P3999 ?d } }`);
    for (const r of rows) cache.defunct[qidOf(r.s)] = true;
  }
}

async function readTile(key) {
  const file = path.join(SPOTS_DIR, `${key}.json`);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, 'utf8'));
}

async function applyResults(listsData, missing, cache) {
  const report = new Map(); // listKey -> { before, got, methodCounts, examples, defunct: [] }
  for (const list of listsData.lists) report.set(list.key, { before: 0, got: 0, methods: {}, defunctExamples: [], failExamples: [] });

  // tile ごとに今回変える内容をまとめる
  const tileChanges = new Map(); // tileKey -> Map(id -> spotArray)
  const tileNewCount = new Map(); // tileKey -> 新規に増えた件数（merge は増えない）
  const listNewCoord = new Map(); // listKey -> 件数

  for (const m of missing) {
    const r = report.get(m.listKey);
    r.before++;
    const found = cache.found[m.id];
    const item = listsData.lists.find((l) => l.key === m.listKey).items[m.idx];
    if (found) {
      const lat5 = Math.round(found.lat * 1e5) / 1e5;
      const lng5 = Math.round(found.lng * 1e5) / 1e5;
      item[3] = 1;
      item.length = 5; // pref, 座標あり, 国 の後ろに古い値が残っていないようにする
      item.push(lat5, lng5);
      r.got++;
      r.methods[found.method] = (r.methods[found.method] || 0) + 1;
      listNewCoord.set(m.listKey, (listNewCoord.get(m.listKey) || 0) + 1);

      const key = tileKey(found.lat, found.lng);
      if (!tileChanges.has(key)) tileChanges.set(key, new Map());
      const group = tileChanges.get(key);
      const radius = RADIUS[m.listKey] || 200;
      if (group.has(m.id)) {
        const cur = group.get(m.id);
        if (!cur[7].includes(m.listKey)) cur[7].push(m.listKey);
        cur[6] = Math.max(cur[6], radius);
      } else {
        group.set(m.id, [m.id, m.listKey, m.name, found.lat, found.lng, 'list', radius, [m.listKey], m.pref, m.country || '日本']);
      }
    } else if (cache.defunct[m.id]) {
      r.defunctExamples.push(m.name);
    } else {
      r.failExamples.push(m.name);
    }
  }

  // tile ファイルへ反映（既存の spot に id が既にあれば一覧キーを足し、半径は大きい方にする）
  for (const [key, group] of tileChanges) {
    const existing = await readTile(key);
    const byId = new Map(existing.map((s, i) => [s[0], i]));
    let added = 0;
    for (const [id, spot] of group) {
      if (byId.has(id)) {
        const cur = existing[byId.get(id)];
        for (const lk of spot[7]) if (!cur[7].includes(lk)) cur[7].push(lk);
        cur[6] = Math.max(cur[6], spot[6]);
        if (!cur[8]) cur[8] = spot[8];
        if (!cur[9]) cur[9] = spot[9];
      } else {
        existing.push(spot);
        added++;
      }
    }
    await writeFile(path.join(SPOTS_DIR, `${key}.json`), JSON.stringify(existing));
    tileNewCount.set(key, (tileNewCount.get(key) || 0) + added);
  }

  // lists.json 書き出し
  await writeFile(LISTS_FILE, JSON.stringify(listsData));

  // meta.json 更新
  const meta = JSON.parse(await readFile(META_FILE, 'utf8'));
  let addedSpots = 0;
  for (const [key, added] of tileNewCount) {
    if (!added) continue;
    addedSpots += added;
    if (!meta.tileCounts[key]) meta.tileCounts[key] = [0, 0];
    meta.tileCounts[key][0] += added;
    if (!meta.tiles.includes(key)) meta.tiles.push(key);
  }
  meta.tiles.sort();
  meta.spots += addedSpots;
  for (const [listKey, n] of listNewCoord) if (meta.counts[listKey]) meta.counts[listKey].withCoord += n;
  meta.generatedAt = new Date().toISOString();
  await writeFile(META_FILE, JSON.stringify(meta));

  return report;
}

async function main() {
  const listsData = JSON.parse(await readFile(LISTS_FILE, 'utf8'));
  const cache = await loadCache();

  const missing = [];
  listsData.lists.forEach((list) => {
    list.items.forEach((it, idx) => {
      if (it[3] === 0) missing.push({ listKey: list.key, idx, id: it[0], name: it[1], pref: it[2], country: it[4] });
    });
  });
  console.log(`座標なし 合計 ${missing.length} 件`);

  const notCached = (m) => !cache.found[m.id] && !cache.failed[m.id] && !cache.defunct[m.id];

  await phaseWikidataDirect(missing.filter(notCached), cache);
  await saveCache(cache);

  await phaseWikidataChildren(missing.filter(notCached), cache);
  await saveCache(cache);

  const persist = () => saveCache(cache);
  const jp = missing.filter((m) => m.country === '日本' && notCached(m));
  await phaseJapanFallback(jp, cache, persist);
  await saveCache(cache);

  const global = missing.filter((m) => m.country !== '日本' && notCached(m));
  await phaseGlobalFallback(global, cache, persist);
  await saveCache(cache);

  await phaseDetectDefunct(missing.filter((m) => !cache.found[m.id]), cache);
  await saveCache(cache);

  const report = await applyResults(listsData, missing, cache);
  console.log('--- 一覧ごとの結果 ---');
  for (const [key, r] of report) {
    if (!r.before) continue;
    console.log(`${key}: ${r.before} → ${r.before - r.got}（取れた ${r.got}: ${JSON.stringify(r.methods)}）`);
    if (r.defunctExamples.length) console.log(`  もう無い可能性: ${r.defunctExamples.length} 件 例: ${r.defunctExamples.slice(0, 5).join('、')}`);
    if (r.failExamples.length) console.log(`  取れなかった: ${r.failExamples.length} 件 例: ${r.failExamples.slice(0, 5).join('、')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
