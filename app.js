import seasonThemes from './themes/seasons.js';
import * as db from './db.js';
import {
  todayStr, distanceMeters, tilesForBounds, nearestSpot, bearingDeg, canStamp, stampedOn, fitSize,
  modeAllows, spotsForMode, seasonOf, monthlyQuests, listProgress, prefsVisited, groupByDay, shouldRemindBackup,
  sealTypeFor, shouldAutoStamp, sealDraft, readExifDate,
  MODES, TIERS, PREFS, NEAR_METERS,
} from './logic.js';

const GSI_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const WD_ATTR = '<a href="https://www.wikidata.org/" target="_blank" rel="noopener">Wikidata</a>（CC0）';
const TOKYO = { lat: 35.681236, lng: 139.767125 };
const TIER_COLOR = { far: '#2b4c7e', day: '#1f7a8c', town: '#7a8f5b' };
const SEAL_COLOR = '#b8423a';
const MODE_VERB = { walk: '歩いて', bike: '自転車で', train: '電車で', car: '車で' };
const SEAL_TYPES = ['御朱印', '御城印', '鉄印', '御船印', '灯台御守印', 'その他'];
const MIN_ZOOM_ALL = 10; // これより引いているときは遠征級だけ

const $ = (id) => document.getElementById(id);
const mapEl = $('map'); const questEl = $('quest'); const nearEl = $('near'); const modesEl = $('modes');
const fabEl = $('fab'); const scrim = $('scrim'); const sheetEl = $('sheet'); const sheetBody = $('sheetbody');
const grabEl = $('grab'); const toastEl = $('toast'); const locateEl = $('locate');

const state = { visits: [], seals: [], mode: 'walk', pos: null, acc: null, posAt: 0, maps: [], lists: [], catalog: new Map(), seasonSpots: [], tab: 'spots', fixes: [] };
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
  [state.visits, state.seals] = await Promise.all([db.getAll('visits'), db.getAll('seals')]);
}
const fetchJson = (url, fallback) => fetch(url).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);

// 一覧の定義（data/lists.json）と、季節の名所（themes/seasons.js）を地点にする
async function loadCatalog() {
  const [lists, coords] = await Promise.all([fetchJson('data/lists.json', { lists: [] }), fetchJson('data/seasons-coords.json', {})]);
  state.lists = lists.lists.map((l) => ({ key: l.key, name: l.name, note: l.note, tier: l.tier }));
  for (const l of lists.lists) {
    for (const [id, name, pref, hasCoord] of l.items) {
      const cur = state.catalog.get(id) || { id, name, pref, hasCoord: !!hasCoord, lists: [] };
      cur.lists.push(l.key);
      state.catalog.set(id, cur);
    }
  }
  state.seasonSpots = seasonThemes.map((s) => {
    const c = coords[s.key] || (s.qid && coords[s.qid]) || null;
    const lat = Number.isFinite(s.lat) ? s.lat : c ? c.lat : null;
    const lng = Number.isFinite(s.lng) ? s.lng : c ? c.lng : null;
    return {
      id: `s_${s.key}`, kind: 'season', name: s.name, pref: s.pref || '', lat, lng, tier: s.tier || 'day', radius: s.radius || 50,
      lists: ['seasons'], seasons: [{ months: s.months, label: s.label, mark: s.mark }], note: s.note || '',
    };
  });
  state.lists.push({ key: 'seasons', name: '季節の名所', note: '見頃の月に行くと季節の判子', tier: 'day' });
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
        if (list) tiles.set(key, list.map(([id, kind, name, lat, lng, tier, radius, lists, pref]) => ({ id, kind, name, lat, lng, tier, radius, lists, pref })));
      }));
  }
  return tilePending.get(key);
}
const ensureTiles = (keys) => Promise.all(keys.filter((k) => !tiles.has(k)).map(loadTile));
const spotsIn = (keys) => keys.flatMap((k) => tiles.get(k) || []);
const allLoaded = () => [...[...tiles.values()].flat(), ...state.seasonSpots.filter((s) => Number.isFinite(s.lat))];
function spotById(id) {
  for (const list of tiles.values()) { const s = list.find((x) => x.id === id); if (s) return s; }
  return state.seasonSpots.find((s) => s.id === id) || state.catalog.get(id) || null;
}

