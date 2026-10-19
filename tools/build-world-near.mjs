// 海外100都市（tools/world-cities.mjs）の「近所の場所」を OpenStreetMap（Overpass）から取り、data/spots/ に tier=near で入れる
//   node tools/build-world-near.mjs --fetch   Overpass から都市ごとに取る（tools/.cache/wn-*.json にキャッシュ。混んでいたら間隔を空けて再試行、取れない都市は報告）
//   node tools/build-world-near.mjs           キャッシュから data/spots/ に反映する（海外の近所の場所は毎回入れ替える。日本・世界遺産などは触らない）
//   --cities paris,rome   対象の都市を絞る
// 種類：教会・モスク・シナゴーグ・ヒンドゥー寺院・お寺（amenity=place_of_worship。wikidata タグか heritage タグがある名の通ったものだけ）、
//       博物館・美術館（tourism=museum、tourism=gallery は wikidata があるものだけ）、展望（tourism=viewpoint）、
//       名所（tourism=attraction で wikidata あり）、パン屋（shop=bakery）、喫茶店（amenity=cafe。brand・brand:wikidata とチェーン名は除く）
// 数が多すぎないよう、都市ごとに種類別の上限を決め、wikidata・heritage があるものと中心に近いものを優先する
// 名前：name:ja → 日本語になった名前（tools/names-ja.json。作り方は tools/build-names-ja.mjs）→ 元の name。訳した名前の元の名前は行の11番目（orig）に残す
// 日本語に訳す前の名前は tools/near-world-names.json（id → { name, hint, country, kind }）に書き出す（tools/build-names-ja.mjs が読む）
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tileKey, distanceMeters } from '../logic.js';
import { CITIES, RADIUS_M } from './world-cities.mjs';
import { loadNamesJa, jaName, hasJa } from './names-ja.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'tools', '.cache');
const SPOTS = path.join(root, 'data', 'spots');
const UA = 'tabigoyomi-build-world-near/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)';
const ENDPOINTS = ['https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 種類の判定 ----------
// 喫茶店・パン屋から外すチェーン（名前に含むもの。brand・brand:wikidata のあるものは別に除く）
export const WORLD_CHAIN_RE = /starbucks|costa coffee|pret a manger|tim hortons|dunkin|caff[eè] nero|gloria jean|coffee bean|tchibo|segafredo|mcdonald|mccaf[eé]|burger king|kfc|subway|paul\b|brioche dor[eé]e|le pain quotidien|panera|greggs|gregg's|nespresso|lavazza|illy|jamba|krispy|baskin|barista|coffee island|espresso house|wayne's coffee|joe & the juice|columbus caf[eé]|cafe coffee day|ccd\b|caribou|peet's|blue bottle|a&w|bakers delight|breadtalk|gong cha|ya kun|old town white|secret recipe|oriental bakery|ミスタードーナツ|スターバックス/i;
const RELIGION_KIND = { christian: 'church', muslim: 'mosque', jewish: 'synagogue', hindu: 'hindu', buddhist: 'temple', taoist: 'temple', shinto: 'shrine' };
export function worldNearKind(t) {
  if (!t || !(t['name:ja'] || t.name)) return null;
  if (t.amenity === 'place_of_worship') {
    if (!t.wikidata && !t.heritage) return null; // 名の通ったものだけ
    return RELIGION_KIND[t.religion] || null;
  }
  if (t.tourism === 'museum') return 'museum';
  if (t.tourism === 'gallery') return t.wikidata ? 'museum' : null;
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.tourism === 'attraction') return t.wikidata ? 'sight' : null;
  const chain = t.brand || t['brand:wikidata'] || WORLD_CHAIN_RE.test(t.name || '') || WORLD_CHAIN_RE.test(t['name:en'] || '');
  if (t.shop === 'bakery') return chain ? null : 'bakery';
  if (t.amenity === 'cafe') return chain ? null : 'cafe';
  return null;
}
// 都市ごとの上限（種類別）。数が多すぎないように
export const CITY_CAPS = { church: 100, mosque: 60, synagogue: 30, hindu: 40, temple: 60, museum: 80, viewpoint: 50, sight: 120, bakery: 40, cafe: 60 };
// 優先順：wikidata がある・heritage がある・情報が多い（website・営業時間）ほど先、同じなら中心に近い方
const richness = (t) => (t.wikidata ? 4 : 0) + (t.heritage ? 2 : 0) + (t.website || t['contact:website'] ? 1 : 0) + (t.opening_hours ? 1 : 0);

