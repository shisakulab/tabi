import seasonThemes from './themes/seasons.js';
import * as db from './db.js';
import {
  todayStr, dailyCount, distanceMeters, tilesForBounds, nearestSpot, bearingDeg, canStamp, stampedOn, fitSize,
  modeAllows, spotsForMode, seasonOf, formatBestMonths, majorityMonths, modesOfDay, wafuMonth, markKindOf, visitLevel, stampDatesOf, diaryRange, shiftDay, photoKey, monthlyQuests, dailyQuests, pickNear, bestLoop, listProgress, prefsVisited, countryProgress, countriesOf, countriesVisited, groupByDay, shouldRemindBackup,
  sealTypeFor, shouldAutoStamp, sealDraft, readExifDate, readExifGPS, findTiffStart, exifSummary, matchPhotoStamps, PHOTO_SLACK_METERS, parseGpx, gpxStops, gpxDayDistances, matchGpxVisits, remapVisits, classifyFood, normalizeName,
  MODES, normalizeMode, festivalSpot, addTrack, LOOP_TARGET, LOOP_SPEED_KMH, LOOP_MINUTE_CHOICES, NEAR_KINDS, PREFS, NEAR_METERS, DAILY_MODES, STEP_METERS, MEMO_TYPE,
  monthGrid, shiftMonth,
} from './logic.js';

const GSI_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const WD_ATTR = '<a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a>（CC0）・<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>（ODbL）';
const TOKYO = { lat: 35.681236, lng: 139.767125 };
const TIER_COLOR = { list: '#2b4c7e', near: '#7a8f5b' };
const SEAL_COLOR = '#b8423a';
const FOOD_COLOR = '#b5752e';
const OFF_COLOR = '#8a9699'; // 見頃でない季節の名所
const ROAD_COLOR = '#9a6b2f'; // 道の駅
const MODE_VERB = { walk: '歩いて', bike: '自転車で', trip: '旅行で', train: '電車で', car: '車で', plane: '飛行機で' };
const SEAL_TYPES = [MEMO_TYPE, '御朱印', '御城印', '鉄印', '御船印', '灯台御守印', 'その他'];
const MIN_ZOOM_ALL = 10; // これより引いているときは季節の名所と世界遺産・重伝建だけ
const MIN_ZOOM_SHOP = 14; // ご当地グルメのお店を出す寄り具合
const MIN_ZOOM_NEAR = 15; // これより引いているときは近所の場所（温泉・銭湯・神社・お寺）を出さない。都心は数が多く、引くと地図が埋まる

const $ = (id) => document.getElementById(id);
const mapEl = $('map'); const questEl = $('quest'); const nearEl = $('near'); const modesEl = $('modes');
const fabEl = $('fab'); const scrim = $('scrim'); const sheetEl = $('sheet'); const sheetBody = $('sheetbody');
const grabEl = $('grab'); const toastEl = $('toast'); const locateEl = $('locate'); const settingsEl = $('settings');

const state = { origNames: new Map(), visits: [], seals: [], meals: [], mode: 'walk', pos: null, acc: null, posAt: 0, maps: [], lists: [], catalog: new Map(), seasonSpots: [], shopSpots: [], foodShops: {}, foods: [], worldFoods: [], tab: 'spots', fixes: [], climate: null };
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 動作確認用：?date=2026-11-12 で今日の日付を差し替える
const now = () => {
  const d = new URLSearchParams(location.search).get('date');
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date();
};

// ---------- 小さな道具 ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}
function fmtDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  return `${y}年${m}月${day}日（${'日月火水木金土'[new Date(y, m - 1, day).getDay()]}）`;
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);
const glyphOf = (name) => [...String(name)][0] || '';

// 写真（IndexedDB の Blob → objectURL）
const urls = new Map();
async function photoSrc(id) {
  if (urls.has(id)) return urls.get(id);
  const p = await db.get('photos', id);
  if (!p) return null;
  const u = URL.createObjectURL(p.blob);
  urls.set(id, u);
  return u;
}
function imgFor(photoId, cls) {
  const img = h('img', { class: cls, alt: '', loading: 'lazy' });
  photoSrc(photoId).then((u) => { if (u) img.src = u; else img.remove(); });
  return img;
}
function dropPhotoCache() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); }
// 判子に写真が付いているとき、判子の文字の代わりに丸く切り抜いた写真を敷く（色の枠は残す）
function attachPhotoBg(el, photoId) {
  photoSrc(photoId).then((u) => { if (u) { el.style.backgroundImage = `url("${u}")`; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; } });
}

// 位置情報（15秒以内の結果は使い回す）
function getPos(timeout = 6000, force = false) {
  if (!force && state.pos && Date.now() - state.posAt < 15000) return Promise.resolve(state.pos);
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        state.acc = p.coords.accuracy;
        state.posAt = Date.now();
        resolve(state.pos);
      },
      () => resolve(!force && state.pos && Date.now() - state.posAt < 60000 ? state.pos : null),
      { enableHighAccuracy: true, timeout, maximumAge: force ? 0 : 15000 },
    );
  });
}

// 長辺 1280px の JPEG に描き直す（撮影情報は消える）
async function resizePhoto(file) {
  let src; let w; let hgt;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width; hgt = src.height;
  } catch {
    const url = URL.createObjectURL(file);
    src = new Image();
    src.src = url;
    await src.decode();
    w = src.naturalWidth; hgt = src.naturalHeight;
    URL.revokeObjectURL(url);
  }
  const size = fitSize(w, hgt);
  const canvas = document.createElement('canvas');
  canvas.width = size.w; canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.drawImage(src, 0, 0, size.w, size.h);
  if (src.close) src.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('写真を変換できませんでした');
  return blob;
}

// ---------- データ ----------
async function loadData() {
  [state.visits, state.seals, state.meals] = await Promise.all([db.getAll('visits'), db.getAll('seals'), db.getAll('meals')]);
  // 経路（GPX・ヘルスケア）からは判子を押さず「通った」の印だけにする（2026-10-14 決定）。前の版で押した判子は「通った」に移す
  const fromGpx = state.visits.filter((v) => v.source === 'gpx');
  if (fromGpx.length) {
    const p = passed(); const pp = passedPos();
    for (const v of fromGpx) {
      p[v.spotId] = Math.max(p[v.spotId] || 0, v.at || 0);
      if (!pp[v.spotId] && Number.isFinite(v.lat) && Number.isFinite(v.lng)) pp[v.spotId] = [v.lat, v.lng];
      await db.remove('visits', v.id);
    }
    savePassed();
    state.visits = state.visits.filter((v) => v.source !== 'gpx');
  }
}
// Wikidata の国名の揺れを、国境データ（Natural Earth の日本語名）にそろえる
const COUNTRY_ALIAS = { 'スペイン王国': 'スペイン', 'ノルウェー王国': 'ノルウェー', 'パレスチナ国': 'パレスチナ', 'チェコ共和国': 'チェコ', 'ギニアビサウ共和国': 'ギニアビサウ', 'ローマ帝国': 'ドイツ' };
const fetchJson = (url, fallback) => fetch(url).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);

// 一覧の定義（data/lists.json）と、季節の名所（themes/seasons.js）、ご当地グルメ（data/foods.json）を読み込む
async function loadCatalog() {
  const [lists, coords, meta, foods, climate, foodPhotos, foodShops, worldFoods, festivals, origNames] = await Promise.all([
    fetchJson('data/lists.json', { lists: [] }), fetchJson('data/seasons-coords.json', {}), fetchJson('data/spots/meta.json', {}), fetchJson('data/foods.json', []),
    fetchJson('data/climate.json', { spots: {} }), fetchJson('data/food-photos.json', {}), fetchJson('data/food-shops.json', {}), fetchJson('data/world-foods.json', []),
    fetchJson('data/festivals.json', { items: [] }), fetchJson('data/names-en.json', {}),
  ]);
  state.foods = foods;
  state.origNames = new Map(Object.entries(origNames || {}));
  state.foodPhotos = foodPhotos;
  buildShopSpots(foodShops);
  // 日本以外のご当地（Wikidata：data/world-foods.json）。日本のご当地と同じ形（key・name・summary）に country を足したもの。記録も同じ meals に付く
  state.worldFoods = (worldFoods || []).map((r) => ({ key: r.key, name: r.name, pref: '', country: r.country, summary: r.desc || '', world: true, photo: r.photo || null, qid: r.key.replace(/^w_(Q\d+).*/, '$1') }));
  state.climate = climate;
  state.tileCounts = meta.tileCounts || {};
  state.lists = lists.lists.map((l) => ({ key: l.key, name: l.name, note: l.note, global: !!l.global }));
  for (const l of lists.lists) {
    for (const [id, name, pref, hasCoord, rawCountry, lat, lng] of l.items) {
      const country = COUNTRY_ALIAS[rawCountry] || rawCountry;
      // 座標も一覧に持たせる（帳面から、まだ読み込んでいない区画＝遠くや海外の場所を地図で開くため）
      const cur = state.catalog.get(id) || { id, name, pref, hasCoord: !!hasCoord, country: country || '日本', lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, lists: [] };
      cur.lists.push(l.key);
      state.catalog.set(id, cur);
    }
  }
  state.seasonSpots = seasonThemes.map((s) => {
    const c = coords[s.key] || (s.qid && coords[s.qid]) || null;
    const lat = Number.isFinite(s.lat) ? s.lat : c ? c.lat : null;
    const lng = Number.isFinite(s.lng) ? s.lng : c ? c.lng : null;
    return {
      id: `s_${s.key}`, kind: 'season', name: s.name, pref: s.country ? '' : (s.pref || ''), country: s.country || '日本', lat, lng, tier: 'list', radius: s.radius || 50,
      lists: ['seasons'], seasons: [{ months: s.months, label: s.label, mark: s.mark }], note: s.note || '',
    };
  });
  // 祭り（Wikidata：data/festivals.json）。開催月がある祭りは季節の名所と同じ仕組み（その月に押すと季節の判子）、無い祭りは普通の場所
  for (const row of festivals.items || []) state.seasonSpots.push(festivalSpot(row));
  state.lists.push({ key: 'seasons', name: '季節の名所', note: '見頃の月に行くと季節の判子' });
  state.lists.push({ key: 'yama', name: '山・鉾・屋台行事（ユネスコ）', note: '2016年にユネスコ無形文化遺産になった33の祭り。開催の月に行くと季節の判子' });
  // 国宝を場所ごとにまとめたことなどで spotId が変わった判子を救う（lists.aliases：子 id → 親 id）
  const remapped = remapVisits(state.visits, lists.aliases || {});
  if (remapped.changed) {
    for (let i = 0; i < remapped.visits.length; i++) {
      if (remapped.visits[i] !== state.visits[i]) await db.put('visits', remapped.visits[i]);
    }
    state.visits = remapped.visits;
  }
}

// ご当地グルメのお店（data/food-shops.json：料理キー → [{id, name, lat, lng}]、出典 OSM）。同じお店は1つの場所にまとめ、何の料理かを foodKeys に持つ
function buildShopSpots(foodShops) {
  const byId = new Map();
  state.foodShops = {};
  for (const [key, list] of Object.entries(foodShops || {})) {
    state.foodShops[key] = [];
    for (const r of list) {
      let s = byId.get(r.id);
      if (!s) { s = { id: `fs_${r.id}`, kind: 'foodshop', name: r.name, pref: '', country: '日本', lat: r.lat, lng: r.lng, tier: 'list', radius: 50, lists: ['foodshop'], foodKeys: [] }; byId.set(r.id, s); }
      if (!s.foodKeys.includes(key)) s.foodKeys.push(key);
      state.foodShops[key].push(s);
    }
  }
  state.shopSpots = [...byId.values()];
}
// 日本のご当地は県、日本以外は国
const foodWhere = (f) => f.pref || f.country || '';
const foodByKey = (k) => state.foods.find((f) => f.key === k) || state.worldFoods.find((f) => f.key === k) || null;
const foodNamesOf = (spot) => (spot.foodKeys || []).map((k) => (state.foods.find((f) => f.key === k) || {}).name).filter(Boolean).join('・');
// お店の判子を押したら、そのお店の料理の「食べた」記録も付ける（同じ日・同じお店・同じ料理はもう付けない）。付けた料理の数を返す
async function addShopMeals(spot, visit, extra = {}) {
  let n = 0;
  for (const key of spot.foodKeys || []) {
    const food = state.foods.find((f) => f.key === key);
    const day = todayStr(new Date(visit.at));
    if (!food || state.meals.some((m) => m.itemKey === key && m.at === day && m.spotId === spot.id)) continue;
    const meal = { id: db.newId(), kind: 'food', name: food.name, itemKey: key, at: day, pref: food.pref, note: `${spot.name}で`, photoId: null, spotId: spot.id, visitId: visit.id, ...extra };
    await db.put('meals', meal);
    state.meals.push(meal);
    n++;
  }
  return n;
}

// 区画ファイル data/spots/<key>.json
const tiles = new Map();
const tilePending = new Map();
function loadTile(key) {
  if (tiles.has(key)) return Promise.resolve();
  if (!tilePending.has(key)) {
    tilePending.set(key, fetch(`data/spots/${key}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => null) // 通信の失敗は覚えない
      .then((list) => {
        tilePending.delete(key);
        if (list) tiles.set(key, list.map(([id, kind, name, lat, lng, tier, radius, lists, pref, country]) => ({ id, kind, name, lat, lng, tier, radius, lists, pref, country })));
      }));
  }
  return tilePending.get(key);
}
const ensureTiles = (keys) => Promise.all(keys.filter((k) => !tiles.has(k)).map(loadTile));
const spotsIn = (keys) => keys.flatMap((k) => tiles.get(k) || []);
const shopsNear = (p, m = 0.02) => state.shopSpots.filter((s) => Math.abs(s.lat - p.lat) < m && Math.abs(s.lng - p.lng) < m * 1.3);
const allLoaded = () => [...[...tiles.values()].flat(), ...state.seasonSpots.filter((s) => Number.isFinite(s.lat)), ...state.shopSpots];
function spotById(id) {
  for (const list of tiles.values()) { const s = list.find((x) => x.id === id); if (s) return s; }
  return state.seasonSpots.find((s) => s.id === id) || (id.startsWith('fs_') ? state.shopSpots.find((s) => s.id === id) : null) || state.catalog.get(id) || null;
}

// ---------- 地図の共通部品 ----------
// 日本の外は OpenFreeMap（キー不要・無料、maplibre-gl ＋ @maplibre/maplibre-gl-leaflet を CDN から読み込む）に切り替える。
// 中なら今までの国土地理院のまま（2026-10-14、world-plan.md 段階1）
const OFM_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const OFM_ATTR = '© OpenStreetMap contributors, OpenFreeMap';
// ざっくりした日本の範囲（南北大東島〜択捉島あたりまで込み）。この外なら地図を切り替える
const JP_BOUNDS = { s: 20, n: 46, w: 122, e: 154 };
const isOutsideJapan = (lat, lng) => lat < JP_BOUNDS.s || lat > JP_BOUNDS.n || lng < JP_BOUNDS.w || lng > JP_BOUNDS.e;

let maplibrePromise = null;
function loadMaplibre() {
  if (maplibrePromise) return maplibrePromise;
  maplibrePromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css';
    document.head.append(css);
    const s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js';
    s1.onerror = () => reject(new Error('maplibre-gl を読み込めませんでした'));
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.0.20/leaflet-maplibre-gl.js';
      s2.onload = resolve;
      s2.onerror = () => reject(new Error('maplibre-gl-leaflet を読み込めませんでした'));
      document.head.append(s2);
    };
    document.head.append(s1);
  });
  return maplibrePromise;
}
// 地名は日本語（name:ja）があればそれを優先する（できれば、の対応。無ければ元の表示のまま）
function preferJapaneseLabels(glMap) {
  const style = glMap.getStyle();
  if (!style || !style.layers) return;
  for (const l of style.layers) {
    if (l.layout && l.layout['text-field']) {
      try { glMap.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ja'], l.layout['text-field']]); } catch { /* 対応していないレイヤーは無視 */ }
    }
  }
}
const gsiLayer = () => L.tileLayer(GSI_URL, { attribution: GSI_ATTR, maxZoom: 18 });
// map の土台を日本（国土地理院）／日本の外（OpenFreeMap）に合わせる。すでにその向きならなにもしない
function setBaseLayer(map, outside) {
  if (map._baseOutside === outside) return;
  map._baseOutside = outside;
  const old = map._baseLayer;
  if (!outside) {
    const gsi = gsiLayer();
    gsi.addTo(map);
    if (old) map.removeLayer(old);
    map._baseLayer = gsi;
    map.attributionControl.removeAttribution(OFM_ATTR);
    return;
  }
  loadMaplibre().then(() => {
    if (map._baseOutside !== true) return; // 読み込みの間にまた日本に戻っていたら何もしない
    const gl = L.maplibreGL({ style: OFM_STYLE });
    gl.addTo(map);
    if (old) map.removeLayer(old);
    map._baseLayer = gl;
    map.attributionControl.addAttribution(OFM_ATTR);
    const glMap = gl.getMaplibreMap();
    if (glMap) glMap.once('styledata', () => preferJapaneseLabels(glMap));
  }).catch(() => { map._baseOutside = false; }); // 読み込めなければ国土地理院のままにする
}
function makeMap(el, opts = {}) {
  const map = L.map(el, opts);
  const c = opts.center || [TOKYO.lat, TOKYO.lng];
  setBaseLayer(map, isOutsideJapan(c[0], c[1]));
  state.maps.push(map);
  return map;
}
function destroyMaps() { for (const m of state.maps) m.remove(); state.maps = []; }

// ---------- シート ----------
const sheet = { redo: null };
function showSheet(redo, nodes, after) {
  sheet.redo = redo;
  destroyMaps();
  sheetBody.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
  sheetEl.style.transform = '';
  sheetEl.classList.remove('small');
  sheetEl.hidden = false;
  scrim.hidden = false;
  sheetBody.scrollTop = 0;
  if (after) after();
}
function closeSheet() {
  closePopup();
  sheet.redo = null;
  sheetEl.hidden = true;
  sheetEl.classList.remove('small');
  scrim.hidden = true;
  sheetEl.style.transform = '';
  destroyMaps();
  releaseMasuPhotos();
  sheetBody.replaceChildren();
}
scrim.addEventListener('click', closeSheet);
{
  let startY = null;
  grabEl.addEventListener('pointerdown', (e) => { startY = e.clientY; grabEl.setPointerCapture(e.pointerId); sheetEl.classList.add('drag'); });
  grabEl.addEventListener('pointermove', (e) => { if (startY !== null) sheetEl.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`; });
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    sheetEl.classList.remove('drag');
    if (e.type === 'pointerup' && dy > 80) closeSheet(); else sheetEl.style.transform = '';
  };
  grabEl.addEventListener('pointerup', end);
  grabEl.addEventListener('pointercancel', end);
}
fabEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-open]');
  if (!b) return;
  closeCard();
  if (b.dataset.open === 'book') { spotQuery = ''; foodQuery = ''; countryQuery = ''; masuDetail = null; prefDetail = null; countryDetail = null; openBook(); }
  else if (b.dataset.open === 'diary') openDiary();
  else openRecord();
});
settingsEl.addEventListener('click', () => { closeCard(); openSettings(); });
function render() {
  drawMap();
  drawQuest();
  // シートを開いているときは描き直す。スクロール位置はそのまま（先頭に飛ばない）
  if (!sheetEl.hidden && sheet.redo) { const top = sheetBody.scrollTop; sheet.redo(); sheetBody.scrollTop = top; }
}

// ---------- 判子の状態 ----------
const visitsOf = (spotId) => state.visits.filter((v) => v.spotId === spotId);
const seasonalVisitsOf = (spotId) => visitsOf(spotId).filter((v) => v.seasonal);
const sameMonth = (v, d) => { const x = new Date(v.at); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth(); };

// 通った場所（範囲に入ったが判子は押していない）。{ spotId: 最後に通った時刻 }。この端末の localStorage にだけ置く
let passedMap = null;
function passed() {
  if (passedMap) return passedMap;
  try { passedMap = JSON.parse(localStorage.getItem('tabigoyomi.passed') || '{}') || {}; } catch { passedMap = {}; }
  return passedMap;
}
// 通った場所の位置 { spotId: [lat, lng] }。引いた地図では近所の場所の区画を読まないので、位置をここに持っておいて描く
let passedPosMap = null;
function passedPos() {
  if (passedPosMap) return passedPosMap;
  try { passedPosMap = JSON.parse(localStorage.getItem('tabigoyomi.passedpos') || '{}') || {}; } catch { passedPosMap = {}; }
  return passedPosMap;
}
// 通った回数（日を分けて数える）{ spotId: 回数 }。まだ数えていない古い分は1回とみなす
let passedCntMap = null;
function passedCnt() {
  if (passedCntMap) return passedCntMap;
  try { passedCntMap = JSON.parse(localStorage.getItem('tabigoyomi.passedcnt') || '{}') || {}; } catch { passedCntMap = {}; }
  return passedCntMap;
}
const passCountOf = (id) => (passed()[id] ? Math.max(1, passedCnt()[id] || 0) : 0);
function savePassed() {
  try {
    localStorage.setItem('tabigoyomi.passedcnt', JSON.stringify(passedCnt()));
    localStorage.setItem('tabigoyomi.passed', JSON.stringify(passed()));
    localStorage.setItem('tabigoyomi.passedpos', JSON.stringify(passedPos()));
  } catch { /* 保存できなくても続ける */ }
}
// 今いる位置で範囲に入っている場所を「通った」にし、地図の判子を描き直す
function markPassed(pos, cands) {
  const p = passed();
  let changed = false;
  for (const { s, d } of cands) {
    if (d > 1000) break; // cands は近い順
    if (!canStamp(s, d, state.acc)) continue;
    if (!p[s.id]) changed = true;
    // 別の日に通ったら1回増やす
    if (!p[s.id] || todayStr(new Date(p[s.id])) !== todayStr(now())) { passedCnt()[s.id] = passCountOf(s.id) + 1; changed = true; }
    p[s.id] = Date.now();
    passedPos()[s.id] = [s.lat, s.lng];
    const m = markers.get(s.id);
    if (m) m.setIcon(hankoIcon(s));
  }
  if (changed) savePassed();
}