// ---------- 地図の共通部品 ----------
function makeMap(el, opts = {}) {
  const map = L.map(el, opts);
  L.tileLayer(GSI_URL, { attribution: GSI_ATTR, maxZoom: 18 }).addTo(map);
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
  sheet.redo = null;
  sheetEl.hidden = true;
  sheetEl.classList.remove('small');
  scrim.hidden = true;
  sheetEl.style.transform = '';
  destroyMaps();
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
  if (b.dataset.open === 'book') openBook();
  else if (b.dataset.open === 'diary') openDiary();
  else openRecord();
});
function render() {
  drawMap();
  drawQuest();
  if (!sheetEl.hidden && sheet.redo) sheet.redo();
}

// ---------- 判子の状態 ----------
const visitsOf = (spotId) => state.visits.filter((v) => v.spotId === spotId);
const seasonalVisitsOf = (spotId) => visitsOf(spotId).filter((v) => v.seasonal);
const sameMonth = (v, d) => { const x = new Date(v.at); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth(); };

function hankoIcon(spot) {
  const isSeason = !!spot.seasons;
  const mine = isSeason ? seasonalVisitsOf(spot.id) : visitsOf(spot.id);
  const color = isSeason ? SEAL_COLOR : TIER_COLOR[spot.tier] || TIER_COLOR.day;
  const cls = ['hanko', isSeason ? 'season' : '', mine.length ? '' : 'empty', mine.length ? 'dbl' : ''].filter(Boolean).join(' ');
  const mark = isSeason ? spot.seasons[0].mark : glyphOf(spot.name);
  const node = mine.length
    ? h('div', { class: cls, style: `--c:${color}` }, h('div', { class: 'face' }, h('span', {}, mark)), mine.length >= 2 ? h('span', { class: 'cnt' }, mine.length) : null)
    : h('div', { class: cls, style: `--c:${color}` }, h('span', { class: 'g' }, mark));
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
  L.tileLayer(GSI_URL, { attribution: GSI_ATTR, maxZoom: 18 }).addTo(mainMap);
  mainMap.attributionControl.addAttribution(WD_ATTR);
  layer = L.layerGroup().addTo(mainMap);
  mainMap.setView([TOKYO.lat, TOKYO.lng], 12);
  mainMap.on('moveend', scheduleDraw);
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
  const keys = tilesForBounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
  await ensureTiles(keys);
  if (seq !== drawSeq) return;
  const far = mainMap.getZoom() < MIN_ZOOM_ALL;
  const list = [...spotsIn(keys), ...state.seasonSpots.filter((s) => Number.isFinite(s.lat))]
    .filter((s) => b.contains([s.lat, s.lng]) && modeAllows(s, state.mode) && (!far || s.tier === 'far'))
    .slice(0, 300);
  layer.clearLayers();
  markers.clear();
  for (const s of list) {
    const m = L.marker([s.lat, s.lng], { icon: hankoIcon(s), title: s.name }).on('click', () => showCard(s));
    m.addTo(layer);
    markers.set(s.id, m);
  }
}

function showCard(spot) {
  closeCard();
  const d = now();
  const season = seasonOf(spot, d);
  const pos = state.pos;
  const dist = pos ? distanceMeters(pos, spot) : null;
  const mine = visitsOf(spot.id);
  card = h('div', { class: 'spotcard' },
    h('h3', {}, spot.name),
    h('p', { class: 'sub', style: 'margin:2px 0 6px' },
      h('span', { class: 'tag ' + spot.tier }, TIERS[spot.tier]),
      spot.seasons ? h('span', { class: 'tag season' }, `${spot.seasons[0].months.map((m) => m + '月').join('・')} ${spot.seasons[0].label}`) : null,
      spot.pref ? ` ${spot.pref}` : '', dist !== null ? `　${fmtDist(dist)}` : ''),
    spot.note ? h('p', { style: 'margin:4px 0' }, spot.note) : null,
    season ? h('p', { class: 'muted', style: 'margin:4px 0' }, `いまは見頃（${season.label}）。ここで押すと季節の判子です。`) : null,
    h('p', { class: 'muted', style: 'margin:4px 0' }, mine.length ? `判子 ${mine.length} 回` : 'まだ判子はありません'),
    h('div', { style: 'display:flex;gap:8px;margin-top:6px' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => stamp(spot) }, '判子を押す'),
      h('button', { class: 'btn', type: 'button', onclick: closeCard }, '閉じる')));
  document.body.append(card);
}

