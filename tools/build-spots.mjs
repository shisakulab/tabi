// Wikidata（SPARQL）と OpenStreetMap（Overpass）から場所のデータを作る
//   node tools/build-spots.mjs            キャッシュがあれば再利用する
//   node tools/build-spots.mjs --refresh  問い合わせ直す
// 出力：data/spots/<0.5度区画>.json、data/spots/meta.json、data/lists.json、data/seasons-coords.json
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { tileKey, distanceMeters } from '../logic.js';

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
// tier は 'list'（一覧に入っている場所。車・電車でも出す）か 'near'（近所の場所。徒歩・自転車のときだけ出す）
const LISTS = [
  { key: 'heritage', name: '世界遺産', note: '日本の世界遺産の構成資産', radius: 500, cond: '?s wdt:P757 [] ; wdt:P17 wd:Q17 .' },
  { key: 'judenken', name: '重伝建', note: '重要伝統的建造物群保存地区', radius: 300, cond: '?s wdt:P1435 wd:Q850649 .' },
  { key: 'meijo100', name: '日本100名城', note: '日本城郭協会選定', radius: 300, cond: '?s wdt:P361 wd:Q1139439 .' },
  { key: 'zokumeijo', name: '続日本100名城', note: '日本城郭協会選定', radius: 300, cond: '?s wdt:P361 wd:Q30927700 .' },
  { key: 'meisui', name: '名水百選', note: '環境省選定', radius: 50, cond: '?s wdt:P361 wd:Q10917783 .' },
  { key: 'taki100', name: '日本の滝百選', note: '1990年選定', radius: 150, cond: '?s wdt:P361 wd:Q40172600 .' },
  // 国宝は美術工芸品も含む。美術品は所蔵館の位置で登録されていて1か所に何十件も重なるので、
  // 所蔵（P195）があるものと、所在地（P276）が博物館のものを除く（残りはほぼ建造物）
  { key: 'kokuho', name: '国宝', note: '国宝の建造物（同じ寺社・城の建物は1つにまとめる）', radius: 150,
    cond: '?s wdt:P1435 wd:Q1139795 ; wdt:P625 [] . FILTER NOT EXISTS { ?s wdt:P195 [] } FILTER NOT EXISTS { ?s wdt:P276 ?m . ?m wdt:P31/wdt:P279? wd:Q33506 }' },
  { key: 'ichinomiya', name: '一宮', note: '各国の一宮（諸説あるものを含む）', radius: 150, cond: '?s wdt:P13723 wd:Q1656379 ; wdt:P625 [] .' },
  { key: 'michinoeki', name: '道の駅', note: '国土交通省登録', radius: 150, cond: '?s wdt:P31 wd:Q1187691 .' },
];

// OSM の近所の場所。都道府県ごとに Overpass で取る（全国を1回で取るとタイムアウトする）
const OVERPASS = ['https://overpass-api.de/api/interpreter'];
const PREF_ISO = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

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