// 季節＝赤、名所＝紺、近所＝緑、道の駅＝茶。empty（まだ押していない）判定は呼び出し側で別に OFF_COLOR を使う
function stampColor(spot, isSeason) {
  const road = !isSeason && (spot.lists || []).length > 0 && spot.lists.every((l) => l === 'michinoeki');
  if (spot.kind === 'foodshop') return FOOD_COLOR;
  return isSeason ? SEAL_COLOR : road ? ROAD_COLOR : TIER_COLOR[spot.tier] || TIER_COLOR.list;
}
// その場所に付いた写真のうち一番新しいもの（写真の取り込み・記録でセットした印の photoId）。なければ null
function latestPhotoForSpot(spotId) {
  let best = null;
  for (const s of state.seals) {
    if (s.spotId !== spotId || !s.photoId) continue;
    if (!best || s.at > best.at) best = s;
  }
  return best;
}
// 種類のマーク（線画。色は文字色＝判子の色に合わせる）。24x24
const KIND_SVG = (() => {
  const s = (d) => `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return {
    shrine: s('M2.5 6.5c3.5 1.5 15.5 1.5 19 0M5 10.5h14M7 7v14M17 7v14M12 8v2.5'),
    temple: s('M12 3v18M3 12h18M12 3h5M21 12v5M12 21H7M3 12V7'),
    food: s('M6 3v7M9 3v7M12 3v7M6 10c0 2 1.5 3 3 3s3-1 3-3M9 13v8M18 21V3c-2 1-3.5 4-3.5 8h3.5'),
    onsen: s('M8 3c-1 1.5 1 2.5 0 4.5M12 3c-1 1.5 1 2.5 0 4.5M16 3c-1 1.5 1 2.5 0 4.5M4 12h16c0 4-2 8-8 8s-8-4-8-8z'),
    castle: s('M4 20h16M5 20V10h14v10M5 10V6h3v2h2V6h4v2h2V6h3v4M10 20v-4a2 2 0 0 1 4 0v4'),
    waterfall: s('M5 4h14M8 4v7M12 4v11M16 4v8M5 20c2-2 4-2 7 0s5 2 7 0'),
    mountain: s('M2.5 20 9 8l4 6 3-4.5 5.5 10.5z'),
    lighthouse: s('M8 21h8M9.5 21l1-12h3l1 12M10.5 9 12 5l1.5 4M4 6l3.5 1.5M20 6l-3.5 1.5'),
    museum: s('M3 9l9-5 9 5M5.5 10v8M10 10v8M14 10v8M18.5 10v8M3 20.5h18'),
    heritage: s('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c-3.5 3.5-3.5 14.5 0 18M12 3c3.5 3.5 3.5 14.5 0 18'),
    sight: s('M6 21V4M6 5h11l-2.5 3.5L17 12H6'),
    view: s('M2.5 18h19M6.5 18a5.5 5.5 0 0 1 11 0M12 6v3M4.5 9 6.5 11M19.5 9 17.5 11'),
    water: s('M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z'),
    festival: s('M9 3h6M8.5 5h7c2.2 2.5 2.2 11.5 0 14h-7c-2.2-2.5-2.2-11.5 0-14zM9.5 19.5h5M12 19.5V22M7.8 9h8.4M7.8 14.5h8.4'),
    pin: s('M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'),
  };
})();
function kindMark(spot) {
  const el = h('span', { class: 'kmark' });
  el.innerHTML = KIND_SVG[markKindOf(spot)] || KIND_SVG.pin;
  return el;
}
// 濃さ（回数の段階）に合わせた色。1回は少し淡く、回数が増えるほど濃く、10回以上は暗めに
const LEVEL_MIX = [0, 68, 84, 100, 100];
function levelColor(color, lv) {
  if (lv >= 4) return `color-mix(in srgb, ${color} 78%, #000)`;
  return LEVEL_MIX[lv] >= 100 ? color : `color-mix(in srgb, ${color} ${LEVEL_MIX[lv] || 100}%, #fff)`;
}
function hankoIcon(spot, far = false) {
  const isSeason = !!spot.seasons;
  const mine = isSeason ? seasonalVisitsOf(spot.id) : visitsOf(spot.id);
  // 季節の名所は、見頃の月だけ赤。見頃でない月にまだ押していなければ灰色（見頃でないのに赤く出ていて紛らわしかった）
  const off = isSeason && !mine.length && !seasonOf(spot, now());
  const went = !mine.length && !!passed()[spot.id];
  // 濃さ：判子の数（押した場所は通った回数も足す）。通っただけなら通った回数
  const lv = visitLevel(mine.length ? mine.length + passCountOf(spot.id) : went ? passCountOf(spot.id) : 0);
  const baseColor = off ? OFF_COLOR : stampColor(spot, isSeason);
  const color = mine.length && lv ? levelColor(baseColor, lv) : baseColor;
  const cls = ['hanko', isSeason ? 'season' : '', off ? 'off' : '', spot.tier === 'near' ? 'near' : '', mine.length ? '' : 'empty', went ? 'passed' : '', mine.length ? 'dbl' : '', lv ? 'lv' + lv : '', far && !mine.length && !went ? 'far' : ''].filter(Boolean).join(' ');
  const mark = isSeason ? spot.seasons[0].mark : null;
  const markEl = () => (isSeason && spot.kind !== 'festival' ? h('span', {}, mark) : kindMark(spot));
  // 押した場所に写真が付いていれば、文字の代わりに丸く切り抜いた写真を敷く（枠の色はそのまま残す）
  const photoSeal = mine.length ? latestPhotoForSpot(spot.id) : null;
  const face = photoSeal ? h('div', { class: 'face photo' }) : h('div', { class: 'face' }, markEl());
  if (photoSeal) attachPhotoBg(face, photoSeal.photoId);
  const node = mine.length
    ? h('div', { class: cls, style: `--c:${color}` }, face, mine.length >= 2 ? h('span', { class: 'cnt' }, mine.length) : null)
    : h('div', { class: cls, style: `--c:${color}` }, h('span', { class: 'g' }, markEl()));
  return L.divIcon({ className: 'hanko-wrap', html: node, iconSize: [40, 40], iconAnchor: [20, 20] });
}

// ---------- 地図（ホーム） ----------
let mainMap = null; let layer = null; let posDot = null; let card = null;
const markers = new Map();
function closeCard() { if (card) { card.remove(); card = null; } }

function initMap() {
  if (typeof L === 'undefined') {
    mapEl.replaceChildren(h('p', { class: 'muted', style: 'padding:80px 16px' }, '地図を読み込めませんでした（通信を確認してください）'));
    return;
  }
  mainMap = L.map(mapEl, { zoomControl: false });
  L.control.zoom({ position: 'topright' }).addTo(mainMap);
  setBaseLayer(mainMap, false); // 最初は東京（日本）から
  mainMap.attributionControl.addAttribution(WD_ATTR);
  layer = L.layerGroup().addTo(mainMap);
  mainMap.setView([TOKYO.lat, TOKYO.lng], 12);
  mainMap.on('moveend', () => {
    const c = mainMap.getCenter();
    setBaseLayer(mainMap, isOutsideJapan(c.lat, c.lng));
    scheduleDraw();
  });
  mainMap.on('dragstart', () => setFollow(false));
  mainMap.getContainer().addEventListener('wheel', () => setFollow(false), { passive: true });
  mainMap.on('click', closeCard);
}

let drawTimer = 0; let drawSeq = 0;
function scheduleDraw() { clearTimeout(drawTimer); drawTimer = setTimeout(drawMap, 150); }

async function drawMap() {
  if (!mainMap) return;
  const seq = ++drawSeq;
  const b = mainMap.getBounds();
  const z = mainMap.getZoom();
  const nearOk = modeAllows({ tier: 'near' }, state.mode);
  // 祭りは数が多いので、ユネスコの祭り・日本三大祭と判子を押した祭りのほかは、寄ったとき（z9〜）だけ出す
  const seasons = state.seasonSpots.filter((s) => Number.isFinite(s.lat) && b.contains([s.lat, s.lng]) && modeAllows(s, state.mode)
    && (s.kind !== 'festival' || z >= 9 || s.lists.includes('yama') || visitsOf(s.id).length > 0));
  // ご当地グルメのお店（ナイフとフォークのマーク）。寄ったとき（MIN_ZOOM_SHOP 以上）だけ、見えている範囲のものを出す
  const shops = z >= MIN_ZOOM_SHOP ? state.shopSpots.filter((s) => b.contains([s.lat, s.lng])).slice(0, 150) : [];
  let list; let groups;
  if (z < MIN_ZOOM_ALL) {
    // 大きく引いたとき：区画は読まず、meta の件数をまとめて丸で出す。季節の名所だけは1つずつ
    list = [...seasons, ...shops];
    groups = tileGroups(b, z, nearOk);
  } else {
    const keys = tilesForBounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
    await ensureTiles(keys);
    if (seq !== drawSeq) return;
    const inView = spotsIn(keys).filter((s) => b.contains([s.lat, s.lng]) && modeAllows(s, state.mode));
    // 一覧の場所は1つずつ。近所の場所は寄るまで（MIN_ZOOM_NEAR）近いものをまとめて数で出す
    // 押した・通った近所の場所は、寄っていなくても1つずつ出す（数の丸に埋もれていた）
    const mineNear = (s) => s.tier === 'near' && (visitsOf(s.id).length > 0 || !!passed()[s.id]);
    // 前の版で「通った」にした場所は位置を持っていないので、区画を読んだときに足しておく（引いた地図で描けるように）
    const p = passed(); const pp = passedPos(); let filled = false;
    for (const s of inView) if (p[s.id] && !pp[s.id]) { pp[s.id] = [s.lat, s.lng]; filled = true; }
    if (filled) savePassed();
    list = [...inView.filter((s) => s.tier !== 'near' || z >= MIN_ZOOM_NEAR || mineNear(s)), ...seasons, ...shops].slice(0, 550);
    groups = z >= MIN_ZOOM_NEAR ? [] : pixelGroups(inView.filter((s) => s.tier === 'near' && !mineNear(s)), z);
  }
  if (seq !== drawSeq) return;
  layer.clearLayers();
  markers.clear();
  for (const g of groups) {
    L.marker([g.lat, g.lng], { icon: groupIcon(g.n), title: `${g.n} か所`, zIndexOffset: -1000 })
      .on('click', () => mainMap.setView([g.lat, g.lng], z < MIN_ZOOM_ALL ? Math.min(z + 3, MIN_ZOOM_ALL) : MIN_ZOOM_NEAR, { animate: !reduceMotion() }))
      .addTo(layer);
  }
  // とても引いているときは、季節の名所は小さな赤い点にする（大きな判子だと数の丸を隠す）
  const dot = z < 8;
  for (const s of list) {
    const icon = dot ? L.divIcon({ className: 'hanko-wrap', html: h('div', { class: 'sdot' + (visitsOf(s.id).length ? ' got' : '') }), iconSize: [12, 12], iconAnchor: [6, 6] }) : hankoIcon(s, z < MIN_ZOOM_ALL);
    const m = L.marker([s.lat, s.lng], { icon, title: s.name }).on('click', () => showCard(s));
    m.addTo(layer);
    markers.set(s.id, m);
  }
  // 大きく引いたときも、判子を押した場所は数の丸に埋もれないよう、塗りつぶした丸で一番上に出す
  if (z < MIN_ZOOM_ALL) {
    const shown = dot ? new Set() : new Set(list.map((s) => s.id));
    // 通っただけの場所は白抜きの輪（押した場所より下、数の丸より上）
    for (const g of myPassedGroups(b, z, shown)) {
      // 数が多いほど大きく（押した丸と同じ升に重なっても、外側に輪がのぞくように）
      const size = g.n > 1 ? Math.min(34, Math.round(20 + 3 * Math.log2(g.n))) : 12;
      L.marker([g.lat, g.lng], {
        icon: L.divIcon({ className: 'hanko-wrap', html: h('div', { class: 'mypass lv' + visitLevel(g.cnt), style: `--c:${g.color};width:${size}px;height:${size}px` }, g.n > 1 ? String(g.n) : ''), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        title: g.n > 1 ? `通った ${g.n} か所` : `${g.name}（通った）`, zIndexOffset: 500,
      }).on('click', () => mainMap.setView([g.lat, g.lng], Math.min(z + 3, MIN_ZOOM_ALL), { animate: !reduceMotion() }))
        .addTo(layer);
    }
    for (const g of myStampGroups(b, z, shown)) {
      const size = g.n > 1 ? 22 : 16;
      L.marker([g.lat, g.lng], {
        icon: L.divIcon({ className: 'hanko-wrap', html: h('div', { class: 'mydot lv' + visitLevel(g.cnt), style: `--c:${g.color};width:${size}px;height:${size}px` }, g.n > 1 ? String(g.n) : ''), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        title: g.n > 1 ? `判子 ${g.n} か所` : g.name, zIndexOffset: 1000,
      }).on('click', () => (g.n === 1 && g.spot ? showCard(g.spot) : mainMap.setView([g.lat, g.lng], Math.min(z + 3, MIN_ZOOM_ALL), { animate: !reduceMotion() })))
        .addTo(layer);
    }
  }
}

// 判子を押した場所を、画面で 18px 四方の升ごとにまとめる（引いた地図で重ならないように）。
// 区画を読んでいない近所の場所は、判子を押したときの位置を使う。skip は判子の絵で出している場所
function myStampGroups(b, z, skip) {
  const bySpot = new Map();
  for (const v of state.visits) {
    if (skip.has(v.spotId) || bySpot.has(v.spotId)) continue;
    const spot = spotById(v.spotId);
    const lat = spot && Number.isFinite(spot.lat) ? spot.lat : v.lat;
    const lng = spot && Number.isFinite(spot.lng) ? spot.lng : v.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !b.pad(0.1).contains([lat, lng])) continue;
    bySpot.set(v.spotId, { spot, lat, lng, cnt: visitsOf(v.spotId).length + passCountOf(v.spotId) });
  }
  return cellGroups(bySpot, z);
}

// 通っただけ（判子はまだ）の場所を、同じように升ごとにまとめる。位置は「通った」に保存したもの、なければ場所のデータ
function myPassedGroups(b, z, skip) {
  const stamped = new Set(state.visits.map((v) => v.spotId));
  const pp = passedPos();
  const bySpot = new Map();
  for (const id of Object.keys(passed())) {
    if (skip.has(id) || stamped.has(id)) continue;
    const spot = spotById(id);
    const ll = pp[id] || (spot && Number.isFinite(spot.lat) ? [spot.lat, spot.lng] : null);
    if (!ll || !b.pad(0.1).contains(ll)) continue;
    bySpot.set(id, { spot, lat: ll[0], lng: ll[1], cnt: passCountOf(id) });
  }
  return cellGroups(bySpot, z);
}

function cellGroups(bySpot, z) {
  const cells = new Map();
  for (const [id, it] of bySpot) {
    const p = mainMap.project([it.lat, it.lng], z);
    const ck = `${Math.floor(p.x / 18)}_${Math.floor(p.y / 18)}`;
    const c = cells.get(ck) || { n: 0, cnt: 0, lat: 0, lng: 0, spot: null, name: '', color: '' };
    c.n++; c.lat += it.lat; c.lng += it.lng; c.cnt += it.cnt || 1;
    if (!c.spot) { c.spot = it.spot; c.name = it.spot ? it.spot.name : id; c.color = it.spot ? stampColor(it.spot, !!it.spot.seasons) : TIER_COLOR.near; }
    cells.set(ck, c);
  }
  return [...cells.values()].map((c) => ({ ...c, lat: c.lat / c.n, lng: c.lng / c.n }));
}

// まとめの丸。点線の丸に数を出す（まだ押していない場所の点線の判子と同じ見た目）
function groupIcon(n) {
  const size = n >= 1000 ? 44 : n >= 100 ? 36 : 28;
  const label = n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return L.divIcon({ className: 'hanko-wrap', html: h('div', { class: 'group', style: `width:${size}px;height:${size}px` }, label), iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// 大きく引いたとき：区画（0.5度）の件数を、ズームに合わせた大きさの升でまとめる。位置は件数で重みをつけた区画の中心
function tileGroups(b, z, nearOk) {
  const cell = 0.5 * 2 ** Math.max(0, 8 - z);
  const cells = new Map();
  for (const [k, [nl, nn]] of Object.entries(state.tileCounts || {})) {
    const n = nl + (nearOk ? nn : 0);
    if (!n) continue;
    const [lat0, lng0] = k.split('_').map(Number);
    const lat = lat0 + 0.25; const lng = lng0 + 0.25;
    if (!b.pad(0.2).contains([lat, lng])) continue;
    const ck = `${Math.floor(lat / cell)}_${Math.floor(lng / cell)}`;
    const c = cells.get(ck) || { n: 0, lat: 0, lng: 0 };
    c.n += n; c.lat += lat * n; c.lng += lng * n;
    cells.set(ck, c);
  }
  return [...cells.values()].map((c) => ({ n: c.n, lat: c.lat / c.n, lng: c.lng / c.n }));
}

// 中くらいのズーム：画面で 96px 四方の升ごとに近所の場所をまとめる
function pixelGroups(spots, z) {
  const cells = new Map();
  for (const s of spots) {
    const p = mainMap.project([s.lat, s.lng], z);
    const ck = `${Math.floor(p.x / 96)}_${Math.floor(p.y / 96)}`;
    const c = cells.get(ck) || { n: 0, lat: 0, lng: 0 };
    c.n++; c.lat += s.lat; c.lng += s.lng;
    cells.set(ck, c);
  }
  return [...cells.values()].map((c) => ({ n: c.n, lat: c.lat / c.n, lng: c.lng / c.n }));
}

// 名所の写真と説明（data/photos/<0〜15>.json：id の数字 % 16 の分だけ読む）。出典は Wikimedia Commons（作者・ライセンスつき）と Wikidata（説明文・CC0）
const COMMONS_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/';
const photoShards = new Map();
async function spotInfoOf(id) {
  if (!/^Q[0-9]+$/.test(id || '')) return null;
  const n = Number(id.slice(1)) % 16;
  if (!photoShards.has(n)) photoShards.set(n, fetchJson(`data/photos/${n}.json`, {}));
  const e = (await photoShards.get(n))[id];
  return e ? { thumb: e[0] ? COMMONS_THUMB + e[0] : '', author: e[1] || '', license: e[2] || '', desc: e[3] || '' } : null;
}
// サムネイルのパスから Commons のファイル名（'thumb/a/ab/名前.jpg/640px-名前.jpg' か 'a/ab/名前.jpg'）
const commonsFileOf = (thumbUrl) => { const p = thumbUrl.slice(COMMONS_THUMB.length).split('/'); try { return decodeURIComponent(p[0] === 'thumb' ? p[3] : p[2]); } catch { return ''; } };
// 写真・作者・ライセンスと説明。データに無い場所・読めない場所は何も出さない（あとから埋める）
// 日本語に訳した名前の、元の名前（英語など）。訳していなければ空
function origNameOf(id) { return (state.origNames && (state.origNames.get(id) || state.origNames.get(String(id).replace(/^f_/, '')))) || ''; }
function origNameEl(id, name) {
  const o = origNameOf(id);
  return o && o !== name ? h('div', { class: 'muted', style: 'font-size:12px;margin:0 0 2px;word-break:break-word' }, o) : null;
}
function spotInfoEl(spot) {
  const box = h('div', { class: 'spotinfo' });
  spotInfoOf(spot && spot.id).then((info) => {
    if (!info) return;
    if (info.thumb) {
      const file = commonsFileOf(info.thumb);
      const img = h('img', { src: info.thumb, alt: spot.name, loading: 'lazy', width: 640, onerror: () => fig.remove() });
      const credit = () => ['写真：', info.author || '作者不明', info.license ? `（${info.license}）` : '', '　',
        file ? h('a', { href: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_')), target: '_blank', rel: 'noopener' }, 'Wikimedia Commons') : 'Wikimedia Commons'];
      viewable(img, () => [{ src: info.thumb, caption: [h('b', {}, spot.name), h('br'), ...credit()] }]);
      const fig = h('figure', { class: 'spotphoto' }, img, h('figcaption', {}, ...credit()));
      box.append(fig);
    }
    // 説明文は日本語のものだけ出す（英語のまま残ったものは出さない。build-names-ja.mjs で訳している）
    if (info.desc && /[ぁ-んァ-ン一-龥]/.test(info.desc)) box.append(h('p', { class: 'muted', style: 'margin:4px 0' }, info.desc));
  });
  return box;
}
// ---------- 写真ビューア ----------
// 写真を画面いっぱいに（黒い背景）。items: [{ photoId | src, date?, spotId?, lat?, lng?, caption? }]。
// 複数あれば左右になでて次の写真へ、ピンチ・ダブルタップで拡大（拡大中は指で動かす）、× か下へなでて閉じる。
// 下に「撮った日（押した日）」と、日記へ・地図で見るを出す。名所の写真（Commons）は caption に作者・ライセンスを入れる
let viewerEl = null;
let viewerKey = null;
function closeViewer() {
  if (!viewerEl) return;
  viewerEl.remove(); viewerEl = null;
  document.removeEventListener('keydown', viewerKey); viewerKey = null;
}
function openViewer(items, start = 0) {
  closeViewer();
  if (!items.length) return;
  let idx = Math.max(0, Math.min(items.length - 1, start));
  const track = h('div', { class: 'vtrack' });
  const slides = items.map((it) => {
    const img = h('img', { class: 'vimg', alt: '', draggable: 'false' });
    (it.src ? Promise.resolve(it.src) : photoSrc(it.photoId)).then((u) => { if (u) img.src = u; });
    return h('div', { class: 'vslide' }, img);
  });
  track.append(...slides);
  const count = h('div', { class: 'vcount' });
  const info = h('div', { class: 'vinfo' });
  const paint = () => {
    const it = items[idx];
    count.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
    const canMap = it.spotId && (Number.isFinite(it.lat) || spotById(it.spotId));
    info.replaceChildren(
      it.date ? h('div', { class: 'vdate' }, fmtDate(it.date)) : null,
      it.caption ? h('div', { class: 'vcap' }, it.caption) : null,
      it.date || canMap ? h('div', { class: 'vbtns' },
        it.date ? h('button', { class: 'btn', type: 'button', onclick: () => { closeViewer(); closeSheet(); openDiaryOn(it.date); } }, '日記へ') : null,
        canMap ? h('button', { class: 'btn', type: 'button', onclick: () => { closeViewer(); showOnMap(it.spotId, it.lat, it.lng); } }, '地図で見る') : null) : null);
  };
  const close = h('button', { class: 'vclose', type: 'button', 'aria-label': '閉じる', onclick: closeViewer }, '×');
  viewerEl = h('div', { class: 'viewer', role: 'dialog', 'aria-label': '写真' }, track, count, close, info);
  document.body.append(viewerEl);
  track.scrollLeft = idx * track.clientWidth;
  paint();
  // 何枚目か（なでて止まった位置）
  let timer = 0;
  track.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); if (i !== idx && i >= 0 && i < items.length) { idx = i; reset(); paint(); } }, 80);
  });
  // 拡大（ピンチ・ダブルタップ）と、下へなでて閉じる
  let z = { s: 1, x: 0, y: 0 };
  const ptrs = new Map(); let pinch = null; let drag = null; let closeDy = 0; let lastTap = 0;
  const apply = () => { slides[idx].firstChild.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`; track.classList.toggle('zoomed', z.s > 1.02); };
  function reset() { z = { s: 1, x: 0, y: 0 }; slides.forEach((sl) => { sl.firstChild.style.transform = ''; }); track.classList.remove('zoomed'); }
  const setViewerY = (dy) => { viewerEl.style.transform = dy ? `translateY(${dy}px)` : ''; viewerEl.style.opacity = dy ? String(Math.max(0.3, 1 - dy / 400)) : ''; };
  track.addEventListener('pointerdown', (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: z.s }; drag = null; } else if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, zx: z.x, zy: z.y, t: Date.now() };
  });
  track.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      z.s = Math.max(1, Math.min(4, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      if (z.s <= 1.02) { z.x = 0; z.y = 0; }
      apply();
    } else if (drag && ptrs.size === 1) {
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      if (z.s > 1.02) { z.x = drag.zx + dx; z.y = drag.zy + dy; apply(); } else if (dy > 12 && dy > Math.abs(dx) * 1.5) { closeDy = dy; setViewerY(dy); }
    }
  });
  const up = (e) => {
    const was = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) {
      if (closeDy > 110) { closeViewer(); return; }
      if (closeDy) { closeDy = 0; setViewerY(0); }
      // ダブルタップで 2.5 倍 / 元に戻す
      if (e.type === 'pointerup' && drag && was && Math.hypot(was.x - drag.x, was.y - drag.y) < 8 && Date.now() - drag.t < 300) {
        if (Date.now() - lastTap < 350) { lastTap = 0; if (z.s > 1.02) reset(); else { z = { s: 2.5, x: 0, y: 0 }; apply(); } } else lastTap = Date.now();
      }
      if (z.s <= 1.02) reset();
      drag = null;
    }
  };
  track.addEventListener('pointerup', up);
  track.addEventListener('pointercancel', up);
  viewerKey = (e) => {
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight' && idx < items.length - 1) track.scrollTo({ left: (idx + 1) * track.clientWidth, behavior: 'auto' });
    else if (e.key === 'ArrowLeft' && idx > 0) track.scrollTo({ left: (idx - 1) * track.clientWidth, behavior: 'auto' });
  };
  document.addEventListener('keydown', viewerKey);
}
// 写真（img）を押すとビューアで開く。items は押した時点で作る
function viewable(img, makeItems, index = 0) {
  img.style.cursor = 'zoom-in';
  img.addEventListener('click', () => openViewer(makeItems(), index));
  return img;
}
const itemOfSeal = (s) => ({ photoId: s.photoId, date: s.at, spotId: s.spotId || null, lat: s.lat, lng: s.lng, caption: (s.spotId && (spotById(s.spotId) || {}).name) || null });
const itemOfMeal = (m) => ({ photoId: m.photoId, date: m.at, caption: `ご当地　${m.name}` });

// 自分の記録：その場所で撮った自分の写真（印に付いたもの）を横に並べる。押すとビューアで大きく。無ければ null
function myPhotosEl(spotId) {
  const seals = state.seals.filter((s) => s.spotId === spotId && s.photoId).sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!seals.length) return null;
  return h('div', { class: 'myphotos' }, seals.map((s, i) => viewable(imgFor(s.photoId, 'myph'), () => seals.map(itemOfSeal), i)));
}
// 地図のその場所へ移って、カードを開く。区画をまだ読んでいない遠い場所は、読んでから。場所のデータが無くても位置があればそこへ寄る
async function showOnMap(spotId, lat, lng) {
  const s0 = spotById(spotId);
  const la = s0 && Number.isFinite(s0.lat) ? s0.lat : lat;
  const ln = s0 && Number.isFinite(s0.lng) ? s0.lng : lng;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  closePopup(); closeSheet(); closeCard(); masuDetail = null;
  await ensureTiles(tilesForBounds(la - 0.01, ln - 0.01, la + 0.01, ln + 0.01));
  const s = spotById(spotId);
  if (s && Number.isFinite(s.lat)) focusSpot(s);
  else if (mainMap) { setFollow(false); mainMap.setView([la, ln], Math.max(mainMap.getZoom(), 15), { animate: !reduceMotion() }); }
  return true;
}
// 判子を押した日のボタン（押すと日記のその日へ）。押していなければ null
function openDiaryOn(date) {
  closePopup(); closeCard(); masuDetail = null; diaryPick = null;
  diaryYM = { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) }; diaryDay = date; openDiary();
}
// 2回以上押した場所だけ、日付の一覧を出す（1回なら「日記」ボタンだけ）
function stampDatesEl(spotId) {
  const dates = stampDatesOf(state.visits, spotId);
  if (dates.length < 2) return null;
  return h('div', { class: 'stampdates' }, dates.map((date) => h('button', {
    class: 'stampdate', type: 'button', 'data-date': date, onclick: () => openDiaryOn(date),
  }, `${date} に押した`)));
}
// 押してある場所のときだけ「日記 12/23」（いちばん新しい日の日記を開く）。押していなければ null
function diaryBtn(spotId, style = '') {
  const dates = stampDatesOf(state.visits, spotId);
  if (!dates.length) return null;
  const d = dates[0];
  return h('button', { class: 'btn diarybtn', type: 'button', style, onclick: () => openDiaryOn(d) }, `日記 ${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`);
}
function showCard(spot) {
  closeCard();
  const d = now();
  const season = seasonOf(spot, d);
  const pos = state.pos;
  const dist = pos ? distanceMeters(pos, spot) : null;
  const mine = visitsOf(spot.id);
  card = h('div', { class: 'spotcard' },
    h('button', { class: 'cardx', type: 'button', 'aria-label': '閉じる', onclick: closeCard }, '×'),
    h('h3', {}, spot.name),
    origNameEl(spot.id, spot.name),
    h('p', { class: 'sub', style: 'margin:2px 0 6px' },
      spotTags(spot).map((t) => h('span', { class: 'tag t-' + spot.tier }, t)),
      spot.seasons ? h('span', { class: 'tag season' }, `${spot.seasons[0].months.map((m) => m + '月').join('・')} ${spot.seasons[0].label}`) : null,
      spot.pref ? ` ${spot.pref}` : '', dist !== null ? `　${fmtDist(dist)}` : ''),
    spot.note ? h('p', { style: 'margin:4px 0' }, spot.note) : null,
    spot.foodKeys ? h('p', { style: 'margin:4px 0' }, `食べられる料理：${foodNamesOf(spot)}。押すと「食べた」記録も付きます。`) : null,
    spotInfoEl(spot),
    bestMonthsOf(spot) ? h('p', { class: 'muted', style: 'margin:4px 0' }, `ベストシーズン ${formatBestMonths(bestMonthsOf(spot))}`) : null,
    season ? h('p', { class: 'muted', style: 'margin:4px 0' }, `いまは見頃（${season.label}）。ここで押すと季節の判子です。`) : null,
    h('p', { class: 'muted', style: 'margin:4px 0' }, mine.length ? `判子 ${mine.length} 回` : 'まだ判子はありません'),
    stampDatesEl(spot.id),
    myPhotosEl(spot.id),
    h('div', { style: 'display:flex;gap:8px;margin-top:6px' },
      h('button', { class: 'btn primary', type: 'button', style: 'flex:1', onclick: () => stamp(spot) }, '判子を押す'),
      diaryBtn(spot.id)),
    h('div', { style: 'display:flex;gap:8px;margin-top:6px' },
      h('a', { class: 'btn', href: gmapUrl(spot), target: '_blank', rel: 'noopener', style: 'display:inline-flex;align-items:center;text-decoration:none;color:inherit' }, 'Googleマップで開く'),
      h('a', { class: 'btn', href: gmapUrl(spot, true), target: '_blank', rel: 'noopener', style: 'display:inline-flex;align-items:center;text-decoration:none;color:inherit' }, '経路')));
  document.body.append(card);
}

// Google マップの URL（アプリがあればアプリで開く）。
// 開く：座標だけ渡すと名前のない「ピン」が開くので、名前でその場所のまわりを検索する（同じ名前の神社が多くても、近くのものが出る）
// 経路：行き先は座標で渡す（名前だと同名の別の場所への経路になりうる）
function gmapUrl(spot, route) {
  const ll = `${spot.lat},${spot.lng}`;
  return route
    ? `https://www.google.com/maps/dir/?api=1&destination=${ll}`
    : `https://www.google.com/maps/search/${encodeURIComponent(spot.name)}/@${ll},17z`;
}

// 場所の札：OSM の場所は種類（神社・銭湯・灯台など）、一覧の場所は入っている一覧の名前（季節の名所は別の札で出すので除く）
function spotTags(spot) {
  if (NEAR_KINDS[spot.kind]) return [NEAR_KINDS[spot.kind]];
  if (spot.kind === 'foodshop') return ['ご当地のお店'];
  if (spot.kind === 'festival') return ['祭り', ...(spot.lists || []).filter((k) => k === 'yama').map(() => 'ユネスコ 山・鉾・屋台行事')];
  return (spot.lists || []).filter((k) => k !== 'seasons').map((k) => (state.lists.find((l) => l.key === k) || {}).name).filter(Boolean);
}

// 世界遺産のベストシーズン（気候から行きやすい月。出典 NASA POWER）。世界遺産でないか、気候データがなければ null
function bestMonthsOf(spot) {
  if (!state.climate || !(spot.lists || []).includes('heritage')) return null;
  const key = state.climate.spots[spot.id];
  const grid = key && state.climate[key];
  return grid && grid.best && grid.best.length ? grid.best : null;
}

function setPosDot(pos) {
  if (!mainMap) return;
  if (posDot) posDot.setLatLng([pos.lat, pos.lng]);
  else posDot = L.circleMarker([pos.lat, pos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2f6fdb', fillOpacity: 1, interactive: false }).addTo(mainMap);
}

// ---------- 判子を押す ----------
let stamping = false;
// ---------- 効果音 ----------
// 音のファイルは持たず、Web Audio でその場で作る。iPhone はマナーモードだと鳴らないことがある
let audioCtx = null;
function sfx(kind) {
  if (!setting('sound')) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const tone = (freq, start, dur, vol, type = 'sine', endFreq = freq) => {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t + start); o.frequency.exponentialRampToValueAtTime(endFreq, t + start + dur);
      g.gain.setValueAtTime(0.0001, t + start); g.gain.exponentialRampToValueAtTime(vol, t + start + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g).connect(audioCtx.destination); o.start(t + start); o.stop(t + start + dur + 0.02);
    };
    if (kind === 'tap') tone(1400, 0, 0.04, 0.05, 'triangle', 900); // コッ
    else if (kind === 'stamp') { tone(180, 0, 0.18, 0.5, 'sine', 70); tone(900, 0, 0.05, 0.12, 'triangle', 400); } // ポン（木の判子）
    else if (kind === 'chime') { tone(1318, 0, 0.5, 0.12); tone(1760, 0.09, 0.6, 0.1); } // チリン
  } catch { /* 音を出せない端末では何もしない */ }
}
// ボタンを押したら小さく鳴らす（判子・お題の達成は別の音）
document.addEventListener('click', (e) => {
  const b = e.target.closest('button, .chip, .tab, label.btn');
  if (b && !b.dataset.sfx) sfx('tap');
}, true);

// 振動。Android は navigator.vibrate、iPhone の Safari は vibrate が無いので、
// スイッチ型のチェックボックス（Safari 18〜）を押すと軽く振動するのを使う（押した操作の流れの中でだけ効く）
let hapticEl = null;
function haptic(pattern = 60) {
  if (!setting('vibrate')) return;
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* 対応していなければ何もしない */ } return; }
  try {
    if (!hapticEl) {
      const input = h('input', { type: 'checkbox', switch: true, id: 'haptic-sw' });
      hapticEl = h('label', { for: 'haptic-sw', 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none' }, input);
      document.body.append(hapticEl);
    }
    hapticEl.click();
  } catch { /* 古い iPhone では振動しない */ }
}

async function stamp(spot) {
  if (stamping) return;
  if (stampedOn(state.visits, spot.id, now())) { toast('この場所の判子は今日もう押してあります'); return; }
  stamping = true;
  try {
    let pos = state.pos && Date.now() - state.posAt < 20000 ? state.pos : null;
    if (!pos) { toast('今いる場所を確かめています…'); pos = await getPos(8000, true); }
    if (!pos) { toast('今いる場所を取得できませんでした'); return; }
    const d = distanceMeters(pos, spot);
    if (!canStamp(spot, d, state.acc)) {
      toast(`もう少し近づいてください（あと ${fmtDist(Math.max(1, d - Math.max(50, spot.radius || 0)))}）`);
      updateNear();
      return;
    }
    const season = seasonOf(spot, now());
    const visit = { id: db.newId(), spotId: spot.id, at: now().getTime(), lat: pos.lat, lng: pos.lng, mode: state.mode, seasonal: !!season, source: 'tap' };
    await db.put('visits', visit);
    const shopN = await addShopMeals(spot, visit);
    const wasQuest = currentQuests().some((q) => q.id === spot.id);
    await loadData();
    closeCard();
    sfx('stamp');
    haptic(60);
    if (wasQuest) setTimeout(() => sfx('chime'), 350);
    await celebrate(spot);
    render();
    openStamped(spot, season);
    if (shopN) toast(`${spot.name}の判子と、${foodNamesOf(spot)}の記録を付けました`);
    updateNear();
  } catch (err) {
    toast('保存できませんでした：' + (err && err.message ? err.message : err));
  } finally {
    stamping = false;
  }
}

async function celebrate(spot) {
  if (!mainMap) return;
  const motion = !reduceMotion();
  await drawMap();
  const z = Math.max(mainMap.getZoom(), 14);
  if (motion) { mainMap.flyTo([spot.lat, spot.lng], z, { duration: 0.6 }); await sleep(750); } else mainMap.setView([spot.lat, spot.lng], z, { animate: false });
  await drawMap();
  const mk = markers.get(spot.id);
  const hk = mk && mk.getElement() && mk.getElement().querySelector('.hanko');
  if (hk && motion) { hk.classList.add('pop'); await sleep(550); }
}

function openStamped(spot, season) {
  const n = visitsOf(spot.id).length;
  showSheet(null, [
    h('h2', { style: 'font-size:22px;text-align:center;margin:0 0 4px' }, season ? `季節の判子（${season.label}）` : '判子を押しました'),
    h('p', { class: 'sub', style: 'text-align:center' }, `${spot.name}（${n}回目）`),
    h('p', { style: 'text-align:center;margin:8px 0 14px' }, '写真とひとこと、御朱印などの印を残せます。'),
    h('div', { style: 'display:flex;gap:8px;justify-content:center' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => { recordDraft.spotId = spot.id; openRecord(); } }, sealTypeFor(spot) ? '印・写真を記録する' : '写真・メモを残す'),
      h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'あとで')),
  ], () => sheetEl.classList.add('small'));
}

// ---------- 旅のしかた ----------
function drawModes() {
  modesEl.replaceChildren(...Object.entries(MODES).map(([k, m]) =>
    h('button', {
      class: 'mode' + (k === state.mode ? ' on' : ''), type: 'button', 'aria-pressed': String(k === state.mode),
      onclick: async () => { state.mode = k; await db.setSetting('mode', k); drawModes(); drawMap(); drawQuest(); updateNear(); },
    }, m.label, h('small', {}, modeSub(k)))));
}
// ボタンの下の小さい字：お題で回る時間（散歩・サイクリング）か、出す場所（旅行）。前は範囲の km を出していて意味が分かりにくかった
function modeSub(k) {
  if (k === 'walk') return `お題 歩いて${loopMinutes()}分`;
  if (k === 'bike') return `お題 自転車${loopMinutes()}分`;
  return '世界の名所';
}

// ---------- 今月のお題 ----------
// 見頃の名所（月のお題）に、散歩・サイクリングなら近所の「今日のお題」を足して最大5件
const QUEST_MAX = 5;
const sameDay = (v, d) => new Date(v.at).toDateString() === d.toDateString();
// 別のお題：今の旅のしかた・範囲・種類分けのまま、今のお題（今日押したものは残す）以外から選び直す。結果はその日の間は固定（保存は通常のお題と同じ）
function rerollQuests() {
  const d = now();
  if (!state.pos || !DAILY_MODES.includes(state.mode)) return;
  const key = LS + 'daily.' + state.mode + '.' + loopMinutes();
  const dayKey = d.toDateString();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* 読めなければ空 */ }
  if (!saved || saved.day !== dayKey || saved.mode !== state.mode || !Array.isArray(saved.items)) saved = { day: dayKey, mode: state.mode, items: [] };
  const monthly = monthlyQuests(state.seasonSpots, d, state.mode, state.pos);
  const today = new Set(); const before = new Set();
  for (const v of state.visits) (sameDay(v, d) ? today : before).add(v.spotId);
  const maxWant = Math.min(3, QUEST_MAX - monthly.length);
  const stamped = saved.items.filter((it) => today.has(it.id)); // 今日押したお題は残す
  if (stamped.length >= maxWant) { toast('今日のお題はもう全部押しました'); return; }
  // 数もランダムで選び直す（押した分より多く）
  const want = Math.min(maxWant, Math.max(dailyCount(todayStr(d), state.mode, String((saved.salt || 0) + 1)), stamped.length + 1));
  const need = want - stamped.length;
  const used = new Set([...monthly.map((s) => s.id), ...stamped.map((it) => it.id)]);
  const avoid = new Set([...used, ...saved.items.map((it) => it.id), ...(saved.avoid || [])]);
  const salt = String((saved.salt || 0) + 1);
  const pool = allLoaded().filter((s) => !used.has(s.id) && s.kind !== 'foodshop');
  const add = dailyQuests(pool, d, state.mode, state.pos, today, before, need, loopMinutes(), salt, avoid);
  if (!add.length) { toast('ほかの候補はありません'); return; }
  let items = [...stamped, ...add.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng }))];
  let loop = 0;
  if (LOOP_TARGET[state.mode] && items.length) { const r = bestLoop(state.pos, items); items = r.order; loop = r.meters; }
  // 直前のお題は、次の選び直しでもなるべく出さない（avoid に積む。多くなりすぎないよう直近だけ）
  const prevAvoid = [...(saved.avoid || []), ...saved.items.map((it) => it.id)].slice(-30);
  try { localStorage.setItem(key, JSON.stringify({ day: dayKey, mode: state.mode, items, loop, salt: Number(salt), avoid: prevAvoid })); } catch { /* 保存できなくても続ける */ }
  drawQuest(); if (!sheetEl.hidden) openQuests();
}
function currentQuests() {
  const d = now();
  const monthly = monthlyQuests(state.seasonSpots, d, state.mode, state.pos);
  const today = new Set(); const before = new Set();
  for (const v of state.visits) (sameDay(v, d) ? today : before).add(v.spotId);
  const used = new Set(monthly.map((s) => s.id));
  const maxWant = Math.min(3, QUEST_MAX - monthly.length);
  if (!state.pos || !DAILY_MODES.includes(state.mode) || maxWant <= 0) { state.dailyLoop = 0; return monthly; }
  // 同じ日・同じ旅のしかたなら、前に選んだお題を使う（開き直すと読み込んだ区画や位置の揺れで顔ぶれが変わっていた）。
  // 範囲の1.5倍より離れたものと、前に判子を押したものだけ入れ替える
  const dayKey = d.toDateString();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS + 'daily.' + state.mode + '.' + loopMinutes()) || 'null'); } catch { /* 読めなければ選び直す */ }
  if (!saved || saved.day !== dayKey || saved.mode !== state.mode || !Array.isArray(saved.items)) saved = { day: dayKey, mode: state.mode, items: [] };
  // 今日のお題の数は1〜3（日付と選び直しの回数で決まる）。少ない日は、その分遠くまで行ける
  const salt = saved.salt ? String(saved.salt) : '';
  const want = Math.min(dailyCount(todayStr(d), state.mode, salt), maxWant);
  const byId = new Map(allLoaded().map((s) => [s.id, s]));
  const limit = MODES[state.mode].range * 1.5;
  // 残すもの：範囲の1.5倍以内で、前の日に押していないもの。区画をまだ読んでいなければ、表示は待つが選び直さない
  const keepItems = saved.items.filter((it) => !used.has(it.id) && distanceMeters(state.pos, it) <= limit && !(before.has(it.id) && !today.has(it.id)));
  const kept = keepItems.filter((it) => byId.has(it.id)).map((it) => ({ ...byId.get(it.id), distance: distanceMeters(state.pos, it), daily: true }));
  const skip = new Set([...used, ...keepItems.map((it) => it.id)]);
  const need = want - keepItems.length;
  const add = need > 0 && byId.size ? dailyQuests(allLoaded().filter((s) => !skip.has(s.id) && s.kind !== 'foodshop'), d, state.mode, state.pos, today, before, need, loopMinutes(), salt, new Set(saved.avoid || [])) : [];
  // 回る順（選んだときの順）のまま
  let daily = [...kept, ...add];
  let loop = saved.loop || 0;
  if (add.length || keepItems.length !== saved.items.length) {
    let items = [...keepItems, ...add.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng }))];
    if (LOOP_TARGET[state.mode] && items.length) {
      const r = bestLoop(state.pos, items);
      items = r.order; loop = r.meters;
    }
    try { localStorage.setItem(LS + 'daily.' + state.mode + '.' + loopMinutes(), JSON.stringify({ day: dayKey, mode: state.mode, items, loop, salt: saved.salt || 0, avoid: saved.avoid || [] })); } catch { /* 保存できなくても続ける */ }
    const rank = new Map(items.map((it, i) => [it.id, i]));
    daily.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  } else {
    const rank = new Map(saved.items.map((it, i) => [it.id, i]));
    daily.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }
  state.dailyLoop = LOOP_TARGET[state.mode] && daily.length ? loop : 0;
  return [...monthly, ...daily];
}
// 回る道のりを「約2.5km・約3,600歩・約30分」に（散歩は時速5km、サイクリングは時速15km で歩数なし）
// 今日のお題の長さ（分）。設定で 15・30・60 から選ぶ。初期は 30
function loopMinutes() { try { const v = Number(localStorage.getItem(LS + 'loopmin')); return LOOP_MINUTE_CHOICES.includes(v) ? v : 30; } catch { return 30; } }
function setLoopMinutes(v) { try { localStorage.setItem(LS + 'loopmin', String(v)); } catch { /* 保存できなくても続ける */ } drawQuest(); drawModes(); }
const loopText = (m, mode = state.mode) => [`約${(m / 1000).toFixed(1)}km`, mode === 'walk' ? `約${(Math.round(m / STEP_METERS / 100) * 100).toLocaleString()}歩` : null, `約${Math.round(m / (LOOP_SPEED_KMH[mode] * 1000) * 60 / 5) * 5}分`].filter(Boolean).join('・');
function questDone(spot) {
  const d = now();
  if (spot.daily) return visitsOf(spot.id).some((v) => sameDay(v, d));
  return seasonalVisitsOf(spot.id).some((v) => sameMonth(v, d));
}
// 散歩・サイクリングは毎日変わるので「今日のお題」、旅行は見頃の名所なので「神無月のお題」（和風月名）
const questTitle = () => (DAILY_MODES.includes(state.mode) ? '今日のお題' : `${wafuMonth(now().getMonth() + 1)}のお題`);
const questMark = (s) => (s.daily ? '今日' : s.seasons[0].mark);
const questLabel = (s) => (s.daily ? `今日のお題・${spotTags(s)[0] || '近所'}` : s.seasons[0].label);
function drawQuest() {
  const d = now();
  const qs = currentQuests();
  const got = qs.filter(questDone).length;
  questEl.onclick = openQuests;
  questEl.setAttribute('aria-label', questTitle());
  questEl.replaceChildren(
    h('div', { class: 'qtop' },
      h('b', { class: 'qtitle' }, questTitle()),
      h('span', { class: 'muted' }, state.dailyLoop ? `回って戻ると${loopText(state.dailyLoop).split('・')[0]}` : qs.some((s) => s.daily) ? (qs.some((s) => !s.daily) ? 'いま見頃・近所' : '近所の今日のお題') : 'いま見頃の場所'),
      qs.length ? h('span', { class: 'qcount' }, `${got}/${qs.length}`) : null,
      state.pos && DAILY_MODES.includes(state.mode) ? h('button', { class: 'qreroll', type: 'button', 'aria-label': '別のお題', title: '別のお題', onclick: (e) => { e.stopPropagation(); rerollQuests(); } }, '🎲') : null),
    qs.length
      // 枠を押すとお題の一覧、1つの場所の札を押すとその場所のカード（お題の枠はボタンなので、札は div で受けて一覧を開かないようにする）
      ? h('div', { class: 'qrow' }, qs.map((s) => h('div', { class: 'qchip' + (questDone(s) ? ' got' : ''), role: 'button', tabindex: '0', 'aria-label': `${s.name}を地図で見る`,
        onclick: (e) => { e.stopPropagation(); focusSpot(s); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); focusSpot(s); } } },
        h('span', { class: 'qm' + (s.daily ? ' daily' : '') }, questMark(s)),
        h('span', { class: 'qn' }, s.name),
        s.distance !== null ? h('span', { class: 'qd' }, fmtDist(s.distance)) : null)))
      : h('p', { class: 'muted', style: 'margin:4px 0 0' }, state.pos
        ? `${MODES[state.mode].label}で行ける範囲（${fmtDist(MODES[state.mode].range)}）に、今月が見頃の名所はありません`
        : '今月が見頃の名所は、まだ登録がありません'));
}
function openQuests() {
  const qs = currentQuests();
  showSheet(openQuests, [
    h('h2', { style: 'font-size:20px;margin:0 0 4px' }, questTitle()),
    h('p', { class: 'sub' }, `見頃の月に行って判子を押すと、季節の判子になります。旅のしかた（${MODES[state.mode].label}）と今いる場所に合わせて並べています。${DAILY_MODES.includes(state.mode) ? '散歩・サイクリングでは、近くのまだ行っていない場所から「今日のお題」も毎日選びます（ご飯・寺社・その他から1つずつ）。' : ''}`),
    state.dailyLoop ? h('p', { class: 'sub' }, `今日の${state.mode === 'walk' ? '散歩' : 'サイクリング'}：上から順に回って戻ると ${loopText(state.dailyLoop)}（${state.mode === 'walk' ? '少し速めに歩いて時速5km' : 'ゆっくり時速15km'}、道は直線の1.25倍で見積もり）。毎日続ける運動として約${loopMinutes()}分にしています（長さは設定で変えられます）。厚生労働省のガイドでは、普段の生活の動き（1日60分・約8,000歩）に加えて、息が弾む程度の運動を週60分以上が目安です。`) : null,
    h('ul', { class: 'list' }, qs.map((s) => h('li', {},
      h('button', { class: 'rec nophoto', type: 'button', onclick: () => { closeSheet(); focusSpot(s); } },
        h('div', {},
          h('div', { class: 't' }, `${s.name}　${questLabel(s)}${questDone(s) ? '（押した）' : ''}`),
          h('div', { class: 'n' }, [s.pref, s.distance !== null ? fmtDist(s.distance) : ''].filter(Boolean).join('・')),
          s.note ? h('div', { class: 'n', style: 'white-space:normal' }, s.note) : null))))),
    qs.length ? null : h('p', { class: 'muted' }, '今月が見頃の名所は、まだ登録がありません。'),
    state.pos && DAILY_MODES.includes(state.mode) ? h('button', { class: 'btn', type: 'button', style: 'margin-top:10px', onclick: rerollQuests }, '🎲 別のお題（今日押した分は残します）') : null,
  ]);
}