// ---------- Overpass ----------
const KEEP = ['name', 'name:ja', 'name:en', 'brand', 'brand:wikidata', 'wikidata', 'heritage', 'religion', 'amenity', 'tourism', 'shop', 'opening_hours', 'website', 'contact:website', 'access'];
const trim = (e) => ({ id: e.id, type: e.type, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, tags: Object.fromEntries(KEEP.filter((k) => e.tags && e.tags[k] !== undefined).map((k) => [k, e.tags[k]])) });
const GROUPS = {
  main: (a) => `nwr["amenity"="place_of_worship"]["name"]["wikidata"]${a}; nwr["amenity"="place_of_worship"]["name"]["heritage"]${a};
    nwr["tourism"="museum"]["name"]${a}; nwr["tourism"="gallery"]["name"]["wikidata"]${a};
    nwr["tourism"="viewpoint"]["name"]${a}; nwr["tourism"="attraction"]["name"]["wikidata"]${a};`,
  food: (a) => `nwr["shop"="bakery"]["name"]${a}; nwr["amenity"="cafe"]["name"]${a};`,
};
async function overpass(query, tag) {
  let lastErr = '';
  for (let i = 0; i < 8; i++) {
    if (i) await sleep(Math.min(60000, 8000 * i));
    const url = ENDPOINTS[(i + tag.length) % ENDPOINTS.length];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 240000);
    try {
      const res = await fetch(url, { signal: ac.signal, method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      if (json.remark && /timed out|error|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 80));
      return json.elements.map(trim);
    } catch (e) { lastErr = `${new URL(url).host} ${e.message}`; } finally { clearTimeout(timer); }
  }
  throw new Error(lastErr);
}
async function fetchCity(c) {
  const [id, , , lat, lng] = c;
  const around = `(around:${RADIUS_M},${lat},${lng})`;
  const out = {};
  for (const [g, body] of Object.entries(GROUPS)) {
    const file = path.join(CACHE, `wn-${id}-${g}.json`);
    if (existsSync(file)) { out[g] = JSON.parse(await readFile(file, 'utf8')); continue; }
    out[g] = await overpass(`[out:json][timeout:200];\n( ${body(around)} );\nout center tags;`, `${id}-${g}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(out[g]));
    await sleep(3000);
  }
  return out;
}
async function fetchAll(cities) {
  const failed = [];
  let next = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < cities.length) {
      const c = cities[next++];
      try { const r = await fetchCity(c); console.log(`${c[1]}（${c[0]}）: main ${r.main.length}・food ${r.food.length}`); }
      catch (e) { failed.push(c[1]); console.log(`${c[1]}（${c[0]}）: 取れませんでした ${e.message}`); }
    }
  }));
  if (failed.length) console.log('取れなかった都市：' + failed.join('、'));
  return failed;
}

// ---------- 都市ごとの選別 ----------
// 戻り：[{ id, kind, name, lat, lng, radius, tags }]（上限・重複を除いたあと）
export function pickCity(city, elements) {
  const [, , , clat, clng] = city;
  const byKind = new Map();
  const seen = new Set();
  for (const e of elements) {
    const kind = worldNearKind(e.tags);
    if (!kind || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const key = `${e.type[0]}${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (e.tags['name:ja'] || e.tags.name).trim();
    if (!name) continue;
    const d = distanceMeters({ lat: clat, lng: clng }, { lat: e.lat, lng: e.lon });
    if (d > RADIUS_M + 500) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ id: key, kind, name, lat: e.lat, lng: e.lon, radius: e.type === 'node' ? 50 : 100, tags: e.tags, d });
  }
  const out = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => richness(b.tags) - richness(a.tags) || a.d - b.d);
    // 同じ種類・同じ名前で 80m 以内にあるもの（node と way の二重登録など）は1つに
    const kept = [];
    for (const s of list) {
      if (kept.length >= (CITY_CAPS[kind] || 50)) break;
      if (kept.some((k) => k.name === s.name && distanceMeters(k, s) < 80)) continue;
      kept.push(s);
    }
    out.push(...kept);
  }
  return out;
}