function setPosDot(pos) {
  if (!mainMap) return;
  if (posDot) posDot.setLatLng([pos.lat, pos.lng]);
  else posDot = L.circleMarker([pos.lat, pos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2f6fdb', fillOpacity: 1, interactive: false }).addTo(mainMap);
}

// ---------- 判子を押す ----------
let stamping = false;
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
    await loadData();
    closeCard();
    await celebrate(spot);
    render();
    openStamped(spot, season);
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
    h('p', { style: 'text-align:center;margin:8px 0 14px' }, '御朱印などをもらったなら、印を記録できます。'),
    h('div', { style: 'display:flex;gap:8px;justify-content:center' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => { recordDraft.spotId = spot.id; openRecord(); } }, '印を記録する'),
      h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'あとで')),
  ], () => sheetEl.classList.add('small'));
}

// ---------- 旅のしかた ----------
function drawModes() {
  modesEl.replaceChildren(...Object.entries(MODES).map(([k, m]) =>
    h('button', {
      class: 'mode' + (k === state.mode ? ' on' : ''), type: 'button', 'aria-pressed': String(k === state.mode),
      onclick: async () => { state.mode = k; await db.setSetting('mode', k); drawModes(); drawMap(); drawQuest(); updateNear(); },
    }, m.label, h('small', {}, `${m.range / 1000}km`))));
}