function focusSpot(s) {
  if (!mainMap || !Number.isFinite(s.lat)) return;
  setFollow(false);
  mainMap.setView([s.lat, s.lng], Math.max(mainMap.getZoom(), 14), { animate: !reduceMotion() });
  setTimeout(() => showCard(s), 100);
}

// ---------- 近づいたら知らせる ----------
let watchId = null; let nearSig = ''; let follow = true;
function setFollow(on) { follow = on; locateEl.classList.toggle('on', on); }
locateEl.addEventListener('click', async () => {
  closeCard();
  const pos = state.pos && Date.now() - state.posAt < 20000 ? state.pos : await getPos(8000);
  if (!pos) { toast('今いる場所を取得できませんでした（位置情報の許可を確かめてください）'); return; }
  setFollow(true);
  setPosDot(pos);
  if (mainMap) mainMap.setView([pos.lat, pos.lng], Math.max(mainMap.getZoom(), 15), { animate: !reduceMotion() });
  startWatch();
  drawQuest();
});
// 位置の履歴（直近5分）。自動の判子の「しばらくいた」の判定に使う
function pushFix(speed) {
  const t = Date.now();
  state.fixes.push({ lat: state.pos.lat, lng: state.pos.lng, acc: state.acc, at: t, speed: Number.isFinite(speed) ? speed : null });
  state.fixes = state.fixes.filter((f) => t - f.at <= 5 * 60000);
}
// 日ごとの移動距離 { 'YYYY-MM-DD': { walk, bike, trip } }（m）。アプリを開いている間の位置から積む
const dist = { days: {}, track: {}, dirty: false };
async function loadDist() { dist.days = (await db.getSetting('dist', {})) || {}; }
function trackFix(fix) {
  const mode = state.mode;
  const before = dist.track[mode] || {};
  const next = addTrack(before, fix);
  // 旅のしかたを変えたら、ほかの旅のしかたの続きは切る
  for (const k of Object.keys(dist.track)) if (k !== mode) dist.track[k] = {};
  dist.track[mode] = next;
  const add = next.meters - (before.meters || 0);
  if (add > 0) {
    const day = todayStr(now());
    const rec = dist.days[day] || (dist.days[day] = {});
    rec[mode] = Math.round((rec[mode] || 0) + add);
    dist.dirty = true;
  }
}
async function saveDist() { if (!dist.dirty) return; dist.dirty = false; try { await db.setSetting('dist', dist.days); } catch { dist.dirty = true; } }
setInterval(saveDist, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDist(); });
// 日記の1日の距離：「散歩 2.4km（約3,400歩）・サイクリング 7.1km」
function distText(rec) {
  if (!rec) return '';
  const km = (m) => `${(m / 1000).toFixed(1)}km`;
  return [
    rec.walk >= 50 ? `散歩 ${km(rec.walk)}（約${(Math.round(rec.walk / STEP_METERS / 100) * 100).toLocaleString()}歩）` : null,
    rec.bike >= 50 ? `サイクリング ${km(rec.bike)}` : null,
    rec.trip >= 50 ? `旅行の移動 ${km(rec.trip)}` : null,
  ].filter(Boolean).join('・');
}