async function overpass(query, name) {
  const file = path.join(CACHE, `${name}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  for (let i = 0; i < 6; i++) {
    if (i) await sleep(15000 * i);
    const url = OVERPASS[i % OVERPASS.length];
    // AbortSignal.timeout のタイマーはプロセスを生かしておかないので、応答待ちの間に node が終わってしまう。普通のタイマーを使う
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 400000);
    try {
      const res = await fetch(url, { signal: ac.signal, method: 'POST', headers: { 'User-Agent': HEADERS['User-Agent'], 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (json.remark && /timed out|error/i.test(json.remark)) throw new Error(json.remark);
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, JSON.stringify(json.elements));
      return json.elements;
    } catch (err) { console.log(`${name}: 失敗 ${err.message}（再試行）`); } finally { clearTimeout(timer); }
  }
  throw new Error(`${name}: 取得できませんでした`);
}

// 温泉か銭湯か神社かお寺か灯台か博物館か名所か展望か パン屋か喫茶店か。どれでもなければ null
// 喫茶店・パン屋から外すチェーン（名前に含むもの）
const CHAIN_RE = /スターバックス|スタバ|Starbucks|ドトール|DOUTOR|タリーズ|Tully|コメダ|エクセルシオール|サンマルク|ベローチェ|VELOCE|星乃珈琲|上島珈琲|プロント|PRONTO|カフェ・ド・クリエ|珈琲館|ルノアール|高倉町珈琲|倉式珈琲|むさしの森珈琲|椿屋珈琲|コナズ珈琲|ブルーボトル|Blue Bottle|カフェ・ベローチェ|ミスタードーナツ|ミスド|マクドナルド|ケンタッキー|モスバーガー|ロッテリア|コーヒービーン|Coffee Bean|ゴンチャ|ポンパドウル|神戸屋|サンジェルマン|ヴィ・ド・フランス|ドンク|アンデルセン|リトルマーメイド|ベーカリーレストランサンマルク|デイリーヤマザキ|メゾンカイザー|PAUL|カスカード|R Baker|ブーランジェリーナカガワ|シャトレーゼ/;
function nearKind(t) {
  if (t.man_made === 'lighthouse') return 'lighthouse';
  if (t.amenity === 'place_of_worship') return t.religion === 'shinto' ? 'shrine' : t.religion === 'buddhist' ? 'temple' : null;
  if (t.natural === 'hot_spring') return 'onsen';
  if (t.amenity === 'public_bath') {
    if (t['bath:type'] === 'foot_bath' || t.access === 'private' || t.access === 'no') return null;
    return t['bath:type'] === 'onsen' || /温泉/.test(t.name) ? 'onsen' : 'sento';
  }
  if (t.tourism === 'museum') return 'museum';
  // historic=memorial（小さな碑）は件数が多すぎるので外す
  if (t.tourism === 'attraction' || ['castle', 'ruins', 'monument'].includes(t.historic)) return 'sight';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  // チェーン店は除く（brand タグがないチェーンも多いので名前でも見る）
  // 名前が支店名だけ（「日本橋店」「新宿東口店」）のものは、何の店か分からないので除く
  const branchOnly = /^[一-鿿]{1,4}店$/.test(((t['name:ja'] || t.name) || '').trim());
  const chain = t.brand || t['brand:wikidata'] || branchOnly || CHAIN_RE.test(t.name || '') || CHAIN_RE.test(t['name:ja'] || '');
  if (t.shop === 'bakery') return chain ? null : 'bakery';
  if (t.amenity === 'cafe') return chain ? null : 'cafe';
  return null;
}

// 1つの都道府県の近所の場所：[[id, kind, name, lat, lng, 'near', radius, [], pref]]
async function fetchNear(pref, i) {
  const iso = `JP-${String(i + 1).padStart(2, '0')}`;
  // 1回で全部取ると大きい県（北海道など）でタイムアウトするので、種類ごとに分けて取る
  const groups = {
    shinto: 'nwr["amenity"="place_of_worship"]["religion"="shinto"]["name"](area.a);',
    buddhist: 'nwr["amenity"="place_of_worship"]["religion"="buddhist"]["name"](area.a);',
    bath: 'nwr["amenity"="public_bath"]["name"](area.a); nwr["natural"="hot_spring"]["name"](area.a); nwr["man_made"="lighthouse"]["name"](area.a);',
    museum: 'nwr["tourism"="museum"]["name"](area.a);',
    sight: 'nwr["tourism"="attraction"]["name"](area.a); nwr["historic"~"^(castle|ruins|monument|memorial)$"]["name"](area.a);',
    viewpoint: 'nwr["tourism"="viewpoint"]["name"](area.a);',
    bakery: 'nwr["shop"="bakery"]["name"](area.a);',
    cafe: 'nwr["amenity"="cafe"]["name"](area.a);',
  };
  const els = [];
  for (const [g, body] of Object.entries(groups)) {
    els.push(...await overpass(`[out:json][timeout:360];
area["ISO3166-2"="${iso}"]->.a;
( ${body} );
out center;`, `osm-${iso}-${g}`));
  }
  const out = [];
  for (const e of els) {
    const t = e.tags || {};
    const kind = nearKind(t);
    const lat = e.lat ?? e.center?.lat; const lng = e.lon ?? e.center?.lon;
    const name = (t['name:ja'] || t.name || '').trim();
    if (!kind || !name || !Number.isFinite(lat)) continue;
    // 灯台は遠くから目当てに行く場所なので、車・電車でも出す（tier: 'list'）
    out.push([`${e.type[0]}${e.id}`, kind, name, +lat.toFixed(6), +lng.toFixed(6), kind === 'lighthouse' ? 'list' : 'near', e.type === 'node' ? 50 : 100, [], pref]);
  }
  return out;
}

const qidOf = (uri) => uri.value.split('/').pop();
function parsePoint(v) {
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(v || '');
  return m ? { lat: Number(m[2]), lng: Number(m[1]) } : null;
}

// 都道府県が Wikidata で取れない item を座標から補う（国土地理院の逆ジオコーダ）。結果は id → 都道府県（取れなければ空）でキャッシュ
const GSI_CACHE_FILE = path.join(CACHE, 'gsi-pref.json');
async function loadGsiCache() {
  try { return JSON.parse(await readFile(GSI_CACHE_FILE, 'utf8')); } catch { return {}; }
}
async function gsiPrefFor(id, lat, lng, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
  let pref = '';
  try {
    const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    if (res.ok) {
      const json = await res.json();
      const muniCd = json && json.results && json.results.muniCd;
      const code = muniCd ? Number(muniCd.slice(0, 2)) : 0;
      if (code >= 1 && code <= PREF_ISO.length) pref = PREF_ISO[code - 1];
    }
  } catch { /* 海上などで取れなければ空のままキャッシュする */ }
  cache[id] = pref;
  await mkdir(CACHE, { recursive: true });
  await writeFile(GSI_CACHE_FILE, JSON.stringify(cache));
  await sleep(300);
  return pref;
}

// 1つの一覧を取る：[{ id, name, lat, lng, pref }]（id 重複は1つに）
async function fetchList(list, gsiCache) {
  const base = await sparql(`SELECT ?s ?l ?c WHERE { ${list.cond}
    OPTIONAL { ?s wdt:P625 ?c }
    OPTIONAL { ?s rdfs:label ?l FILTER(LANG(?l) = "ja") } }`, `${list.key}-base`);
  // 都道府県は、条件の重い一覧（国宝など）でタイムアウトしないよう、取れた id を VALUES で渡して引く
  const ids = [...new Set(base.map((r) => qidOf(r.s)))];
  const prefRows = [];
  for (let i = 0; i < ids.length; i += 300) {
    prefRows.push(...await sparql(`SELECT ?s ?pl WHERE { VALUES ?s { ${ids.slice(i, i + 300).map((q) => 'wd:' + q).join(' ')} }
    ?s wdt:P131+ ?p . ?p wdt:P31 wd:Q50337 . ?p rdfs:label ?pl FILTER(LANG(?pl) = "ja") }`, i ? `${list.key}-pref-${i}` : `${list.key}-pref`));
  }
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
  const result = [...items.values()].filter((it) => it.name) // 日本語の名前がないものは載せない
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  for (const it of result) {
    if (!it.pref && it.lat !== null) it.pref = await gsiPrefFor(it.id, it.lat, it.lng, gsiCache);
  }
  return result;
}

// 国宝：建物ごと（P1435=Q1139795）を、P361（〜の一部）の親が1つに決まるものは親ごとにまとめる。
// まとめない：親が複数ある建物、親の子が1件だけ（まとめる意味がない）、親が一覧・集合（世界遺産やこの一覧自体）
const KOKUHO_LIST_EXCLUDE = new Set(['Q1139439', 'Q30927700', 'Q10917783', 'Q40172600']); // 100名城・続100名城・名水百選・滝百選
const WORLD_HERITAGE_QID = 'Q9259';
const GROUP_MAX_METERS = 1500;
function commonPrefix(names) {
  if (!names.length) return '';
  let p = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  return p.trim();
}
async function fetchKokuhoGroups(items) {
  const ids = items.map((it) => it.id);
  const parentRows = [];
  for (let i = 0; i < ids.length; i += 300) {
    parentRows.push(...await sparql(`SELECT ?s ?p WHERE { VALUES ?s { ${ids.slice(i, i + 300).map((q) => 'wd:' + q).join(' ')} } ?s wdt:P361 ?p . }`,
      i ? `kokuho-p361-${i}` : 'kokuho-p361'));
  }
  const parentsOf = new Map(); // child id → Set(親 id)
  for (const r of parentRows) {
    const child = qidOf(r.s); const parent = qidOf(r.p);
    if (!parentsOf.has(child)) parentsOf.set(child, new Set());
    parentsOf.get(child).add(parent);
  }
  const byParent = new Map(); // 親が1つに決まる建物だけ、親 id → [子 item]
  for (const it of items) {
    const parents = parentsOf.get(it.id);
    if (parents && parents.size === 1) {
      const p = [...parents][0];
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(it);
    }
  }
  const candidateParents = [...byParent.entries()].filter(([, kids]) => kids.length > 1).map(([p]) => p);
  const parentInfo = new Map();
  for (let i = 0; i < candidateParents.length; i += 300) {
    const chunk = candidateParents.slice(i, i + 300);
    const rows = await sparql(`SELECT ?s ?l ?c ?type WHERE { VALUES ?s { ${chunk.map((q) => 'wd:' + q).join(' ')} }
      OPTIONAL { ?s rdfs:label ?l FILTER(LANG(?l) = "ja") }
      OPTIONAL { ?s wdt:P625 ?c }
      OPTIONAL { ?s wdt:P31 ?type } }`, i ? `kokuho-parent-${i}` : 'kokuho-parent');
    for (const r of rows) {
      const id = qidOf(r.s);
      const cur = parentInfo.get(id) || { name: '', point: null, types: new Set() };
      if (r.l && !cur.name) cur.name = r.l.value;
      if (r.c) { const p = parsePoint(r.c.value); if (p) cur.point = p; }
      if (r.type) cur.types.add(qidOf(r.type));
      parentInfo.set(id, cur);
    }
  }
  const groupedIds = new Set(); // まとめられた子 id
  const aliases = {}; // 子 id → 親 id（判子の引っ越し用）
  const extra = []; // まとめた親の item
  const excluded = []; // まとめなかった親（一覧・集合）の報告
  for (const [parent, kids] of byParent.entries()) {
    if (kids.length <= 1) continue; // 子が1件だけならまとめない
    const info = parentInfo.get(parent);
    const isExcluded = !info || KOKUHO_LIST_EXCLUDE.has(parent) || info.types.has(WORLD_HERITAGE_QID);
    if (isExcluded) { excluded.push({ id: parent, name: info ? info.name : '', count: kids.length }); continue; }
    const center = info.point || { lat: kids.reduce((s, k) => s + k.lat, 0) / kids.length, lng: kids.reduce((s, k) => s + k.lng, 0) / kids.length };
    const farthest = Math.max(...kids.map((k) => distanceMeters(center, k)));
    // 子が離れすぎている親（古都京都の文化財のような、別々の寺社の集まり）はまとめない。半径は 500m までなので、まとめると押せない建物が出る
    if (farthest > GROUP_MAX_METERS) { excluded.push({ id: parent, name: info.name, count: kids.length, farthest: Math.round(farthest) }); continue; }
    for (const k of kids) { groupedIds.add(k.id); aliases[k.id] = parent; }
    const radius = Math.min(500, Math.max(150, Math.round(farthest + 50)));
    const pref = (kids.find((k) => k.pref) || {}).pref || '';
    const name = info.name || commonPrefix(kids.map((k) => k.name)) || kids[0].name;
    extra.push({ id: parent, name, lat: center.lat, lng: center.lng, pref, radius });
  }
  // 親そのものも国宝として一覧にある（法隆寺・姫路城など）なら、まとめた方だけ残す
  const extraIds = new Set(extra.map((e) => e.id));
  const remaining = items.filter((it) => !groupedIds.has(it.id) && !extraIds.has(it.id));
  return { items: [...remaining, ...extra], aliases, excluded };
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
  // --warm-reverse：OSM のキャッシュだけを沖縄から逆順に作る（本体と並べて走らせると、Overpass の2枠を使えて速い）
  if (process.argv.includes('--warm-reverse')) {
    for (let i = PREF_ISO.length - 1; i >= 0; i--) { await fetchNear(PREF_ISO[i], i); console.log(`${PREF_ISO[i]}: キャッシュ済み`); }
    return;
  }
  await mkdir(path.join(OUT, 'spots'), { recursive: true });
  const spots = new Map(); // id → [id, kind, name, lat, lng, tier, radius, lists, pref]
  const listsOut = [];
  const counts = {};
  const gsiCache = await loadGsiCache();
  let kokuhoAliases = {};
  for (const list of LISTS) {
    let items = await fetchList(list, gsiCache);
    if (list.key === 'kokuho') {
      const before = items.length;
      const grouped = await fetchKokuhoGroups(items);
      items = grouped.items;
      kokuhoAliases = grouped.aliases;
      const groupCount = new Set(Object.values(grouped.aliases)).size;
      console.log(`国宝: 建物ごと ${before} 件 → 場所ごと ${items.length} 件（${groupCount} 件の場所に子 ${Object.keys(grouped.aliases).length} 件をまとめ）`);
      if (grouped.excluded.length) console.log(['国宝: まとめなかった親（一覧・集合）:', ...grouped.excluded.map((e) => `${e.name || e.id}（${e.id}、子 ${e.count} 件${e.farthest ? `、いちばん遠い子 ${e.farthest}m` : ""}）`)].join('\n  '));
    }
    counts[list.key] = { total: items.length, withCoord: items.filter((i) => i.lat !== null).length };
    console.log(`${list.name}: ${items.length} 件（座標あり ${counts[list.key].withCoord}）`);
    listsOut.push({ key: list.key, name: list.name, note: list.note, items: items.map((i) => [i.id, i.name, i.pref, i.lat !== null ? 1 : 0]) });
    for (const it of items) {
      if (it.lat === null) continue;
      const cur = spots.get(it.id);
      const radius = it.radius || list.radius;
      if (!cur) { spots.set(it.id, [it.id, list.key, it.name, it.lat, it.lng, 'list', radius, [list.key], it.pref]); continue; }
      if (!cur[7].includes(list.key)) cur[7].push(list.key);
      cur[6] = Math.max(cur[6], radius);
      if (!cur[8]) cur[8] = it.pref;
    }
  }
  const nearCounts = {};
  // --no-osm：近所の場所（OSM）を入れずに作る
  if (!process.argv.includes('--no-osm')) for (const [i, pref] of PREF_ISO.entries()) {
    const near = await fetchNear(pref, i);
    for (const s of near) { spots.set(s[0], s); nearCounts[s[1]] = (nearCounts[s[1]] || 0) + 1; }
    console.log(`${pref}: 近所の場所 ${near.length} 件`);
    if (refresh || !existsSync(path.join(CACHE, `osm-JP-${String(i + 2).padStart(2, '0')}-bath.json`))) await sleep(5000);
  }
  counts.near = nearCounts;
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
    generatedAt: new Date().toISOString(), source: 'Wikidata (CC0), OpenStreetMap contributors (ODbL)', spots: spots.size, tiles: [...tiles.keys()].sort(), counts,
    // 区画ごとの件数 [一覧の場所, 近所の場所]。地図を引いたとき、区画を読まずに数だけ出すのに使う
    tileCounts: Object.fromEntries([...tiles].map(([k, l]) => [k, [l.filter((s) => s[5] !== 'near').length, l.filter((s) => s[5] === 'near').length]])),
    shape: '[id, kind, name, lat, lng, tier, radius, lists, pref]',
  }));
  // lists.json：items は [id, 名前, 都道府県, 座標あり(1/0)]。aliases は国宝をまとめたことで変わった spotId（子 id → 親 id）。古い判子を救うのに使う
  await writeFile(path.join(OUT, 'lists.json'), JSON.stringify({ lists: listsOut, aliases: kokuhoAliases }));
  console.log(`地点 ${spots.size} 件、区画 ${tiles.size} 個`);
  const sc = await fetchSeasonCoords();
  console.log('季節の名所の座標: ' + sc.got + ' / ' + sc.total);
  if (sc.missing.length) console.log(['座標を取れなかった名所:', ...sc.missing].join('\n  '));
}
main().catch((e) => { console.error(e); process.exit(1); });