// ---------- 今月のお題 ----------
function currentQuests() {
  return monthlyQuests(state.seasonSpots, now(), state.mode, state.pos);
}
function questDone(spot) {
  const d = now();
  return seasonalVisitsOf(spot.id).some((v) => sameMonth(v, d));
}
function drawQuest() {
  const d = now();
  const qs = currentQuests();
  const got = qs.filter(questDone).length;
  questEl.onclick = openQuests;
  questEl.setAttribute('aria-label', `${d.getMonth() + 1}月のお題`);
  questEl.replaceChildren(
    h('div', { class: 'qtop' },
      h('b', { class: 'qtitle' }, `${d.getMonth() + 1}月のお題`),
      h('span', { class: 'muted' }, 'いま見頃の場所'),
      qs.length ? h('span', { class: 'qcount' }, `${got}/${qs.length}`) : null),
    qs.length
      ? h('div', { class: 'qrow' }, qs.map((s) => h('div', { class: 'qchip' + (questDone(s) ? ' got' : '') },
        h('span', { class: 'qm' }, s.seasons[0].mark),
        h('span', { class: 'qn' }, s.name),
        s.distance !== null ? h('span', { class: 'qd' }, fmtDist(s.distance)) : null)))
      : h('p', { class: 'muted', style: 'margin:4px 0 0' }, '今月が見頃の名所は、まだ登録がありません'));
}
function openQuests() {
  const qs = currentQuests();
  showSheet(openQuests, [
    h('h2', { style: 'font-size:20px;margin:0 0 4px' }, `${now().getMonth() + 1}月のお題`),
    h('p', { class: 'sub' }, `見頃の月に行って判子を押すと、季節の判子になります。旅のしかた（${MODES[state.mode].label}）と今いる場所に合わせて並べています。`),
    h('ul', { class: 'list' }, qs.map((s) => h('li', {},
      h('button', { class: 'rec nophoto', type: 'button', onclick: () => { closeSheet(); focusSpot(s); } },
        h('div', {},
          h('div', { class: 't' }, `${s.name}　${s.seasons[0].label}${questDone(s) ? '（押した）' : ''}`),
          h('div', { class: 'n' }, [s.pref, TIERS[s.tier], s.distance !== null ? fmtDist(s.distance) : ''].filter(Boolean).join('・')),
          s.note ? h('div', { class: 'n', style: 'white-space:normal' }, s.note) : null))))),
    qs.length ? null : h('p', { class: 'muted' }, '今月が見頃の名所は、まだ登録がありません。'),
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
// 位置の履歴（直近5分）。自動の判子の「しばらくいた」「ゆっくり」の判定に使う
function pushFix(speed) {
  const t = Date.now();
  state.fixes.push({ lat: state.pos.lat, lng: state.pos.lng, acc: state.acc, at: t, speed: Number.isFinite(speed) ? speed : null });
  state.fixes = state.fixes.filter((f) => t - f.at <= 5 * 60000);
}
function onWatch(p) {
  state.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
  state.acc = p.coords.accuracy;
  state.posAt = Date.now();
  pushFix(p.coords.speed);
  setPosDot(state.pos);
  if (mainMap && follow && sheetEl.hidden && !stamping) mainMap.panTo([state.pos.lat, state.pos.lng], { animate: !reduceMotion() });
  updateNear();
  autoStamp();
}
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
  const cands = [...spotsIn(keys), ...state.seasonSpots].filter((s) => Number.isFinite(s.lat))
    .map((s) => ({ s, d: distanceMeters(pos, s) })).sort((a, b) => a.d - b.d);
  const hit = cands.find(({ s }) => !undone.has(s.id) && shouldAutoStamp(s, state.fixes, state.mode, state.visits, now()));
  if (!hit) return;
  const spot = hit.s;
  stamping = true;
  try {
    const season = seasonOf(spot, now());
    const visit = { id: db.newId(), spotId: spot.id, at: now().getTime(), lat: pos.lat, lng: pos.lng, mode: state.mode, seasonal: !!season, source: 'auto' };
    await db.put('visits', visit);
    await loadData();
    drawMap();
    render();
    const msg = season ? `${spot.name}の季節の判子（${season.label}）を押しました` : `${spot.name}の判子を押しました`;
    autoNote = { spot, visitId: visit.id, msg };
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { autoNote = null; nearSig = ''; updateNear(); }, 60000);
    nearSig = '';
    updateNear();
    toast(msg);
    if (setting('vibrate')) navigator.vibrate?.(60);
  } catch (err) {
    toast('保存できませんでした：' + (err && err.message ? err.message : err));
  } finally {
    stamping = false;
  }
}
async function undoAuto(note) {
  try {
    await db.remove('visits', note.visitId);
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
  const cands = [...spotsIn(keys), ...state.seasonSpots].filter((s) => Number.isFinite(s.lat));
  const best = nearestSpot(pos, cands);
  drawNear(best && best.distance <= Math.max(NEAR_METERS, (best.spot.radius || 0) + 100) ? best : null);
}
function drawNear(best) {
  if (autoNote && best && best.spot.id !== autoNote.spot.id) autoNote = null;
  if (autoNote) {
    const note = autoNote;
    nearSig = '';
    nearEl.replaceChildren(...[
      h('div', { class: 'nearmain' }, h('span', { class: 'nt', style: 'white-space:normal' }, note.msg)),
      sealTypeFor(note.spot) ? h('button', { class: 'nearpush', type: 'button', onclick: () => { recordDraft.spotId = note.spot.id; openRecord(); } }, '印を記録') : null,
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
  nearEl.replaceChildren(...[
    h('button', { class: 'nearmain', type: 'button', onclick: () => focusSpot(spot) },
      h('span', { class: 'arrow', style: `transform:rotate(${deg}deg)`, 'aria-hidden': 'true' }, '↑'),
      h('span', { class: 'nt' }, `${spot.name} まで ${fmtDist(distance)}`)),
    can && !done ? h('button', { class: 'nearpush', type: 'button', onclick: () => stamp(spot) }, season ? `季節の判子を押す（${season.label}）` : '判子を押す') : null].filter(Boolean));
  nearEl.hidden = false;
  document.body.classList.add('hasnear');
}

// ---------- 帳面 ----------
function openBook() {
  const tabs = [['spots', '場所'], ['seals', '印'], ['prefs', '都道府県'], ['more', 'その他']];
  const body = state.tab === 'seals' ? bookSeals() : state.tab === 'prefs' ? bookPrefs() : state.tab === 'more' ? bookMore() : bookSpots();
  showSheet(openBook, [
    h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', {
      class: 'tab' + (state.tab === k ? ' on' : ''), type: 'button', onclick: () => { state.tab = k; openBook(); },
    }, label))),
    body,
  ]);
}

function allListSpots() { return [...state.catalog.values(), ...state.seasonSpots]; }

function bookSpots() {
  const spots = allListSpots();
  return state.lists.map((l) => {
    const p = listProgress(state.visits, spots, l.key);
    const isSeason = l.key === 'seasons';
    return h('section', {},
      h('div', { class: 'listhead' }, h('b', {}, l.name), h('span', { class: 'muted' }, l.note || ''), h('span', { class: 'n' }, `${p.count} / ${p.total}`)),
      p.total ? h('div', { class: 'masus' }, p.cells.map((c) => h('button', {
        class: 'masu' + (c.got ? ' got' : '') + (c.hasCoord ? '' : ' nocoord') + (isSeason ? ' season' : ''), type: 'button',
        style: `--c:${TIER_COLOR[l.tier] || TIER_COLOR.day}`, title: c.name,
        onclick: () => toast(`${c.name}${c.pref ? `（${c.pref}）` : ''}${c.hasCoord ? '' : '　位置が未登録のため判子は押せません'}`),
      }, glyphOf(c.name)))) : h('p', { class: 'muted' }, 'まだ登録がありません'),
      p.total ? h('details', { class: 'spotlist' }, h('summary', { class: 'muted' }, '名前の一覧'),
        p.cells.map((c) => h('div', { class: 'row' + (c.got ? ' got' : '') },
          h('span', {}, `${c.got ? '● ' : ''}${c.name}`),
          h('span', { class: 'muted' }, c.hasCoord ? c.pref : `${c.pref} 位置未登録`)))) : null);
  });
}

function bookSeals() {
  const list = [...state.seals].sort((a, b) => (a.at < b.at ? 1 : -1));
  return [
    h('p', { class: 'sub' }, '参拝・乗船などの記録です。数や順位は出しません。'),
    list.length
      ? h('ul', { class: 'list' }, list.map((s) => h('li', {}, sealRow(s, true))))
      : h('p', { class: 'muted' }, 'まだ記録がありません。下の「＋」から残せます。'),
  ];
}

function sealRow(s, withDelete) {
  const spot = s.spotId ? spotById(s.spotId) : null;
  const where = [spot ? spot.name : '', s.pref].filter(Boolean).join('・');
  return h('div', { class: 'rec' + (s.photoId ? '' : ' nophoto') },
    s.photoId ? imgFor(s.photoId, 'ph') : null,
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

function bookPrefs() {
  const counts = prefsVisited(state.visits, state.seals, [], allListSpots());
  const byPos = new Map(PREFS.map((p) => [`${p.row}_${p.col}`, p]));
  const cells = [];
  for (let r = 0; r <= 13; r++) {
    for (let c = 0; c < 10; c++) {
      const p = byPos.get(`${r}_${c}`);
      cells.push(p
        ? h('div', { class: 'pref' + (counts[p.name] ? ' got' : ''), title: p.name }, h('span', {}, p.name.replace(/[都道府県]$/, '') || p.name), counts[p.name] ? h('b', {}, counts[p.name]) : null)
        : h('div', {}));
    }
  }
  // 空の行（12 行目）は詰める
  const rows = [];
  for (let r = 0; r <= 13; r++) { if (r !== 12) rows.push(...cells.slice(r * 10, r * 10 + 10)); }
  const visited = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return [
    h('p', { class: 'sub' }, `判子と印のある都道府県：${visited.length} / 47`),
    h('div', { class: 'prefgrid' }, rows),
    visited.length ? h('div', { class: 'spotlist' }, visited.map(([p, n]) => h('div', { class: 'row' }, h('span', {}, p), h('span', { class: 'muted' }, `${n}`)))) : h('p', { class: 'muted' }, 'まだありません'),
  ];
}

function bookMore() {
  return [
    h('div', { class: 'setrow' },
      h('button', { class: 'btn', type: 'button', onclick: exportData }, '書き出す（判子・印・写真）'),
      h('label', { class: 'btn', style: 'display:grid;place-items:center;cursor:pointer' }, '読み込む',
        h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importData })),
      h('button', { class: 'btn danger', type: 'button', onclick: wipe }, '全部消す')),
    h('div', { class: 'setrow' },
      h('label', { style: 'display:flex;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: setting('auto'), onchange: (e) => setSetting('auto', e.target.checked) }), '自動で判子を押す（アプリを開いている間）'),
      h('label', { style: 'display:flex;gap:8px;align-items:center' },
        h('input', { type: 'checkbox', checked: setting('vibrate'), onchange: (e) => setSetting('vibrate', e.target.checked) }), '押したら振動する'),
      h('p', { class: 'muted', style: 'margin:0' }, '画面を消している間は位置を取れないので押せません。')),
    h('p', { class: 'muted' }, 'データはこの端末の中だけにあります。機種変更の前に書き出してください。'),
    h('p', { class: 'muted' }, '出典：地図 ' + '国土地理院（淡色地図）／場所のデータ Wikidata（CC0）。位置情報は端末の外には送りません。'),
  ];
}

// ---------- 日記 ----------
function openDiary() {
  const days = groupByDay(state.visits, state.seals);
  showSheet(openDiary, [
    h('h2', { style: 'font-size:20px;margin:0 0 8px' }, '日記'),
    days.length ? days.map((d) => h('section', { class: 'day' },
      h('h3', {}, fmtDate(d.date)),
      d.visits.map((v) => {
        const s = spotById(v.spotId);
        return h('div', { class: 'stampline' },
          h('span', { class: 'mini' + (v.seasonal ? ' season' : '') }, glyphOf(s ? s.name : '?')),
          h('span', {}, `${s ? s.name : v.spotId}${v.seasonal ? '　季節の判子' : ''}`),
          h('span', { class: 'muted', style: 'margin-left:auto' }, MODE_VERB[v.mode] || ''));
      }),
      d.seals.map((s) => h('div', { style: 'margin-top:6px' }, sealRow(s, false)))))
      : h('p', { class: 'muted' }, 'まだ記録がありません。'),
  ]);
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
  const drawChips = () => chips.replaceChildren(...SEAL_TYPES.map((t) => h('button', { class: 'chip' + (t === type ? ' on' : ''), type: 'button', onclick: () => { type = t; typeTouched = true; drawChips(); } }, t)));
  spotSel.addEventListener('change', () => {
    picked = null; syncPref();
    const s = spotSel.value ? spotById(spotSel.value) : null;
    if (s && !typeTouched) { type = sealTypeFor(s) || '御朱印'; drawChips(); }
  });
  syncPref();
  drawChips();
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
    h('h2', { style: 'font-size:20px' }, '印を記録する'),
    h('p', { class: 'sub', style: 'margin:0' }, '御朱印などをいただいた参拝・乗船の記録です。'),
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
    save)]);
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
    await db.importAll(JSON.parse(await f.text()));
    dropPhotoCache();
    await loadData();
    render();
    toast('読み込みました');
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
      h('li', {}, '世界遺産・名水百選・重伝建など、行った場所に判子を押す帳面です。場所の近くで「判子を押す」を押します。'),
      h('li', {}, '見頃の月に押すと、絵柄と色が変わる「季節の判子」になります。上の「今月のお題」は、いま見頃の場所です。'),
      h('li', {}, '上の「徒歩・自転車・電車・車」で、今日の旅のしかたを選ぶと、範囲と場所の種類が変わります。'),
      h('li', {}, '御朱印などは「＋」から、参拝の記録として写真つきで残せます。'),
      h('li', {}, '位置情報は、近くの場所を知らせて判子を押すためだけに使います。記録も位置も、この端末の中にだけ保存し、外には送りません（地図の画像は国土地理院から読み込みます）。'),
      isStandalone() ? null : h('li', {}, 'ホーム画面に追加すると、アプリのように開けて、データも消えにくくなります。')),
    h('button', { class: 'btn primary', type: 'button', style: 'width:100%;margin-top:8px', onclick: finish }, 'はじめる'),
  ]);
}
function startLocation() {
  getPos().then((pos) => {
    if (!pos || !mainMap) return;
    mainMap.setView([pos.lat, pos.lng], 14);
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
    state.mode = await db.getSetting('mode', 'walk');
  } catch (err) {
    mapEl.textContent = '保存領域を開けませんでした：' + (err && err.message ? err.message : err);
    return;
  }
  await loadCatalog();
  drawModes();
  initMap();
  render();
  if (welcomed()) { startLocation(); maybeRemindBackup(); } else openWelcome(startLocation);
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
})();