function onWatch(p) {
  state.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
  state.acc = p.coords.accuracy;
  state.posAt = Date.now();
  pushFix(p.coords.speed);
  trackFix({ ...state.pos, acc: state.acc, at: state.posAt });
  setPosDot(state.pos);
  if (mainMap && follow && sheetEl.hidden && !stamping) mainMap.panTo([state.pos.lat, state.pos.lng], { animate: !reduceMotion() });
  updateNear();
  autoStamp();
}
// 止まっていると watchPosition は呼ばれないので、30秒ごとに今の位置を履歴に足して「しばらくいた」を数える
setInterval(() => {
  if (watchId === null || !state.pos || document.visibilityState !== 'visible') return;
  pushFix(null);
  autoStamp();
}, 30000);
function startWatch() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onWatch, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopWatch() {
  if (watchId === null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  state.fixes = []; // 間が空くと「しばらくいた」が狂うので捨てる
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { stopWatch(); return; }
  if (!welcomed()) return;
  startWatch();
  getPos(6000, true).then((pos) => {
    if (!pos) return;
    pushFix(null);
    setPosDot(pos);
    updateNear();
    autoStamp();
  });
});

// 設定（既定はオン）
function setting(key) { try { return localStorage.getItem(LS + key) !== '0'; } catch { return true; } }
function setSetting(key, on) { try { localStorage.setItem(LS + key, on ? '1' : '0'); } catch { /* 保存できなくても続ける */ } }

// 開いている間の自動の判子。近い順に見て、条件を満たす最初の1か所だけ押す
let autoNote = null; let autoTimer = 0; const undone = new Set(); // 取り消した場所は、アプリを閉じるまで自動で押さない
async function autoStamp() {
  if (stamping || !state.pos || !setting('auto')) return;
  const pos = state.pos;
  const keys = tilesForBounds(pos.lat - 0.02, pos.lng - 0.025, pos.lat + 0.02, pos.lng + 0.025);
  await ensureTiles(keys);
  if (stamping) return;
  const cands = [...spotsIn(keys), ...state.seasonSpots, ...shopsNear(pos)].filter((s) => Number.isFinite(s.lat) && modeAllows(s, state.mode))
    .map((s) => ({ s, d: distanceMeters(pos, s) })).sort((a, b) => a.d - b.d);
  markPassed(pos, cands);
  const hit = cands.find(({ s }) => !undone.has(s.id) && shouldAutoStamp(s, state.fixes, state.mode, state.visits, now()));
  if (!hit) return;
  const spot = hit.s;
  stamping = true;
  try {
    const season = seasonOf(spot, now());
    const visit = { id: db.newId(), spotId: spot.id, at: now().getTime(), lat: pos.lat, lng: pos.lng, mode: state.mode, seasonal: !!season, source: 'auto' };
    await db.put('visits', visit);
    const shopN = await addShopMeals(spot, visit);
    await loadData();
    drawMap();
    render();
    const msg = (season ? `${spot.name}の季節の判子（${season.label}）を押しました` : `${spot.name}の判子を押しました`) + (shopN ? `（${foodNamesOf(spot)}を食べた記録も付けました）` : '');
    autoNote = { spot, visitId: visit.id, msg };
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { autoNote = null; nearSig = ''; updateNear(); }, 60000);
    nearSig = '';
    updateNear();
    toast(msg);
    haptic(60);
  } catch (err) {
    toast('保存できませんでした：' + (err && err.message ? err.message : err));
  } finally {
    stamping = false;
  }
}
async function undoAuto(note) {
  try {
    await db.remove('visits', note.visitId);
    for (const m of state.meals.filter((x) => x.visitId === note.visitId)) await db.remove('meals', m.id);
    undone.add(note.spot.id);
    autoNote = null;
    await loadData();
    drawMap();
    render();
    nearSig = '';
    updateNear();
    toast('判子を取り消しました');
  } catch (err) { toast('取り消せませんでした：' + (err && err.message ? err.message : err)); }
}

async function updateNear() {
  const pos = state.pos;
  if (!pos) return;
  const keys = tilesForBounds(pos.lat - 0.02, pos.lng - 0.025, pos.lat + 0.02, pos.lng + 0.025);
  await ensureTiles(keys);
  // 旅行では近所の場所（喫茶店・神社など）は案内しない
  const cands = [...spotsIn(keys), ...state.seasonSpots].filter((s) => Number.isFinite(s.lat) && modeAllows(s, state.mode));
  // 押した・通った場所は案内しない。今いて押せる場所がなければ、まだ行っていない中でいちばん近い場所へ矢印を出す
  const d = now();
  const today = new Set(); const seen = new Set(Object.keys(passed()));
  for (const v of state.visits) (sameDay(v, d) ? today : seen).add(v.spotId);
  drawNear(pickNear(pos, cands, state.acc, today, seen));
  // 今日のお題は旅のしかたの範囲（自転車なら 10km）から選ぶので、その区画も読んでから描き直す
  if (DAILY_MODES.includes(state.mode)) {
    const dLat = MODES[state.mode].range / 111000; const dLng = dLat / Math.cos((pos.lat * Math.PI) / 180);
    await ensureTiles(tilesForBounds(pos.lat - dLat, pos.lng - dLng, pos.lat + dLat, pos.lng + dLng));
  }
  // 旅行の「今月のお題」も、動いたら距離と並びを描き直す（前の場所からの距離が残っていた）
  drawQuest();
}
function drawNear(best) {
  if (autoNote && best && best.spot.id !== autoNote.spot.id) autoNote = null;
  if (autoNote) {
    const note = autoNote;
    nearSig = '';
    nearEl.replaceChildren(...[
      h('div', { class: 'nearmain' }, h('span', { class: 'nt', style: 'white-space:normal' }, note.msg)),
      h('button', { class: 'nearpush', type: 'button', onclick: () => { recordDraft.spotId = note.spot.id; openRecord(); } }, sealTypeFor(note.spot) ? '印を記録' : '写真・メモ'),
      h('button', { class: 'nearpush', type: 'button', onclick: () => undoAuto(note) }, '取り消す')].filter(Boolean));
    nearEl.hidden = false;
    document.body.classList.add('hasnear');
    return;
  }
  if (!best) { nearSig = ''; nearEl.hidden = true; document.body.classList.remove('hasnear'); return; }
  const { spot, distance } = best;
  const can = canStamp(spot, distance, state.acc);
  const done = stampedOn(state.visits, spot.id, now());
  const season = seasonOf(spot, now());
  const deg = Math.round(bearingDeg(state.pos, spot) / 10) * 10;
  const sig = [spot.id, Math.round(distance / 5), deg, can, done].join('|');
  if (sig === nearSig && !nearEl.hidden) return;
  nearSig = sig;
  if (can && !done) alertNear(spot, season);
  nearEl.replaceChildren(...[
    h('button', { class: 'nearmain', type: 'button', onclick: () => focusSpot(spot) },
      h('span', { class: 'arrow', style: `transform:rotate(${deg}deg)`, 'aria-hidden': 'true' }, '↑'),
      h('span', { class: 'nt' }, `${spot.name} まで ${fmtDist(distance)}`)),
    can && !done ? h('button', { class: 'nearpush', type: 'button', 'data-sfx': 'stamp', onclick: () => stamp(spot) }, season ? `季節の判子を押す（${season.label}）` : '判子を押す') : null].filter(Boolean));
  nearEl.hidden = false;
  document.body.classList.add('hasnear');
}

// 判子を押せる範囲に入ったら1回だけ知らせる（同じ場所は1日1回）。Android は振動、iPhone は振動がないので通知（ホーム画面に追加したときだけ出る）
const alerted = new Set();
async function alertNear(spot, season) {
  const key = `${spot.id}|${now().toDateString()}`;
  if (alerted.has(key) || !setting('nearalert')) return;
  alerted.add(key);
  haptic([120, 80, 120]);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = season ? `季節の判子を押せます（${season.label}）` : '判子を押せます';
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, tag: 'near-' + spot.id, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
    if (reg) await reg.showNotification(`${spot.name}に着きました`, opts);
    else new Notification(`${spot.name}に着きました`, opts);
  } catch { /* 通知を出せない端末では振動だけ */ }
}
async function toggleNearAlert(on) {
  setSetting('nearalert', on);
  if (on && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* 古い Safari はコールバック形式。振動だけで続ける */ }
    openSettings();
  }
}
function nearAlertNote() {
  if (!('Notification' in window)) return 'この端末では通知を出せないので、振動だけです（iPhone はホーム画面に追加すると通知が出せます）。';
  if (Notification.permission === 'denied') return '通知がブロックされています。端末の設定で許可すると通知も出ます。';
  if (Notification.permission === 'default') return 'オンにすると通知の許可を聞きます。';
  return '画面を消している間は位置を取れないので知らせられません。';
}