// ---------- data/spots/ に反映 ----------
// キャッシュから行を作る：{ rows, extra, perCity, perKind, missing }。tools/build-spots.mjs も使う（作り直しても同じ結果になる）
export async function worldNearRows(cities = CITIES) {
  const tables = loadNamesJa();
  // 世界遺産などの Wikidata id（OSM の wikidata が同じなら二重になるので入れない）
  const lists = JSON.parse(await readFile(path.join(root, 'data', 'lists.json'), 'utf8')).lists;
  const known = new Set(lists.flatMap((l) => l.items.map((i) => i[0])));
  const perCity = {}; const perKind = {}; const missing = [];
  const rows = []; const extra = {};
  for (const c of cities) {
    const els = [];
    for (const g of Object.keys(GROUPS)) {
      const file = path.join(CACHE, `wn-${c[0]}-${g}.json`);
      if (existsSync(file)) els.push(...JSON.parse(await readFile(file, 'utf8')));
      else { missing.push(c[1]); break; }
    }
    if (missing.includes(c[1])) continue;
    const picked = pickCity(c, els).filter((s) => !(s.tags.wikidata && known.has(s.tags.wikidata)));
    perCity[c[1]] = picked.length;
    for (const s of picked) {
      let name = s.name; let orig = '';
      if (!s.tags['name:ja'] && !hasJa(name)) {
        const j = jaName(tables, s.id, name);
        if (j.orig) { name = j.name; orig = j.orig; }
        else extra[s.id] = { name, hint: s.tags['name:en'] && s.tags['name:en'] !== name ? s.tags['name:en'] : '', country: c[2], kind: 'near' };
      }
      perKind[s.kind] = (perKind[s.kind] || 0) + 1;
      rows.push([s.id, s.kind, name, +s.lat.toFixed(6), +s.lng.toFixed(6), 'near', s.radius, [], '', c[2], ...(orig ? [orig] : [])]);
    }
  }
  return { rows, extra, perCity, perKind, missing };
}

async function applyAll(cities) {
  const { rows, extra, perCity, perKind, missing } = await worldNearRows(cities);
  await writeFile(path.join(root, 'tools', 'near-world-names.json'), JSON.stringify(extra));
  // 既存の区画から、前に入れた海外の近所の場所（tier=near で日本以外）を外して、新しい分を足す
  const tiles = new Map();
  for (const f of await readdir(SPOTS)) {
    if (f === 'meta.json') continue;
    const arr = JSON.parse(await readFile(path.join(SPOTS, f), 'utf8'));
    tiles.set(f.replace(/\.json$/, ''), arr.filter((s) => !(s[5] === 'near' && s[9] !== '日本')));
  }
  const have = new Set([...tiles.values()].flatMap((a) => a.map((s) => s[0])));
  let added = 0;
  for (const r of rows) {
    if (have.has(r[0])) continue; // 都市が重なる場所の二重登録を避ける
    have.add(r[0]);
    const tk = tileKey(r[3], r[4]);
    if (!tiles.has(tk)) tiles.set(tk, []);
    tiles.get(tk).push(r); added++;
  }
  for (const [tk, arr] of tiles) {
    const file = path.join(SPOTS, `${tk}.json`);
    if (!arr.length) { await rm(file, { force: true }); continue; } // 海外の近所の場所だけだった区画が空になったら消す
    await writeFile(file, JSON.stringify(arr));
  }
  const meta = JSON.parse(await readFile(path.join(SPOTS, 'meta.json'), 'utf8'));
  meta.generatedAt = new Date().toISOString();
  meta.spots = [...tiles.values()].reduce((n, a) => n + a.length, 0);
  meta.tiles = [...tiles.entries()].filter(([, a]) => a.length).map(([k]) => k).sort();
  meta.counts.nearWorld = perKind;
  meta.tileCounts = Object.fromEntries([...tiles].filter(([, l]) => l.length).map(([k, l]) => [k, [l.filter((s) => s[5] !== 'near').length, l.filter((s) => s[5] === 'near').length]]));
  meta.shape = '[id, kind, name, lat, lng, tier, radius, lists, pref, country, orig?]';
  await writeFile(path.join(SPOTS, 'meta.json'), JSON.stringify(meta));
  console.log(`海外の近所の場所：${added} 件（${Object.keys(perCity).length} 都市）`, JSON.stringify(perKind));
  console.log('都市別：' + Object.entries(perCity).map(([k, v]) => `${k} ${v}`).join('、'));
  console.log(`日本語名が未定（翻訳待ち）：${Object.keys(extra).length} 件`);
  if (missing.length) console.log('キャッシュが無い都市：' + missing.join('、'));
}

async function main() {
  const only = (process.argv.find((a, i) => process.argv[i - 1] === '--cities') || '').split(',').filter(Boolean);
  const cities = only.length ? CITIES.filter((c) => only.includes(c[0])) : CITIES;
  if (process.argv.includes('--fetch')) { await fetchAll(cities); return; }
  await applyAll(cities);
}
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exit(1); });