// ---------- 帳面 ----------
function openBook() {
  const tabs = [['spots', '名所'], ['foods', 'ご当地'], ['prefs', '都道府県'], ['countries', '国']];
  const body = state.tab === 'foods' ? bookFoods() : state.tab === 'prefs' ? bookPrefs() : state.tab === 'countries' ? bookCountries() : bookSpots();
  showSheet(openBook, [
    h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', {
      class: 'tab' + (state.tab === k ? ' on' : ''), type: 'button',
      onclick: () => { state.tab = k; spotQuery = ''; foodQuery = ''; countryQuery = ''; masuDetail = null; prefDetail = null; countryDetail = null; openBook(); },
    }, label))),
    body,
  ]);
}

// 検索欄：入力欄はそのままにして、結果だけ描き直す（入力欄ごと作り直すと、iPhone の日本語入力で変換中の文字が壊れていた）。
// 変換中（isComposing）は描き直さず、確定したときに描き直す
let refreshSearch = null;
function searchBox(id, placeholder, value, onQuery, results, extra = {}) {
  const wrap = h('div', {}, ...results());
  const run = (e) => { onQuery(e.target.value); wrap.replaceChildren(...results()); };
  const input = h('input', {
    id, class: 'search', type: 'search', placeholder, value, autocomplete: 'off', ...extra,
    oninput: (e) => { if (!e.isComposing) run(e); },
    oncompositionend: run,
  });
  refreshSearch = () => wrap.replaceChildren(...results());
  return [input, wrap];
}

function allListSpots() { return [...state.catalog.values(), ...state.seasonSpots]; }

// これより長い一覧（道の駅・国宝など）は、初期状態で畳んでおく
const FOLD_OVER = 120;
// 北から順（JIS の都道府県コード順）
const PREF_ORDER = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

// マスを押すと、名前・都道府県と（位置が分かれば）「地図で見る」を出す
let masuDetail = null;
// 帳面のマスを押したときの詳細：帳面（と、そのスクロール位置）はそのままに、下からせり上がるポップアップで出す。
// 閉じる：「閉じる」・外側をタップ・下へなでる。中身は地図のカードと同じ（名所の写真・説明・自分の写真・押した日→日記・地図で見る・経路）
let popupEl = null;
function closePopup() {
  if (!popupEl) return;
  popupEl.remove(); popupEl = null;
}
function openMasuDetail(id, name, pref) {
  closePopup();
  const spot = spotById(id);
  const hasCoord = spot && Number.isFinite(spot.lat);
  const grab = h('div', { class: 'popgrab', 'aria-label': '下へなでると閉じる' }, h('span', {}));
  const body = h('div', { class: 'popbody' },
    h('div', {}, h('b', { style: 'font-size:18px' }, name), pref ? h('span', { class: 'muted' }, '　' + pref) : null),
    origNameEl(id, name),
    spotInfoEl({ id, name }),
    hasCoord ? null : h('p', { class: 'muted', style: 'margin:4px 0 0' }, '位置が分からないため地図では開けません'),
    stampDatesEl(id),
    myPhotosEl(id),
    h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px' },
      hasCoord ? h('button', { class: 'btn primary', type: 'button', onclick: () => showOnMap(id, spot.lat, spot.lng) }, '地図で見る') : null,
      hasCoord ? h('a', { class: 'btn', href: gmapUrl(spot, true), target: '_blank', rel: 'noopener', style: 'display:inline-flex;align-items:center;text-decoration:none;color:inherit' }, '経路') : null,
      diaryBtn(id),
      h('button', { class: 'btn', type: 'button', onclick: closePopup }, '閉じる')));
  const pop = h('div', { class: 'popup', role: 'dialog', 'aria-label': name }, grab, body);
  const back = h('div', { class: 'popback', onclick: closePopup });
  // 下へなでると閉じる（つまみのところから。ポップアップが一番上までスクロールしているときは中身のどこからでも）
  let y0 = null;
  const start = (e) => { if (e.target.closest('.popgrab') || body.scrollTop <= 0) y0 = e.touches[0].clientY; };
  const move = (e) => { if (y0 === null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) pop.style.transform = 'translateY(' + dy + 'px)'; };
  const end = (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (dy > 80) closePopup(); else pop.style.transform = '';
  };
  pop.addEventListener('touchstart', start, { passive: true });
  pop.addEventListener('touchmove', move, { passive: true });
  pop.addEventListener('touchend', end, { passive: true });
  const wrap = h('div', { class: 'popwrap' }, back, pop);
  popupEl = wrap;
  document.body.append(wrap);
}
// （前の版の、帳面の一番上に出す詳細。いまは使わない）
function masuDetailPanel() { return null; }
function barEl(count, total, color) {
  const pct = total ? Math.min(100, Math.round((count / total) * 100)) : 0;
  return h('div', { class: 'bar' }, h('i', { style: `width:${pct}%;background:${color}` }));
}
// 帳面のマスに出す写真：マスが画面に入ったときだけ読む（マスは数千個ある）。URL はこの画面の分だけ持ち、シートを閉じたら解放する
const masuUrls = new Map();
let masuObserver = null;
function releaseMasuPhotos() {
  if (masuObserver) { masuObserver.disconnect(); masuObserver = null; }
  for (const u of masuUrls.values()) URL.revokeObjectURL(u);
  masuUrls.clear();
}
async function masuPhotoSrc(id) {
  if (masuUrls.has(id)) return masuUrls.get(id);
  const p = await db.get('photos', id);
  if (!p) return null;
  const u = URL.createObjectURL(p.blob);
  masuUrls.set(id, u);
  return u;
}
function watchMasuPhoto(el, photoId) {
  const load = () => masuPhotoSrc(photoId).then((u) => {
    if (!u || !el.isConnected) return;
    el.style.backgroundImage = `url("${u}")`;
    el.classList.add('photoed');
  });
  if (typeof IntersectionObserver === 'undefined') { load(); return; }
  if (!masuObserver) {
    masuObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { masuObserver.unobserve(e.target); e.target._loadPhoto && e.target._loadPhoto(); }
    }, { root: sheetBody, rootMargin: '120px' });
  }
  el._loadPhoto = load;
  masuObserver.observe(el);
}
function masuCell(c, color, isSeason) {
  const el = h('button', {
    class: 'masu' + (c.got ? ' got' : '') + (c.hasCoord === false ? ' nocoord' : '') + (isSeason ? ' season' : ''),
    type: 'button', style: `--c:${color}`, title: `${c.name}${c.pref ? `（${c.pref}）` : ''}`,
    onclick: () => openMasuDetail(c.id, c.name, c.pref),
  }, glyphOf(c.name));
  // 押した場所に写真が付いていれば、いちばん新しい写真を丸く切り抜いて出す
  const photo = c.got ? latestPhotoForSpot(c.id) : null;
  if (photo) watchMasuPhoto(el, photo.photoId);
  return el;
}

// 一覧に入っていない近所の場所（神社・お寺・喫茶店など）で押した判子を、種類ごとに出す
function nearSealsSection() {
  const seen = new Map();
  for (const v of state.visits) {
    if (seen.has(v.spotId)) continue;
    const s = spotById(v.spotId);
    if (s && s.tier === 'near' && NEAR_KINDS[s.kind]) seen.set(v.spotId, s);
  }
  if (!seen.size) return null;
  const byKind = new Map();
  for (const s of seen.values()) { if (!byKind.has(s.kind)) byKind.set(s.kind, []); byKind.get(s.kind).push(s); }
  return h('section', { class: 'nearseals' },
    h('div', { class: 'listhead' }, h('b', {}, '近所で押した判子')),
    [...byKind.entries()].map(([k, list]) => h('div', {},
      h('p', { class: 'muted', style: 'margin:8px 0 4px' }, NEAR_KINDS[k]),
      h('div', { class: 'masus' }, list.map((s) => masuCell({ id: s.id, name: s.name, pref: s.pref, got: true }, TIER_COLOR.near, false))))));
}

let spotQuery = '';
// 読み仮名と別名（data/kana.json、約430KB）は、検索欄を使ったときに初めて読む
let kanaMap = null;
let kanaLoading = false;
function ensureKana() {
  if (kanaMap || kanaLoading) return;
  kanaLoading = true;
  fetchJson('data/kana.json', {}).then((k) => {
    kanaMap = new Map(Object.entries(k).map(([id, w]) => [id, normalizeName(w)]));
    // 日本語に訳した名前の元の名前（英語など）でも探せるように、読みに足す
    for (const [id, o] of state.origNames) for (const key of [id, `f_${id}`]) kanaMap.set(key, (kanaMap.get(key) || '') + normalizeName(o));
    if (spotQuery && state.tab === 'spots' && !sheetEl.hidden && refreshSearch) refreshSearch();
  });
}
function bookSpots() {
  const spots = allListSpots();
  const sectionsFor = (q) => state.lists.map((l) => {
    const p = listProgress(state.visits, spots, l.key);
    const isSeason = l.key === 'seasons';
    const color = isSeason ? 'var(--seal)' : TIER_COLOR.list;
    const cells = q ? p.cells.filter((c) => normalizeName(c.name).includes(q) || (kanaMap && (kanaMap.get(c.id) || '').includes(q))) : p.cells;
    if (!p.total || !cells.length) return null;
    return h('details', { class: 'listgroup' + (p.count ? ' got' : ''), open: q ? true : p.total <= FOLD_OVER },
      h('summary', {}, h('b', {}, l.name), h('span', { class: 'n' }, `${p.count} / ${p.total}`)),
      l.note ? h('p', { class: 'muted note' }, l.note) : null,
      barEl(p.count, p.total, color),
      h('div', { class: 'masus' }, cells.map((c) => masuCell(c, color, isSeason))));
  }).filter(Boolean);
  const results = () => { const sections = sectionsFor(normalizeName(spotQuery)); return [sections.length ? h('div', { class: 'listgroups' }, sections) : h('p', { class: 'muted' }, '見つかりませんでした')]; };
  return [
    masuDetailPanel(),
    ...searchBox('spotsearch', '名前・読み・別名で探す（例：きんかくじ）', spotQuery, (v) => { spotQuery = v; ensureKana(); }, results, { onfocus: ensureKana }),
    nearSealsSection(),
  ];
}

function sealRow(s, withDelete) {
  const spot = s.spotId ? spotById(s.spotId) : null;
  const where = [spot ? spot.name : '', s.pref].filter(Boolean).join('・');
  const canGo = (spot && Number.isFinite(spot.lat)) || (Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const photo = s.photoId ? imgFor(s.photoId, 'ph') : null;
  // 写真を押すとビューアで大きく（日記へ・地図で見るはビューアの下から）
  if (photo) viewable(photo, () => [itemOfSeal(s)]);
  return h('div', { class: 'rec' + (s.photoId ? '' : ' nophoto') },
    photo,
    h('div', {},
      h('div', { class: 't' }, `${s.type}　${fmtDate(s.at)}`),
      where ? h('div', { class: 'n' }, where) : null,
      s.note ? h('div', { class: 'n', style: 'white-space:normal' }, s.note) : null,
      withDelete ? h('button', { class: 'btn danger', type: 'button', style: 'min-height:32px;margin-top:6px;padding:0 10px;font-size:13px', onclick: () => deleteSeal(s) }, '削除') : null));
}
async function deleteSeal(s) {
  if (!confirm('この記録を削除しますか？')) return;
  await db.remove('seals', s.id);
  if (s.photoId) await db.remove('photos', s.photoId);
  await loadData();
  render();
}

// ---------- ご当地グルメ ----------
const mealsFor = (food) => state.meals.filter((m) => m.itemKey === food.key);
function foodMasu(f) {
  const got = mealsFor(f).length > 0;
  return h('button', {
    class: 'masu' + (got ? ' got' : ''), type: 'button', style: `--c:${FOOD_COLOR}`, title: `${f.name}（${foodWhere(f)}）`,
    onclick: () => { bookScroll = sheetBody.scrollTop; openFoodSheet(f); },
  }, glyphOf(f.name));
}
let foodQuery = '';
function bookFoods() {
  if (!state.foods.length) return [h('p', { class: 'muted' }, 'まだ読み込めていません')];
  const mains = state.foods.filter((f) => f.main);
  const gotMains = mains.filter((f) => mealsFor(f).length > 0);
  const head = h('div', { class: 'listhead' }, h('b', {}, 'ご当地グルメ'), h('span', { class: 'muted' }, '農林水産省「うちの郷土料理」より'), h('span', { class: 'n' }, `${gotMains.length} / ${mains.length}`));
  const ordered = [...mains].sort((a, b) => {
    const ai = PREF_ORDER.indexOf(a.pref); const bi = PREF_ORDER.indexOf(b.pref);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  // 都道府県ごとに見出しを付けて分ける（北から順）。検索中は当てはまる県だけ開いて出す
  const byPref = (foods, open) => {
    const groups = new Map();
    for (const f of foods) { if (!groups.has(f.pref)) groups.set(f.pref, []); groups.get(f.pref).push(f); }
    const prefs = [...groups.keys()].sort((a, b) => { const ai = PREF_ORDER.indexOf(a); const bi = PREF_ORDER.indexOf(b); return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi); });
    return h('div', { class: 'listgroups' }, prefs.map((pref) => {
      const list = groups.get(pref);
      const got = list.filter((f) => mealsFor(f).length > 0).length;
      return h('details', { class: 'listgroup' + (got ? ' got' : ''), open },
        h('summary', {}, h('b', {}, pref || 'その他'), h('span', { class: 'n' }, `${got} / ${list.length}`)),
        h('div', { class: 'masus' }, list.map(foodMasu)));
    }));
  };
  const results = () => {
    const q = normalizeName(foodQuery);
    if (!q) return [byPref(ordered, true)];
    const matches = state.foods.filter((f) => [f.name, f.kana, f.pref, ...(f.aliases || [])].some((w) => normalizeName(w).includes(q)));
    return [matches.length ? byPref(matches, true) : h('p', { class: 'muted' }, '見つかりませんでした')];
  };
  return [head, barEl(gotMains.length, mains.length, FOOD_COLOR), ...searchBox('foodsearch', '料理名・都道府県名で探す', foodQuery, (v) => { foodQuery = v; }, results)];
}
function foodRecordRow(m) {
  return h('div', { class: 'rec' + (m.photoId ? '' : ' nophoto') },
    m.photoId ? viewable(imgFor(m.photoId, 'ph'), () => [{ ...itemOfMeal(m), caption: m.note || m.name }]) : null,
    h('div', {},
      h('div', { class: 't' }, fmtDate(m.at)),
      m.note ? h('div', { class: 'n', style: 'white-space:normal' }, m.note) : null,
      h('button', { class: 'btn danger', type: 'button', style: 'min-height:32px;margin-top:6px;padding:0 10px;font-size:13px', onclick: () => deleteMeal(m) }, '削除')));
}
async function deleteMeal(m) {
  if (!confirm('この記録を削除しますか？')) return;
  await db.remove('meals', m.id);
  if (m.photoId) await db.remove('photos', m.photoId);
  await loadData();
  openFoodSheet(foodByKey(m.itemKey));
}
// 帳面から開いた詳細は「帳面に戻る」で、同じタブ・同じスクロール位置へ戻す
let bookScroll = 0;
function backToBook() { openBook(); sheetBody.scrollTop = bookScroll; }
const backBtn = (onclick, label = '‹ 帳面に戻る') => h('button', { class: 'btn', type: 'button', onclick }, label);
// 農林水産省「うちの郷土料理」の写真（リポジトリに置いた幅640pxのもの）。出典と、あれば画像提供元を下に出す。無ければ null
function foodPhotoEl(food) {
  if (food.world) {
    // Wikidata の P18（Commons の写真。作者・ライセンスつき）
    if (!food.photo) return null;
    const url = COMMONS_THUMB + food.photo[0];
    const file = commonsFileOf(url);
    const credit = () => ['写真：', food.photo[1] || '作者不明', food.photo[2] ? `（${food.photo[2]}）` : '', '　',
      file ? h('a', { href: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_')), target: '_blank', rel: 'noopener' }, 'Wikimedia Commons') : 'Wikimedia Commons'];
    const img = viewable(h('img', { src: url, alt: food.name, loading: 'lazy', width: 500, onerror: () => fig.remove() }), () => [{ src: url, caption: [h('b', {}, food.name), h('br'), ...credit()] }]);
    const fig = h('figure', { class: 'foodphoto' }, img, h('figcaption', {}, ...credit()));
    return fig;
  }
  const p = (state.foodPhotos || {})[food.key];
  if (!p) return null;
  return h('figure', { class: 'foodphoto' },
    h('img', { src: 'data/' + p.file, alt: food.name, loading: 'lazy', width: 640 }),
    h('figcaption', {}, '出典：農林水産省「うちの郷土料理」', p.credit ? `　画像提供元：${p.credit}` : ''));
}
// その料理を出すお店の一覧（今いる場所に近い順。位置が分からなければ、料理の県のお店から）。押すと地図のそのお店へ
function foodShopsEl(food) {
  const shops = state.foodShops[food.key] || [];
  if (!shops.length) return null;
  const pos = state.pos;
  const ordered = shops.map((s) => ({ s, d: pos ? distanceMeters(pos, s) : null }));
  if (pos) ordered.sort((a, b) => a.d - b.d);
  const list = h('div', { class: 'list shoplist' });
  const draw = (all) => {
    list.replaceChildren(...ordered.slice(0, all ? ordered.length : 12).map(({ s, d }) => h('button', {
      class: 'btn shoprow', type: 'button', onclick: () => showOnMap(s.id),
    }, h('span', {}, s.name, visitsOf(s.id).length ? ' ✓' : ''), d !== null ? h('span', { class: 'muted' }, fmtDist(d)) : null)));
    if (!all && ordered.length > 12) list.append(h('button', { class: 'btn', type: 'button', onclick: () => draw(true) }, `ぜんぶ見る（${ordered.length}店）`));
  };
  draw(false);
  return h('div', { class: 'foodshops' },
    h('h3', { style: 'font-size:16px;margin:12px 0 4px' }, `食べられるお店 ${shops.length} 店`),
    h('p', { class: 'muted', style: 'margin:0 0 6px' }, 'お店の名前に料理名がある店などを、地図のデータから自動で拾っています（閉店や違いがあるかもしれません）。そのお店の近くに3分いると、判子と「食べた」記録が付きます。'),
    list,
    h('p', { class: 'muted', style: 'margin:6px 0 0' }, '出典：© OpenStreetMap contributors（ODbL）'));
}
function openFoodSheet(food) {
  if (!food) { closeSheet(); return; }
  const records = mealsFor(food).sort((a, b) => (a.at < b.at ? 1 : -1));
  showSheet(() => openFoodSheet(food), [
    h('div', { style: 'display:flex;gap:8px;margin:0 0 10px' },
      backBtn(backToBook),
      h('button', { class: 'btn primary', type: 'button', style: 'flex:1', onclick: () => openMealRecord(food) }, '食べた')),
    h('h2', { style: 'font-size:20px;margin:0 0 4px' }, food.name),
    h('p', { class: 'sub', style: 'margin:0 0 8px' }, foodWhere(food)),
    foodPhotoEl(food),
    h('p', {}, food.summary),
    food.world
      ? h('p', { class: 'muted', style: 'margin-bottom:14px' }, '出典：', h('a', { href: `https://www.wikidata.org/wiki/${food.qid}`, target: '_blank', rel: 'noopener' }, 'Wikidata'), '（CC0）')
      : h('p', { class: 'muted', style: 'margin-bottom:14px' }, '出典：', h('a', { href: food.url, target: '_blank', rel: 'noopener' }, '農林水産省「うちの郷土料理」'), '（一部を要約）'),
    foodShopsEl(food),
    records.length ? h('div', { class: 'list' }, records.map(foodRecordRow)) : h('p', { class: 'muted' }, 'まだ記録がありません。'),
  ]);
}
function openMealRecord(food) {
  let photoBlob = null;
  let dateTouched = false;
  const date = h('input', { type: 'date', value: todayStr(now()), oninput: () => { dateTouched = true; } });
  const note = h('textarea', { placeholder: 'ひとこと' });
  const preview = h('img', { class: 'preview', alt: '', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    save.disabled = true;
    try {
      let photoId = null;
      if (photoBlob) { photoId = db.newId(); await db.put('photos', { id: photoId, blob: photoBlob }); }
      const meal = {
        id: db.newId(), kind: 'food', name: food.name, itemKey: food.key, at: date.value || todayStr(now()),
        pref: food.pref, note: note.value.trim(), photoId,
      };
      if (food.world) meal.country = food.country;
      await db.put('meals', meal);
      await loadData();
      openFoodSheet(food);
      toast('記録しました');
    } catch (err) { save.disabled = false; toast('保存できませんでした：' + (err && err.message ? err.message : err)); }
  } }, '記録する');
  showSheet(null, [h('div', { class: 'form' },
    h('div', {}, backBtn(() => openFoodSheet(food), '‹ 戻る')),
    h('h2', { style: 'font-size:20px' }, food.name),
    h('p', { class: 'sub', style: 'margin:0' }, foodWhere(food)),
    h('label', { class: 'f' }, '日付', date),
    h('div', { class: 'f' }, h('div', { class: 'muted' }, '写真'), h('div', { class: 'photoRow' },
      h('label', { class: 'btn', style: 'display:grid;place-items:center;cursor:pointer' }, '写真を選ぶ',
        h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const d = readExifDate(await f.arrayBuffer());
            if (d && !dateTouched) date.value = d;
          } catch { /* 日付が読めなくても続ける */ }
          try { photoBlob = await resizePhoto(f); preview.src = URL.createObjectURL(photoBlob); preview.hidden = false; } catch (err) { toast(err.message); }
        } })), preview)),
    h('label', { class: 'f' }, 'ひとこと', note),
    save)]);
}

// 都道府県のマスを押すと、その県の名所（一覧ごと）とご当地グルメを出す
let prefDetail = null;
function bookPrefDetail(pref) {
  const spots = allListSpots();
  const sections = state.lists.map((l) => {
    const p = listProgress(state.visits, spots, l.key);
    const cells = p.cells.filter((c) => c.pref === pref);
    if (!cells.length) return null;
    const isSeason = l.key === 'seasons';
    const color = isSeason ? 'var(--seal)' : TIER_COLOR.list;
    const got = cells.filter((c) => c.got).length;
    return h('details', { class: 'listgroup' + (got ? ' got' : ''), open: cells.length <= FOLD_OVER },
      h('summary', {}, h('b', {}, l.name), h('span', { class: 'n' }, `${got} / ${cells.length}`)),
      h('div', { class: 'masus' }, cells.map((c) => masuCell(c, color, isSeason))));
  }).filter(Boolean);
  const foods = state.foods.filter((f) => f.pref === pref);
  const foodGot = foods.filter((f) => mealsFor(f).length > 0).length;
  if (foods.length) {
    sections.push(h('details', { class: 'listgroup' + (foodGot ? ' got' : ''), open: true },
      h('summary', {}, h('b', {}, 'ご当地グルメ'), h('span', { class: 'n' }, `${foodGot} / ${foods.length}`)),
      h('div', { class: 'masus' }, foods.map(foodMasu))));
  }
  return [
    masuDetailPanel(),
    h('div', { style: 'display:flex;gap:8px;align-items:center;margin:0 0 8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => { prefDetail = null; masuDetail = null; openBook(); } }, '‹ 都道府県'),
      h('h3', { style: 'margin:0;font-size:20px' }, pref)),
    sections.length ? h('div', { class: 'listgroups' }, sections) : h('p', { class: 'muted' }, 'この県の場所はまだありません'),
  ];
}
function bookPrefs() {
  if (prefDetail) return bookPrefDetail(prefDetail);
  const counts = prefsVisited(state.visits, state.seals, state.meals, allListSpots());
  const byPos = new Map(PREFS.map((p) => [`${p.row}_${p.col}`, p]));
  const cells = [];
  for (let r = 0; r <= 13; r++) {
    for (let c = 0; c < 10; c++) {
      const p = byPos.get(`${r}_${c}`);
      cells.push(p
        ? h('button', { type: 'button', class: 'pref' + (counts[p.name] ? ' got' : ''), title: p.name, onclick: () => { prefDetail = p.name; masuDetail = null; openBook(); sheetBody.scrollTop = 0; } }, h('span', {}, p.name.replace(/[都道府県]$/, '') || p.name), counts[p.name] ? h('b', {}, counts[p.name]) : null)
        : h('div', {}));
    }
  }
  // 空の行（12 行目）は詰める
  const rows = [];
  for (let r = 0; r <= 13; r++) { if (r !== 12) rows.push(...cells.slice(r * 10, r * 10 + 10)); }
  const visited = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return [
    h('p', { class: 'sub' }, `判子・印・ご当地グルメのある都道府県：${visited.length} / 47`),
    h('div', { class: 'prefgrid' }, rows),
    visited.length ? h('div', { class: 'spotlist' }, visited.map(([p, n]) => h('div', { class: 'row' }, h('span', {}, p), h('span', { class: 'muted' }, `${n}`)))) : h('p', { class: 'muted' }, 'まだありません'),
  ];
}

// 世界に広がる一覧（今は世界遺産だけ）の場所。国ごとの帳面はこの中だけで見せる（日本だけの一覧は都道府県の帳面にすでにある）
function globalSpots() {
  const keys = new Set(state.lists.filter((l) => l.global).map((l) => l.key));
  return allListSpots().filter((s) => (s.lists || []).some((k) => keys.has(k)));
}

let countryQuery = '';
// 国を押すと、その国の場所を出す（都道府県と同じ形）
let countryDetail = null;
// その国の世界遺産のベストシーズン（気候から行きやすい月。出典 NASA POWER）。無ければ null
function countryBestMonths(spots, country) {
  if (!state.climate) return null;
  const cells = listProgress(state.visits, spots, 'heritage').cells.filter((c) => (state.catalog.get(c.id) || {}).country === country);
  // その国の世界遺産の半数以上でベストに入っている月だけ
  const lists = cells.map((c) => {
    const key = state.climate.spots[c.id];
    const grid = key && state.climate[key];
    return grid && grid.best;
  });
  const months = majorityMonths(lists);
  return months.length ? formatBestMonths(months) : null;
}
function bookCountryDetail(country) {
  const spots = globalSpots();
  const sections = state.lists.filter((l) => l.global).map((l) => {
    const cells = listProgress(state.visits, spots, l.key).cells.filter((c) => (state.catalog.get(c.id) || {}).country === country);
    if (!cells.length) return null;
    const got = cells.filter((c) => c.got).length;
    return h('details', { class: 'listgroup' + (got ? ' got' : ''), open: true },
      h('summary', {}, h('b', {}, l.name), h('span', { class: 'n' }, `${got} / ${cells.length}`)),
      h('div', { class: 'masus' }, cells.map((c) => masuCell(c, TIER_COLOR.list, false))));
  }).filter(Boolean);
  const best = countryBestMonths(spots, country);
  const wf = worldFoodsOf(country);
  if (wf.length) {
    const gotF = wf.filter((f) => mealsFor(f).length > 0).length;
    sections.unshift(h('details', { class: 'listgroup' + (gotF ? ' got' : ''), open: true },
      h('summary', {}, h('b', {}, 'ご当地'), h('span', { class: 'n' }, `${gotF} / ${wf.length}`)),
      h('div', { class: 'masus' }, wf.map(foodMasu)),
      h('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, '料理は Wikidata（CC0）から、Wikipedia の言語版が多い順に')));
  }
  return [
    masuDetailPanel(),
    h('div', { style: 'display:flex;gap:8px;align-items:center;margin:0 0 8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => { countryDetail = null; masuDetail = null; openBook(); } }, '‹ 国'),
      h('h3', { style: 'margin:0;font-size:20px' }, country)),
    best ? h('p', { class: 'muted', style: 'margin:0 0 8px' }, `世界遺産のベストシーズン ${best}`) : null,
    sections.length ? h('div', { class: 'listgroups' }, sections) : h('p', { class: 'muted' }, 'この国の場所はまだありません'),
  ];
}
// 世界地図：国の形を塗る（行った国は濃く、世界遺産のある国は薄く、ない国は灰色）。国を押すとその国へ。
// 国境は Natural Earth（パブリックドメイン）の 1:1億。小さすぎて形がない国は同じ大きさの点で出す
let countryShapes = null;
function worldMapEl(countries, counts) {
  const el = h('div', { class: 'worldmap' });
  const has = new Set(countries);
  const go = (country) => { countryDetail = country; masuDetail = null; openBook(); sheetBody.scrollTop = 0; };
  const draw = (geo) => {
    if (!el.isConnected || !geo) return;
    const map = L.map(el, { center: [25, 15], zoom: 1, minZoom: 1, maxZoom: 6, zoomControl: false, attributionControl: true, worldCopyJump: true, zoomSnap: 0.25 });
    state.maps.push(map);
    map.attributionControl.setPrefix('').addAttribution('Natural Earth');
    const styleOf = (n) => (counts[n] ? { color: '#fff', weight: 0.6, fillColor: TIER_COLOR.list, fillOpacity: 0.9 }
      : has.has(n) ? { color: '#fff', weight: 0.6, fillColor: TIER_COLOR.list, fillOpacity: 0.45 }
        : { color: '#fff', weight: 0.6, fillColor: '#9aa5a7', fillOpacity: 0.2 });
    L.geoJSON(geo, {
      style: (f) => styleOf(f.properties.n),
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 5, ...styleOf(f.properties.n), color: has.has(f.properties.n) ? TIER_COLOR.list : '#9aa5a7', weight: 1 }),
      onEachFeature: (f, layer) => {
        const n = f.properties.n;
        layer.bindTooltip(`${n}${counts[n] ? `（判子 ${counts[n]}）` : ''}`, { sticky: true });
        if (has.has(n)) layer.on('click', () => go(n));
      },
    }).addTo(map);
    map.fitBounds([[-50, -165], [72, 180]]);
  };
  setTimeout(() => {
    if (countryShapes) draw(countryShapes);
    else fetchJson('data/countries.geojson', null).then((g) => { countryShapes = g; draw(g); });
  }, 0);
  return el;
}
function worldFoodsOf(country) { return state.worldFoods.filter((f) => f.country === country); }
function bookCountries() {
  if (countryDetail) return bookCountryDetail(countryDetail);
  const spots = globalSpots();
  const counts = countriesVisited(state.visits, spots);
  const countries = [...new Set([...countriesOf(spots), ...state.worldFoods.map((f) => f.country)])].sort((a, b) => {
    const d = (counts[b] || 0) - (counts[a] || 0);
    if (d) return d;
    if (a === '日本') return -1;
    if (b === '日本') return 1;
    return a.localeCompare(b, 'ja');
  });
  const visited = countries.filter((c) => counts[c]);
  const sectionsFor = (q) => countries.map((country) => {
    const p = countryProgress(state.visits, spots, country);
    const cells = q ? p.cells.filter((c) => normalizeName(c.name).includes(q) || normalizeName(origNameOf(c.id)).includes(q) || normalizeName(country).includes(q)) : p.cells;
    if (!p.total) {
      // 世界遺産などは無く、ご当地だけがある国
      const foods = worldFoodsOf(country).filter((f) => !q || normalizeName(f.name).includes(q) || normalizeName(country).includes(q));
      if (!foods.length) return null;
      const gotF = foods.filter((f) => mealsFor(f).length > 0).length;
      return h('details', { class: 'listgroup' + (gotF ? ' got' : ''), open: !!q || foods.length <= FOLD_OVER },
        h('summary', {}, h('b', {}, country), h('span', { class: 'n' }, `ご当地 ${gotF} / ${foods.length}`)),
        h('div', { class: 'masus' }, foods.map(foodMasu)));
    }
    if (!cells.length) return null;
    return h('details', { class: 'listgroup' + (p.count ? ' got' : ''), open: q ? true : p.total <= FOLD_OVER },
      h('summary', {}, h('b', {}, country), h('span', { class: 'n' }, `${p.count} / ${p.total}`)),
      barEl(p.count, p.total, TIER_COLOR.list),
      h('div', { class: 'masus' }, cells.map((c) => masuCell(c, TIER_COLOR.list, false))));
  }).filter(Boolean);
  return [
    masuDetailPanel(),
    h('p', { class: 'sub' }, `判子のある国：${visited.length} / ${countriesOf(spots).length}（国を押すとその国へ。濃い色＝判子あり、薄い色＝世界遺産・ご当地あり）`),
    worldMapEl(countries, counts),
    ...searchBox('countrysearch', '国名・名前で探す', countryQuery, (v) => { countryQuery = v; }, () => {
      const sections = sectionsFor(normalizeName(countryQuery));
      return [sections.length ? h('div', { class: 'listgroups' }, sections) : h('p', { class: 'muted' }, '見つかりませんでした')];
    }),
  ];
}

// ---------- 設定 ----------
// いま動いている版（sw.js の VERSION＝キャッシュの名前）。iPhone で新しい版になったか確かめる用
function verEl() {
  const el = h('span', { class: 'muted', style: 'font-size:13px;font-weight:normal' });
  try {
    caches.keys().then((ks) => { const v = ks.filter((k) => k.startsWith('tabigoyomi-v')).sort((a, b) => parseInt(b.slice(12), 10) - parseInt(a.slice(12), 10))[0]; if (v) el.textContent = `（${v.replace('tabigoyomi-', '')}）`; }).catch(() => {});
  } catch { /* キャッシュが使えなければ出さない */ }
  return el;
}
function openSettings() {
  showSheet(openSettings, [
    h('h2', { style: 'font-size:20px;margin:0 0 4px' }, '設定 ', verEl()),
    h('div', { class: 'setrow' },
      h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); pickPhotosForImport(); } }, '写真からまとめて判子'),
      h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); pickGpxForImport(); } }, '経路（GPX）から通った印')),
    h('div', { class: 'setrow' },
      h('button', { class: 'btn', type: 'button', onclick: async () => { await db.setSetting('skippedPhotos', []); toast('スキップした写真を、次の取り込みからまた出します'); } }, 'スキップした写真をもう一度見る')),
    h('div', { class: 'setrow' },
      h('button', { class: 'btn', type: 'button', onclick: exportData }, '書き出す（判子・印・写真）'),
      h('label', { class: 'btn', style: 'display:grid;place-items:center;cursor:pointer' }, '読み込む',
        h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importData })),
      h('button', { class: 'btn danger', type: 'button', onclick: wipe }, '全部消す')),
    h('div', { class: 'setrow' },
      h('label', { style: 'display:flex;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: setting('auto'), onchange: (e) => setSetting('auto', e.target.checked) }), '自動で判子を押す（アプリを開いている間）'),
      h('label', { style: 'display:flex;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: setting('vibrate'), onchange: (e) => setSetting('vibrate', e.target.checked) }), '押したら振動する（iPhone は iOS 18 以降）'),
      h('label', { style: 'display:flex;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: setting('sound'), onchange: (e) => setSetting('sound', e.target.checked) }), '効果音（iPhone はマナーモードだと鳴らないことがあります）'),
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, '今日のお題の長さ（回って戻る時間）',
        h('div', { class: 'chips' }, LOOP_MINUTE_CHOICES.map((m) => h('button', { class: 'chip' + (loopMinutes() === m ? ' on' : ''), type: 'button',
          onclick: () => { setLoopMinutes(m); openSettings(); } }, `${m}分`)))),
      h('label', { style: 'display:flex;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: setting('nearalert'), onchange: (e) => toggleNearAlert(e.target.checked) }), '判子を押せる場所に着いたら知らせる（振動・通知）'),
      h('p', { class: 'muted', style: 'margin:0' }, nearAlertNote()),
      h('p', { class: 'muted', style: 'margin:0' }, '画面を消している間は位置を取れないので押せません。')),
    h('p', { class: 'muted' }, 'データはこの端末の中だけにあります。機種変更の前に書き出してください。'),
    h('p', { class: 'muted' }, '出典：地図 ' + '国土地理院（淡色地図）／場所のデータ Wikidata（CC0）／郷土料理：農林水産省「うちの郷土料理」（一部を要約）。位置情報は端末の外には送りません。'),
  ]);
}

// ---------- 日記（カレンダー） ----------
// 小さな判子（地図・帳面と同じ色・かすれ）。写真が付いていれば文字の代わりにその写真を丸く（季節は角丸）切り抜く
function miniHanko({ color, glyph, square, photoId }) {
  const el = h('div', { class: 'minihanko' + (square ? ' square' : '') + (photoId ? ' photo' : ''), style: `--c:${color}` }, photoId ? null : glyph);
  if (photoId) attachPhotoBg(el, photoId);
  return el;
}
// その判子（visit）に付いた写真（写真の取り込み・記録でセットした印の photoId）。なければ null
const sealPhotoForVisit = (visitId) => state.seals.find((s) => s.visitId === visitId && s.photoId) || null;
// その日の、小さな判子にする項目（判子＝visits、ご当地＝meals）
function dayStampItems(d) {
  const items = d.visits.map((v) => {
    const s = spotById(v.spotId);
    const seal = sealPhotoForVisit(v.id);
    const mark = v.seasonal ? ((s && s.seasons && s.seasons[0] && s.seasons[0].mark) || glyphOf(s ? s.name : '?')) : glyphOf(s ? s.name : '?');
    return { color: stampColor(s || {}, v.seasonal), glyph: mark, square: !!v.seasonal, photoId: seal ? seal.photoId : null };
  });
  for (const m of d.meals) items.push({ color: FOOD_COLOR, glyph: glyphOf(m.name), square: false, photoId: m.photoId || null });
  return items;
}
function diaryDays() {
  const days = groupByDay(state.visits, state.seals, state.meals);
  // 判子がなく、歩いた距離だけある日も出す
  for (const day of Object.keys(dist.days)) if (distText(dist.days[day]) && !days.some((d) => d.date === day)) days.push({ date: day, visits: [], seals: [], meals: [] });
  return new Map(days.map((d) => [d.date, d]));
}
let diaryYM = null; // 表示中の月 { year, month }。null なら今月
let diaryDay = null; // 開いている日（'YYYY-MM-DD'）。null ならカレンダー
let diaryPick = null; // 年月ピッカーを開いているとき { year }。null なら閉じている
function openDiary() {
  if (!diaryYM) { const d = now(); diaryYM = { year: d.getFullYear(), month: d.getMonth() + 1 }; }
  showSheet(openDiary, diaryDay ? diaryDayNodes(diaryDay) : diaryCalendarNodes());
}
// 日記のマスに出す、旅のしかたの小さなマーク（線画。色は文字色に合わせる）
const MODE_MARK = {
  walk: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><circle cx="9" cy="2.6" r="1.6" fill="currentColor"/><path d="M9 5 7 8.5l2.5 2 .5 4M7 8.5 4.5 10M9.3 7l2.7 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 8.5 6 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  bike: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.6" cy="11" r="2.6"/><circle cx="12.4" cy="11" r="2.6"/><path d="M3.6 11 6.5 5.5h4l1.9 5.5M6.5 5.5 8 11h4.4M5.5 4h2"/></g></svg>',
  trip: '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M14.5 8 9.3 6.6 6.4 1.5H5l1.4 5.3L3 7.4 1.8 5.9H.8l.9 2.1-.9 2.1h1l1.2-1.5 3.4.6L5 14.5h1.4l2.9-5.1 5.2-1.4z" fill="currentColor"/></svg>',
};
function modeMarks(modes) {
  if (!modes.length) return null;
  const el = h('span', { class: 'modes-mark' });
  el.innerHTML = modes.slice(0, 3).map((m) => `<i title="${MODES[m].label}">${MODE_MARK[m]}</i>`).join('');
  return el;
}
// 年と月を選んで一気に飛ぶ：iOS の日付選びのようなドラム（年・月の2列を縦にスクロール、scroll-snap で止まった位置が選ばれる）。
// 開いたときは今カレンダーで見ている年月が真ん中。記録がある年・月には点。「決定」か、選ばれている行をもう一度タップで飛ぶ
const DRUM_ROW = 40;
function diaryPickerEl(byDate, curYear, curMonth) {
  const thisYear = now().getFullYear();
  const { months, years } = diaryRange([...byDate.keys()], thisYear);
  if (!years.includes(curYear)) years.push(curYear);
  years.sort((a, b) => a - b);
  const sel = { year: curYear, month: curMonth };
  const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const hasYear = (y) => [...months].some((k) => k.startsWith(`${y}-`));
  const yearItems = years.map((y) => h('div', { class: 'drumitem' + (hasYear(y) ? ' has' : ''), 'data-v': y }, `${y}年`));
  const monthItems = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => h('div', { class: 'drumitem', 'data-v': m }, `${m}月`));
  const markMonths = () => monthItems.forEach((el, i) => el.classList.toggle('has', months.has(ym(sel.year, i + 1))));
  const go = () => { diaryYM = { year: sel.year, month: sel.month }; diaryPick = null; openDiary(); };
  const drum = (items, values, key, label) => {
    const col = h('div', { class: 'drum', role: 'listbox', 'aria-label': label, tabindex: '0' }, h('div', { class: 'drumpad' }), ...items, h('div', { class: 'drumpad' }));
    const idxOf = () => Math.max(0, Math.min(values.length - 1, Math.round(col.scrollTop / DRUM_ROW)));
    const paint = () => items.forEach((el, i) => el.classList.toggle('sel', values[i] === sel[key]));
    let timer = 0;
    col.addEventListener('scroll', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const v = values[idxOf()];
        if (v !== sel[key]) { sel[key] = v; paint(); if (key === 'year') markMonths(); }
      }, 90);
    });
    items.forEach((el, i) => el.addEventListener('click', () => {
      if (values[i] === sel[key] && Math.abs(col.scrollTop - i * DRUM_ROW) < 4) { go(); return; }
      col.scrollTo({ top: i * DRUM_ROW, behavior: reduceMotion() ? 'auto' : 'smooth' });
    }));
    col.start = () => { col.scrollTop = values.indexOf(sel[key]) * DRUM_ROW; paint(); };
    return col;
  };
  const yc = drum(yearItems, years, 'year', '年');
  const mc = drum(monthItems, Array.from({ length: 12 }, (_, i) => i + 1), 'month', '月');
  markMonths();
  const panel = h('div', { class: 'pickpanel' },
    h('div', { class: 'drums' }, yc, mc, h('div', { class: 'drumband', 'aria-hidden': 'true' })),
    h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => { diaryPick = null; openDiary(); } }, 'やめる'),
      h('button', { class: 'btn primary', type: 'button', style: 'flex:1', onclick: go }, '決定')));
  // 画面に付いてから、いまの年月へ（付く前は scrollTop が効かない）
  requestAnimationFrame(() => requestAnimationFrame(() => { yc.start(); mc.start(); }));
  return panel;
}
function diaryCalendarNodes() {
  const { year, month } = diaryYM;
  const grid = monthGrid(year, month);
  const today = todayStr(now());
  const byDate = diaryDays();
  const cell = (c) => {
    const d = byDate.get(c.date) || { date: c.date, visits: [], seals: [], meals: [] };
    const items = dayStampItems(d);
    const shown = items.slice(0, 3);
    const extra = items.length - shown.length;
    const onlyMemo = !items.length && d.seals.length > 0;
    const marks = modeMarks(modesOfDay(d.visits, dist.days[c.date]));
    return h('button', {
      class: 'calday' + (c.inMonth ? '' : ' out') + (c.date === today ? ' today' : ''), type: 'button', 'data-date': c.date,
      onclick: () => { diaryDay = c.date; diaryPick = null; openDiary(); },
    },
      h('span', { class: 'dn' }, String(Number(c.date.slice(8, 10)))),
      marks,
      items.length ? h('span', { class: 'stamps' }, shown.map(miniHanko), extra > 0 ? h('span', { class: 'more' }, `+${extra}`) : null)
        : onlyMemo ? h('span', { class: 'dot' }) : null);
  };
  return [
    h('h2', { style: 'font-size:20px;margin:0 0 8px' }, '日記'),
    h('div', { style: 'display:flex;gap:8px;margin-bottom:10px' },
      h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); pickPhotosForImport(); } }, '写真からまとめて判子'),
      h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); pickGpxForImport(); } }, '経路（GPX）から')),
    h('div', { class: 'calhead' },
      h('button', { class: 'btn', type: 'button', onclick: () => { diaryPick = null; diaryYM = shiftMonth(year, month, -1); openDiary(); }, 'aria-label': '前の月' }, '‹'),
      h('button', { class: 'calpick', type: 'button', 'aria-expanded': diaryPick ? 'true' : 'false', 'aria-label': '年と月を選ぶ', onclick: () => { diaryPick = diaryPick ? null : { year }; openDiary(); } }, `${year}年${month}月 ${diaryPick ? '▴' : '▾'}`),
      h('button', { class: 'btn', type: 'button', onclick: () => { diaryPick = null; diaryYM = shiftMonth(year, month, 1); openDiary(); }, 'aria-label': '次の月' }, '›')),
    diaryPick ? diaryPickerEl(byDate, year, month) : null,
    h('div', { class: 'calwd' }, [...'日月火水木金土'].map((w) => h('span', {}, w))),
    h('div', { class: 'calgrid' }, grid.weeks.flat().map(cell)),
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, '距離は、アプリを開いている間の位置から数えています（画面を消している間は数えません）。Strava などの経路（GPX）を取り込むと、その日の距離も経路の値になります。'),
  ];
}
function diaryDayNodes(date) {
  const d = diaryDays().get(date) || { date, visits: [], seals: [], meals: [] };
  const empty = !d.visits.length && !d.seals.length && !d.meals.length && !distText(dist.days[date]);
  // 前の日・次の日へ（記録のない日も1日ずつ）。月をまたいだら、カレンダーに戻ったときもその月
  const go = (n) => { diaryDay = shiftDay(date, n); diaryYM = { year: Number(diaryDay.slice(0, 4)), month: Number(diaryDay.slice(5, 7)) }; openDiary(); };
  const wrap = h('div', { class: 'daywrap' },
    h('button', { class: 'btn', type: 'button', style: 'margin-bottom:10px', onclick: () => { diaryDay = null; openDiary(); } }, '‹ カレンダーへ'),
    h('section', { class: 'day' },
      h('div', { class: 'dayhead' },
        h('button', { class: 'btn daynav', type: 'button', 'aria-label': '前の日', onclick: () => go(-1) }, '‹'),
        h('h3', {}, fmtDate(d.date)),
        h('button', { class: 'btn daynav', type: 'button', 'aria-label': '次の日', onclick: () => go(1) }, '›')),
      distText(dist.days[d.date]) ? h('p', { class: 'muted', style: 'margin:0 0 6px' }, `移動：${distText(dist.days[d.date])}`) : null,
      d.visits.map((v) => {
        const s = spotById(v.spotId);
        const canGo = (s && Number.isFinite(s.lat)) || (Number.isFinite(v.lat) && Number.isFinite(v.lng));
        const row = h('div', { class: 'stampline' + (canGo ? ' go' : '') },
          h('span', { class: 'mini' + (v.seasonal ? ' season' : '') }, glyphOf(s ? s.name : '?')),
          h('span', {}, `${s ? s.name : v.spotId}${v.seasonal ? '　季節の判子' : ''}`),
          h('span', { class: 'muted', style: 'margin-left:auto' }, MODE_VERB[v.mode] || '', canGo ? ' ›' : ''));
        // 押すと、地図のその場所へ移ってカードを開く（位置のない判子は押せない）
        if (canGo) { row.setAttribute('role', 'button'); row.tabIndex = 0; row.onclick = () => showOnMap(v.spotId, v.lat, v.lng); }
        return row;
      }),
      d.meals.map((m) => h('div', { class: 'rec' + (m.photoId ? '' : ' nophoto'), style: 'margin-top:6px' },
        m.photoId ? viewable(imgFor(m.photoId, 'ph'), () => [itemOfMeal(m)]) : null,
        h('div', {}, h('div', { class: 't' }, `ご当地　${m.name}`), m.note ? h('div', { class: 'n', style: 'white-space:normal' }, m.note) : null))),
      d.seals.map((s) => h('div', { style: 'margin-top:6px' }, sealRow(s, true))),
      empty ? h('p', { class: 'muted' }, '記録はありません。') : null));
  // 左右になでても移れる（縦のなでは、シートを閉じる・スクロールに任せる）
  let sx = 0, sy = 0;
  wrap.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]; const dx = t.clientX - sx; const dy = t.clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Math.abs(dx) > Math.abs(dy) * 2) go(dx > 0 ? -1 : 1);
  }, { passive: true });
  return [wrap];
}

// ---------- 印を記録する ----------
const recordDraft = { spotId: '', type: SEAL_TYPES[0], lat: null, lng: null };
function openRecord() {
  const draft = { ...recordDraft };
  recordDraft.spotId = '';
  let photoBlob = null;
  let picked = null;
  const init = sealDraft({ spotId: draft.spotId, visits: state.visits, spotById, pos: state.pos, acc: state.acc, now: now() });
  let typeTouched = false; let dateTouched = false;
  const date = h('input', { type: 'date', value: init.date, oninput: () => { dateTouched = true; } });
  const note = h('textarea', { placeholder: 'ひとこと' });
  const prefSel = h('select', {}, h('option', { value: '' }, '（未選択）'), PREFS.map((p) => h('option', { value: p.name }, p.name)));
  const preview = h('img', { class: 'preview', alt: '', hidden: true });
  const center = state.pos || (mainMap ? mainMap.getCenter() : TOKYO);
  const near = allLoaded().map((s) => ({ s, d: distanceMeters(center, s) })).sort((a, b) => a.d - b.d).slice(0, 20);
  const spotSel = h('select', {}, h('option', { value: '' }, '（場所を選ばない）'),
    near.map(({ s, d }) => h('option', { value: s.id }, `${s.name}（${fmtDist(d)}）`)));
  if (init.spotId && !near.some((n) => n.s.id === init.spotId)) {
    const s = spotById(init.spotId);
    if (s) spotSel.append(h('option', { value: s.id }, s.name));
  }
  spotSel.value = init.spotId;
  const syncPref = () => { const s = spotSel.value ? spotById(spotSel.value) : null; if (s && s.pref) prefSel.value = s.pref; };
  let type = init.type;
  const chips = h('div', { class: 'chips' });
  const drawChips = () => chips.replaceChildren(...SEAL_TYPES.map((t) => h('button', { class: 'chip' + (t === type ? ' on' : ''), type: 'button', onclick: () => { type = t; typeTouched = true; drawChips(); updateFoodHint(); } }, t)));
  spotSel.addEventListener('change', () => {
    picked = null; syncPref();
    const s = spotSel.value ? spotById(spotSel.value) : null;
    if (s && !typeTouched) { type = sealTypeFor(s) || MEMO_TYPE; drawChips(); }
  });
  syncPref();
  drawChips();
  // 「写真・メモ」でひとことに郷土料理らしい名前を書いたら、ご当地グルメの記録として誘う（軽い連携）
  const foodHint = h('div', { class: 'f', hidden: true });
  const updateFoodHint = () => {
    const key = type === MEMO_TYPE ? classifyFood(note.value, state.foods) : null;
    const food = key ? state.foods.find((f) => f.key === key) : null;
    foodHint.hidden = !food;
    if (food) foodHint.replaceChildren(h('button', {
      class: 'chip', type: 'button', onclick: () => { closeSheet(); openMealRecord(food); },
    }, `「${food.name}」（${food.pref}）の記録にする？`));
  };
  note.addEventListener('input', updateFoodHint);
  const pickBox = h('div');
  const pickBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
    pickBtn.hidden = true;
    const el = h('div', { class: 'pickmap' });
    pickBox.append(el, h('p', { class: 'muted' }, '地図をタップして場所を指します'));
    const map = makeMap(el, { center: [center.lat, center.lng], zoom: 12 });
    let pin = null;
    map.on('click', (ev) => { picked = { lat: ev.latlng.lat, lng: ev.latlng.lng }; spotSel.value = ''; if (pin) pin.setLatLng(ev.latlng); else pin = L.marker(ev.latlng).addTo(map); });
    setTimeout(() => map.invalidateSize(), 50);
  } }, '地図で指す');
  const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    save.disabled = true;
    try {
      let photoId = null;
      if (photoBlob) { photoId = db.newId(); await db.put('photos', { id: photoId, blob: photoBlob }); }
      const spot = spotSel.value ? spotById(spotSel.value) : null;
      const seal = { id: db.newId(), type, at: date.value || todayStr(now()), spotId: spot ? spot.id : null, pref: prefSel.value, note: note.value.trim(), photoId };
      if (spot) {
        // その日のその場所の判子とつなぐ。無ければ一緒に押す
        const have = state.visits.find((v) => v.spotId === spot.id && todayStr(new Date(v.at)) === seal.at);
        if (have) seal.visitId = have.id;
        else {
          const visit = { id: db.newId(), spotId: spot.id, at: new Date(`${seal.at}T12:00:00`).getTime(), lat: Number.isFinite(spot.lat) ? spot.lat : null, lng: Number.isFinite(spot.lng) ? spot.lng : null, mode: state.mode, seasonal: !!seasonOf(spot, seal.at), source: 'seal' };
          await db.put('visits', visit);
          await addShopMeals(spot, visit);
          seal.visitId = visit.id;
        }
      }
      if (picked) { seal.lat = picked.lat; seal.lng = picked.lng; } else if (spot && Number.isFinite(spot.lat)) { seal.lat = spot.lat; seal.lng = spot.lng; }
      await db.put('seals', seal);
      await loadData();
      closeSheet();
      render();
      toast('記録しました');
    } catch (err) { save.disabled = false; toast('保存できませんでした：' + (err && err.message ? err.message : err)); }
  } }, '記録する');
  showSheet(null, [h('div', { class: 'form' },
    h('h2', { style: 'font-size:20px' }, '記録する'),
    h('p', { class: 'sub', style: 'margin:0' }, '写真とひとことだけでも残せます。御朱印などの印をいただいたら、種類を選んでください。'),
    h('div', { style: 'display:flex;gap:8px' },
      h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); pickPhotosForImport(); } }, '写真からまとめて判子'),
      h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); pickGpxForImport(); } }, '経路（GPX）から')),
    h('div', { class: 'f' }, h('div', { class: 'muted' }, '種類'), chips),
    h('label', { class: 'f' }, '日付', date),
    h('div', { class: 'f' }, h('div', { class: 'muted' }, '写真'), h('div', { class: 'photoRow' },
      h('label', { class: 'btn', style: 'display:grid;place-items:center;cursor:pointer' }, '写真を選ぶ',
        h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const d = readExifDate(await f.arrayBuffer());
            if (d && !dateTouched) date.value = d;
          } catch { /* 日付が読めなくても続ける */ }
          try { photoBlob = await resizePhoto(f); preview.src = URL.createObjectURL(photoBlob); preview.hidden = false; } catch (err) { toast(err.message); }
        } })), preview)),
    h('label', { class: 'f' }, '近くの場所', spotSel), pickBtn, pickBox,
    h('label', { class: 'f' }, '都道府県', prefSel),
    h('label', { class: 'f' }, 'ひとこと', note),
    foodHint,
    save)]);
}

// ---------- 写真からまとめて判子 ----------
// 写真をまとめて選ぶ→確かめる画面なしで、撮影日・撮影位置から当てはまる判子を全部押す。
// 押した分には importId を付けておき、「まとめて取り消す」でその回の分だけ外せるようにする。
function pickPhotosForImport() {
  showSheet(null, [
    h('h2', { style: 'font-size:20px;margin:0 0 8px' }, '写真からまとめて判子'),
    h('p', { class: 'sub', style: 'margin:0 0 8px' }, '旅の写真をまとめて選ぶと、写真の撮影日と撮影場所から、その日に行った場所へ判子を押します。確かめる画面はなく、あとで「まとめて取り消す」で外せます。'),
    h('ul', { class: 'welcome' },
      h('li', {}, '次に出るメニューで「写真ライブラリ」を選びます'),
      h('li', {}, '写真を指でなぞると、まとめて選べます。選んだら「オプション」で「位置情報」をオンにしてから「追加」'),
      h('li', {}, '判子の場所から150mくらいまでの写真なら押せます。読むのは撮影日と撮影場所だけで、写真はこの端末の外に送りません')),
    h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
      h('button', { class: 'btn primary', type: 'button', style: 'flex:1', onclick: () => { closeSheet(); pickPhotoFiles(); } }, '写真を選ぶ'),
      h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'やめる')),
  ]);
}
function pickPhotoFiles() {
  // HEIC も並べておく（image/* だけだと iPhone が JPEG に変換して渡し、そのとき撮影日時と位置を消すことがある 2026-10-14）
  const input = h('input', { type: 'file', accept: 'image/*,image/heic,image/heif,.heic,.heif', multiple: true, hidden: true, onchange: async (e) => {
    const files = [...e.target.files];
    input.remove();
    if (files.length) await runPhotoImport(files);
  } });
  document.body.append(input);
  input.click();
}

async function runPhotoImport(files) {
  toast(`${files.length}枚を調べています…`);
  const photos = [];
  for (const file of files) {
    let date = null; let lat = null; let lng = null; let exif = false; let err = ''; let sum = null;
    try {
      const buf = await file.arrayBuffer();
      const v = new DataView(buf);
      exif = v.byteLength >= 4 && (v.getUint16(0) === 0xffd8 ? new Uint8Array(buf, 0, Math.min(buf.byteLength, 128 * 1024)).some((b, i, a) => b === 0x45 && a[i + 1] === 0x78 && a[i + 2] === 0x69 && a[i + 3] === 0x66) : findTiffStart(v) >= 0);
      date = readExifDate(buf);
      const gps = readExifGPS(buf); // 位置が消されている写真は null のまま（位置なし扱い）
      if (gps) { lat = gps.lat; lng = gps.lng; }
      if (!date || !gps) sum = exifSummary(buf);
    } catch (e) { err = String(e && e.message || e); /* 読めない写真は位置なし扱いで続ける */ }
    photos.push({ file, date, lat, lng, exif, err, sum });
  }
  const spots = await spotsAround(photos, 0.03);
  const { matches, withoutLocation, withoutSpot, nearest, noLocation } = matchPhotoStamps(photos, spots, state.visits);
  // 位置が読めなかった写真のうち、前にスキップしたものは出さない
  const skipped = await skippedPhotoKeys();
  const pending = noLocation.filter((i) => !skipped.has(photoKey(photos[i].file)));
  const importId = db.newId();
  const pendingBtn = pending.length ? h('button', { class: 'btn', type: 'button', style: 'width:100%;margin-top:6px', onclick: () => openUnlocatedPhotos(photos, pending, importId) }, `位置が読めなかった写真 ${pending.length}枚を見る`) : null;
  if (!matches.length) {
    // 理由が分かるように、トーストではなく画面で出す
    const lines = [];
    const stripped = photos.filter((p) => p.sum && !p.sum.date && !p.sum.gps).length;
    if (stripped) lines.push(`撮影日時と位置が消されて渡された写真：${stripped}枚。iPhone が写真を小さく変換して渡すときに消しています。写真を選んだあと上の「オプション」で「位置情報」をオンにし、形式があれば「現在」を選んでください。それでも消えるときは、メニューの「ファイルを選択」から選ぶと元の情報が残ります。`);
    if (withoutLocation > stripped) lines.push(`位置か日付が読めなかった写真：${withoutLocation - stripped}枚。写真を選ぶ画面の「オプション」で「位置情報」をオンにすると読めます。`);
    if (withoutSpot) lines.push(`近くに判子の場所がなかった写真：${withoutSpot}枚。${nearest ? `いちばん近かったのは「${nearest.name}」で ${fmtDist(nearest.distance)} でした（${PHOTO_SLACK_METERS + 50}m くらいまでなら押せます）。` : ''}`);
    if (!withoutLocation && !withoutSpot) lines.push('写真の日付の判子は、もう押してありました。');
    // 写真ごとに何が読めたか（原因を調べるため。ファイル名・形式・大きさ・EXIF・日付・位置）
    const detail = h('details', { style: 'margin:4px 0 8px' }, h('summary', { class: 'muted', style: 'cursor:pointer' }, 'くわしく（写真ごとに読めたもの）'),
      h('ul', { class: 'muted', style: 'font-size:12px;padding-left:18px;margin:6px 0 0;word-break:break-all' }, photos.slice(0, 20).map((p) => h('li', {},
        `${p.file.name || '(名前なし)'}・${p.file.type || '形式不明'}・${(p.file.size / 1048576).toFixed(1)}MB・EXIF ${p.exif ? 'あり' : 'なし'}・日付 ${p.date || 'なし'}・位置 ${Number.isFinite(p.lat) ? 'あり' : 'なし'}${p.err ? `・エラー ${p.err}` : ''}${p.sum ? `［中身：タグ${p.sum.ifd0 ?? '?'}個（${(p.sum.tags || []).join(' ')}）・撮影情報${p.sum.exif ? 'あり' : 'なし'}・撮影日時${p.sum.date ? 'あり' : 'なし'}・GPS${p.sum.gps ? `あり（${p.sum.gpsTags}）` : 'なし'}${p.sum.error ? `・${p.sum.error}` : ''}］` : ''}`))));
    showSheet(null, [
      h('h2', { style: 'font-size:18px;margin:0 0 6px' }, '判子は付きませんでした'),
      ...lines.map((t) => h('p', { class: 'sub', style: 'margin:0 0 8px' }, t)),
      detail,
      pendingBtn,
      h('button', { class: 'btn primary', type: 'button', style: 'width:100%;margin-top:6px', onclick: closeSheet }, '閉じる'),
    ], () => sheetEl.classList.add('small'));
    return;
  }
  const placeSet = new Set();
  const blobCache = new Map();
  for (const m of matches) {
    const spot = spotById(m.spotId);
    if (!spot) continue;
    const photo = photos[m.photoIndex];
    let photoId = null;
    try {
      if (!blobCache.has(m.photoIndex)) blobCache.set(m.photoIndex, await resizePhoto(photo.file));
      photoId = db.newId();
      await db.put('photos', { id: photoId, blob: blobCache.get(m.photoIndex) });
    } catch { /* 写真が保存できなくても判子は付ける */ }
    const visit = { id: db.newId(), spotId: spot.id, at: new Date(`${m.date}T12:00:00`).getTime(), lat: Number.isFinite(spot.lat) ? spot.lat : null, lng: Number.isFinite(spot.lng) ? spot.lng : null, mode: state.mode, seasonal: !!seasonOf(spot, m.date), source: 'photo', importId };
    await db.put('visits', visit);
    const seal = { id: db.newId(), type: sealTypeFor(spot) || MEMO_TYPE, at: m.date, spotId: spot.id, pref: spot.pref || '', note: '', photoId, visitId: visit.id, importId };
    await db.put('seals', seal);
    await addShopMeals(spot, visit, { importId });
    placeSet.add(spot.id);
  }
  await loadData();
  render();
  showImportResult(files.length, placeSet.size, withoutLocation, withoutSpot, importId, pendingBtn);
}

// ---------- 位置が読めなかった写真（95） ----------
// スキップした写真は、設定の「スキップした写真をもう一度見る」まで次の取り込みから出さない
async function skippedPhotoKeys() { return new Set((await db.getSetting('skippedPhotos', [])) || []); }
async function addSkippedPhotos(keys) {
  const cur = await skippedPhotoKeys();
  keys.forEach((k) => cur.add(k));
  await db.setSetting('skippedPhotos', [...cur].slice(-5000));
}
// 写真1枚を、選んだ場所に押す（撮影日。無ければ今日）。同じ日に同じ場所が押してあれば false
async function stampFromPhoto(photo, spot, importId) {
  const date = photo.date || todayStr(now());
  if (stampedOn(state.visits, spot.id, new Date(`${date}T12:00:00`))) return false;
  let photoId = null;
  try {
    const id = db.newId();
    await db.put('photos', { id, blob: await resizePhoto(photo.file) });
    photoId = id;
  } catch { /* 写真が保存できなくても判子は付ける */ }
  const visit = { id: db.newId(), spotId: spot.id, at: new Date(`${date}T12:00:00`).getTime(), lat: Number.isFinite(spot.lat) ? spot.lat : null, lng: Number.isFinite(spot.lng) ? spot.lng : null, mode: state.mode, seasonal: !!seasonOf(spot, date), source: 'photo' };
  await db.put('visits', visit);
  await db.put('seals', { id: db.newId(), type: sealTypeFor(spot) || MEMO_TYPE, at: date, spotId: spot.id, pref: spot.pref || '', note: '', photoId, visitId: visit.id, importId });
  await addShopMeals(spot, visit, { importId });
  state.visits.push(visit);
  return true;
}
function openUnlocatedPhotos(photos, pending, importId) {
  const objUrls = [];
  const items = new Map(); // 写真の番号 → 行の要素
  const head = h('p', { class: 'sub', style: 'margin:0 0 8px' });
  const updateHead = () => { head.textContent = `位置が読めなかった写真 ${items.size}枚。場所を探して選ぶと、その写真の撮影日（無ければ今日）で判子を押します。`; };
  const finishOne = (i) => {
    const el = items.get(i); if (el) el.remove();
    items.delete(i); updateHead();
    if (!items.size) { toast('おわりました'); closeSheet(); }
  };
  const skipAll = h('button', { class: 'btn', type: 'button', onclick: async () => {
    await addSkippedPhotos([...items.keys()].map((i) => photoKey(photos[i].file)));
    toast(`${items.size}枚をスキップしました`); closeSheet();
  } }, 'まとめてスキップ');
  const choose = async (i, spot) => {
    const ok = await stampFromPhoto(photos[i], spot, importId);
    if (ok) { await loadData(); render(); toast(`${spot.name}に判子を押しました`); } else toast('その日のその場所の判子は、もう押してあります');
    finishOne(i);
  };
  const rowFor = (i) => {
    const p = photos[i];
    const url = URL.createObjectURL(p.file); objUrls.push(url);
    const results = h('div', { class: 'ucands' });
    const showCands = (spots) => results.replaceChildren(...(spots.length ? spots.map((s) => h('button', { class: 'btn ucand', type: 'button', onclick: () => choose(i, s) }, `${s.name}${s.pref ? `（${s.pref}）` : ''}${s._d != null ? `　${fmtDist(s._d)}` : ''}`)) : [h('p', { class: 'muted', style: 'margin:4px 0' }, '見つかりませんでした')]));
    const run = (e) => {
      const q = normalizeName(e.target.value);
      if (!q) { results.replaceChildren(); return; }
      const hits = allListSpots().filter((s) => Number.isFinite(s.lat) && (normalizeName(s.name).includes(q) || (kanaMap && (kanaMap.get(s.id) || '').includes(q)))).slice(0, 8);
      showCands(hits);
    };
    const input = h('input', { class: 'search', type: 'search', placeholder: '場所の名前・読みで探す', autocomplete: 'off', onfocus: ensureKana, oninput: (e) => { if (!e.isComposing) run(e); }, oncompositionend: run });
    const mapBox = h('div', { class: 'umapbox' });
    const mapBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
      if (mapBox.firstChild) return;
      const el = h('div', { class: 'umap' }); mapBox.append(el, h('p', { class: 'muted', style: 'margin:4px 0' }, '地図を押すと、その近くの場所が出ます'));
      const center = state.pos ? [state.pos.lat, state.pos.lng] : [TOKYO.lat, TOKYO.lng];
      const map = makeMap(el, { center, zoom: 14, zoomControl: true });
      let pin = null;
      map.on('click', async (ev) => {
        if (pin) pin.remove();
        pin = L.circleMarker(ev.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#b8423a', fillOpacity: 1 }).addTo(map);
        const pt = { lat: ev.latlng.lat, lng: ev.latlng.lng };
        const around = (await spotsAround([pt], 0.01)).filter((s) => Number.isFinite(s.lat))
          .map((s) => ({ ...s, _d: distanceMeters(pt, s) })).filter((s) => s._d <= 600).sort((a, b) => a._d - b._d).slice(0, 8);
        showCands(around);
      });
    } }, '地図で選ぶ');
    const skip = h('button', { class: 'btn', type: 'button', onclick: async () => { await addSkippedPhotos([photoKey(p.file)]); finishOne(i); } }, 'スキップ');
    return h('div', { class: 'uitem' },
      h('div', { class: 'uhead' },
        h('img', { class: 'uthumb', src: url, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }),
        h('div', { style: 'min-width:0;flex:1' },
          h('div', { class: 't', style: 'word-break:break-all' }, p.file.name || '(名前なし)'),
          h('div', { class: 'muted', style: 'font-size:13px' }, p.date ? `撮影日 ${p.date}` : `撮影日なし（今日 ${todayStr(now())} で押します）`))),
      input, results,
      h('div', { style: 'display:flex;gap:8px;margin-top:6px' }, mapBtn, skip),
      mapBox);
  };
  for (const i of pending) items.set(i, rowFor(i));
  updateHead();
  showSheet(null, [
    h('h2', { style: 'font-size:20px;margin:0 0 6px' }, '位置が読めなかった写真'),
    head,
    h('div', { style: 'display:flex;gap:8px;margin-bottom:10px' }, skipAll, h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'あとで')),
    h('div', { class: 'ulist' }, [...items.values()]),
  ]);
  // シートを閉じたら、写真の表示用 URL を解放する
  const watch = setInterval(() => { if (sheetEl.hidden || !document.querySelector('.ulist')) { clearInterval(watch); objUrls.forEach((u) => URL.revokeObjectURL(u)); } }, 1500);
}

// 点（{ lat, lng }）の近くの区画を読み込んで、判定に使う場所を返す（地図を開いていない場所でも判定できるように）
async function spotsAround(points, margin) {
  const keys = new Set();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    for (const k of tilesForBounds(p.lat - margin, p.lng - margin, p.lat + margin, p.lng + margin)) keys.add(k);
  }
  await ensureTiles([...keys]);
  return [...spotsIn([...keys]), ...state.seasonSpots.filter((s) => Number.isFinite(s.lat)), ...points.flatMap((p) => (Number.isFinite(p.lat) && Number.isFinite(p.lng) ? shopsNear(p, margin) : []))];
}

function showImportResult(photoCount, placeCount, withoutLocation, withoutSpot, importId, pendingBtn) {
  toast(`${photoCount}枚から${placeCount}か所に判子。`);
  const extra = [
    withoutLocation ? `位置や日付が分からない写真 ${withoutLocation}枚` : '',
    withoutSpot ? `近くに場所がない写真 ${withoutSpot}枚` : '',
  ].filter(Boolean).join('・');
  showImportSheet('写真から判子', `${photoCount}枚から${placeCount}か所に判子を付けました。${extra ? `（${extra}）` : ''}`, importId, pendingBtn);
}

function showImportSheet(title, text, importId, pendingBtn = null) {
  showSheet(null, [
    h('h2', { style: 'font-size:18px;margin:0 0 6px' }, title),
    h('p', { class: 'sub', style: 'margin:0 0 14px' }, text),
    pendingBtn ? h('div', { style: 'margin:0 0 12px' }, pendingBtn) : null,
    h('div', { style: 'display:flex;gap:8px;justify-content:center' },
      h('button', { class: 'btn', type: 'button', onclick: async () => { await undoImport(importId); closeSheet(); } }, 'まとめて取り消す'),
      h('button', { class: 'btn primary', type: 'button', onclick: closeSheet }, '閉じる')),
  ], () => sheetEl.classList.add('small'));
}

// ---------- 経路（GPX）からまとめて判子 ----------
// Strava・ヘルスケアの経路などの GPX を選ぶ→近くを通った場所に「通った」の印を付ける。判子は押さない（写真からの取り込みとは違い、通りかかっただけの場所が多いため）
function pickGpxForImport() {
  showSheet(null, [
    h('h2', { style: 'font-size:20px;margin:0 0 8px' }, '経路（GPX）から通った印'),
    h('p', { class: 'sub', style: 'margin:0 0 8px' }, 'GPX は、歩いた・走った道すじを記録したファイルです。道すじの近くの場所に「通った」の印（地図で実線の枠）を付けます。判子は押しません（判子は、その場で押すか、写真から付けます）。先に別のアプリから書き出して、iPhone の「ファイル」に保存しておく必要があります。'),
    h('ul', { class: 'welcome' },
      h('li', {}, 'Strava：パソコンのブラウザで strava.com を開き、アクティビティの「…」→「GPX をエクスポート」'),
      h('li', {}, 'iPhone のヘルスケア：右上の自分のアイコン →「すべてのヘルスケアデータを書き出す」→「ファイルに保存」。保存された export.zip を「ファイル」アプリで押して開くと、中の apple_health_export → workout-routes に、ワークアウトごとの GPX があります'),
      h('li', {}, '下のボタンで「ファイル」からその GPX を選びます。workout-routes の中なら、右上の「…」→「選択」でまとめて選べます')),
    h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
      h('button', { class: 'btn primary', type: 'button', style: 'flex:1', onclick: () => { closeSheet(); pickGpxFile(); } }, 'GPX ファイルを選ぶ'),
      h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'やめる')),
  ]);
}
function pickGpxFile() {
  // iPhone は accept に拡張子だけだと選べないことがあるので、XML の型も並べる
  const input = h('input', { type: 'file', accept: '.gpx,application/gpx+xml,application/xml,text/xml', multiple: true, hidden: true, onchange: async (e) => {
    const files = [...e.target.files];
    input.remove();
    if (files.length) await runGpxImport(files);
  } });
  document.body.append(input);
  input.click();
}

async function runGpxImport(files) {
  toast(`${files.length}件の経路を調べています…`);
  let points = [];
  for (const file of files) {
    try { points = points.concat(parseGpx(await file.text())); } catch { /* 読めないファイルは飛ばす */ }
  }
  if (!points.length) { toast('経路の点が見つかりませんでした（GPX のファイルか確かめてください）'); return; }
  const stops = gpxStops(points);
  const dated = stops.filter((p) => p.date);
  if (!dated.length) { toast('経路に日時が入っていないため、判子は付けられませんでした'); return; }
  // その日の距離（日記の「散歩 2.4km（約3,400歩）」）も、経路の方が長ければ経路の値にする（アプリを開いていない間に歩いた分が入る）
  for (const [day, rec] of Object.entries(gpxDayDistances(points))) {
    const cur = dist.days[day] || (dist.days[day] = {});
    for (const [mode, m] of Object.entries(rec)) if (m > (cur[mode] || 0)) { cur[mode] = m; dist.dirty = true; }
  }
  await saveDist();
  const spots = await spotsAround(dated, 0.005);
  // 判子は押さず、近くを通った場所（立ち寄った場所も）を全部「通った」にする
  const { stamps, passed: passedList } = matchGpxVisits(points, spots, state.visits);
  const p = passed(); const pp = passedPos();
  const spotOf = new Map(spots.map((x) => [x.id, x]));
  let passedCount = 0;
  for (const it of [...stamps, ...passedList]) {
    if (!p[it.spotId]) passedCount++;
    p[it.spotId] = Math.max(p[it.spotId] || 0, it.time || 0);
    const sp = spotOf.get(it.spotId);
    if (sp && Number.isFinite(sp.lat)) pp[it.spotId] = [sp.lat, sp.lng];
  }
  savePassed();
  drawMap();
  toast(passedCount ? `経路から、通った場所 ${passedCount}か所に印を付けました（判子は押していません）` : '経路の近くに、新しく通った場所はありませんでした');
}

async function undoImport(importId) {
  const [visits, seals] = await Promise.all([db.getAll('visits'), db.getAll('seals')]);
  for (const s of seals) {
    if (s.importId !== importId) continue;
    if (s.photoId) await db.remove('photos', s.photoId);
    await db.remove('seals', s.id);
  }
  for (const v of visits) if (v.importId === importId) await db.remove('visits', v.id);
  for (const m of await db.getAll('meals')) if (m.importId === importId) await db.remove('meals', m.id);
  await loadData();
  render();
  toast('取り消しました');
}

// ---------- データを守る ----------
const LS = 'tabigoyomi.';
function backupState(update) {
  let cur = {};
  try { cur = JSON.parse(localStorage.getItem(LS + 'backup') || '{}') || {}; } catch { cur = {}; }
  if (update) { cur = { ...cur, ...update }; try { localStorage.setItem(LS + 'backup', JSON.stringify(cur)); } catch { /* 保存できなくても続ける */ } }
  return cur;
}
async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* 対応していなければそのまま */ }
}
const recordCount = () => state.visits.length + state.seals.length;
function maybeRemindBackup() {
  const b = backupState();
  if (!shouldRemindBackup({ count: recordCount(), lastExportAt: b.at || 0, lastExportCount: b.count || 0, snoozedAt: b.snooze || 0 })) return;
  showSheet(null, [
    h('h2', { style: 'font-size:20px;text-align:center;margin:0 0 6px' }, '書き出しておきませんか？'),
    h('p', { class: 'sub', style: 'text-align:center;margin:0 0 14px' }, 'データはこの端末のブラウザの中だけにあります。機種変更やデータ消去に備えて、ファイルに書き出しておくと安心です。'),
    h('div', { style: 'display:flex;gap:8px;justify-content:center' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => { await exportData(); closeSheet(); } }, '書き出す'),
      h('button', { class: 'btn', type: 'button', onclick: () => { backupState({ snooze: Date.now() }); closeSheet(); } }, 'あとで')),
  ], () => sheetEl.classList.add('small'));
}
async function exportData() {
  try {
    const json = await db.exportAll();
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(json)], { type: 'application/json' })), download: `tabigoyomi-${todayStr()}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    backupState({ at: Date.now(), count: recordCount(), snooze: 0 });
  } catch (err) { toast('書き出せませんでした：' + (err && err.message ? err.message : err)); }
}
async function importData(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await db.importAll(JSON.parse(await f.text()));
    dropPhotoCache();
    await loadData();
    await loadDist();
    render();
    toast(r && r.skippedPhotos ? `読み込みました（写真 ${r.skippedPhotos} 枚は読み込めませんでした）` : '読み込みました');
  } catch (err) { toast('読み込めませんでした：' + (err && err.message ? err.message : err)); }
}
async function wipe() {
  if (!confirm('判子・印・写真をすべて消します。元に戻せません。よろしいですか？')) return;
  if (!confirm('本当に全部消しますか？（先に書き出しておくと安心です）')) return;
  await db.clearAll();
  dropPhotoCache();
  await loadData();
  closeSheet();
  render();
  toast('全部消しました');
}

// ---------- 初めて開いた人への説明 ----------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function welcomed() { try { return localStorage.getItem(LS + 'welcome') === '1'; } catch { return true; } }
function openWelcome(done) {
  const finish = () => { try { localStorage.setItem(LS + 'welcome', '1'); } catch { /* 保存できなくても続ける */ } closeSheet(); done(); };
  showSheet(null, [
    h('h1', { style: 'font-size:24px;margin:4px 0 10px' }, '旅暦へようこそ'),
    h('ul', { class: 'welcome' },
      h('li', {}, '世界遺産・国宝・100名城・一宮・道の駅・名水百選など、行った場所に判子を押す帳面です。場所の近くで「判子を押す」を押します。'),
      h('li', {}, '見頃の月に押すと、絵柄と色が変わる「季節の判子」になります。上のお題は、散歩・サイクリングでは毎日変わる「今日のお題」、旅行ではいま見頃の名所を集めた「今月のお題」です。'),
      h('li', {}, '判子の色は、赤＝いま見頃の名所（季節の判子）、紺＝世界遺産・国宝・名勝・史跡・観光地などの名所、茶＝道の駅、緑＝近所の神社・お寺・温泉・喫茶店など。点線＝まだ、実線の枠＝通った、塗りつぶし＝判子を押した。'),
      h('li', {}, '上の「散歩・サイクリング・旅行」で、今日の旅のしかたを選ぶと、範囲と場所の種類が変わります。散歩・サイクリングは回って戻ると約30分（設定で15・60分にも）のお題、旅行は世界の見頃の名所のお題になります。'),
      h('li', {}, '御朱印などは「＋」から、参拝の記録として写真つきで残せます。'),
      h('li', {}, '位置情報は、近くの場所を知らせて判子を押すためだけに使います。記録も位置も、この端末の中にだけ保存し、外には送りません（地図の画像は国土地理院から読み込みます）。'),
      isStandalone() ? null : h('li', {}, 'ホーム画面に追加すると、アプリのように開けて、データも消えにくくなります。')),
    h('button', { class: 'btn primary', type: 'button', style: 'width:100%;margin-top:8px', onclick: finish }, 'はじめる'),
  ]);
}
// ---------- 初回に一度だけ：これまでの旅を判子に ----------
// ブラウザのアプリは写真や位置の履歴を自分では読めない（毎回選んでもらう必要がある）ので、初回に一度だけ大きく案内する
function importAsked() { try { return localStorage.getItem(LS + 'importAsk') === '1'; } catch { return true; } }
function openImportAsk(done) {
  const go = (fn) => { try { localStorage.setItem(LS + 'importAsk', '1'); } catch { /* 保存できなくても続ける */ } closeSheet(); if (fn) fn(); if (done) done(); };
  showSheet(null, [
    h('h2', { style: 'font-size:22px;margin:4px 0 8px;text-align:center' }, 'これまでの旅も判子にしますか？'),
    h('p', { class: 'sub', style: 'margin:0 0 10px' }, 'スマホの写真の撮影場所と日付から、行った場所にまとめて判子を押します。確かめる画面はなく、あとで「まとめて取り消す」で外せます。写真は端末の外に送りません。'),
    h('p', { class: 'sub', style: 'margin:0 0 14px' }, '次に出るメニューで「写真ライブラリ」を選び、旅の写真を指でなぞってまとめて選びます。「オプション」で「位置情報」をオンにしてから「追加」を押してください（多いほど判子が増えます）。読むのは撮影日と撮影場所だけです。'),
    h('button', { class: 'btn primary', type: 'button', style: 'width:100%;margin-bottom:8px', onclick: () => go(pickPhotoFiles) }, '写真から判子を押す'),
    h('button', { class: 'btn', type: 'button', style: 'width:100%', onclick: () => go(null) }, 'あとで（設定の歯車からいつでも）'),
  ], () => sheetEl.classList.add('small'));
}

function startLocation() {
  getPos().then((pos) => {
    if (!pos || !mainMap) return;
    mainMap.setView([pos.lat, pos.lng], MIN_ZOOM_NEAR);
    setPosDot(pos);
    updateNear();
    drawQuest();
  });
  if (document.visibilityState === 'visible') startWatch();
}

// ---------- 起動 ----------
(async () => {
  try {
    await loadData();
    state.mode = normalizeMode(await db.getSetting('mode', 'walk'));
    await loadDist();
  } catch (err) {
    mapEl.textContent = '保存領域を開けませんでした：' + (err && err.message ? err.message : err);
    return;
  }
  await loadCatalog();
  drawModes();
  initMap();
  render();
  if (!welcomed()) openWelcome(() => { startLocation(); openImportAsk(); });
  else if (!importAsked()) { startLocation(); openImportAsk(); }
  else { startLocation(); maybeRemindBackup(); }
  if (recordCount()) requestPersist();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || !sheetEl.hidden) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
  }
  // 動作確認用：?debug をつけて開くと、ヘッドレスブラウザなどから地図やシートを操作できる
  if (new URLSearchParams(location.search).has('debug')) {
    window.__tabiDebug = { mainMap: () => mainMap, state, openBook, showCard: (id) => { const s = spotById(id); if (s) showCard(s); } };
  }
})();
