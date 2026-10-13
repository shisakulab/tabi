// DOM に触らない純粋関数（菓暦の logic.js から、位置・区画・写真まわりを持ってきて旅向けに足した）

export const PHOTO_MAX = 1280;
export const CHECKIN_METERS = 50;
export const ACCURACY_CAP = 30;
export const NEAR_METERS = 300;
export const TILE_DEG = 0.5;

export const pad2 = (n) => String(n).padStart(2, '0');

// 今日の日付（端末のローカル時間）'YYYY-MM-DD'
export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// 2点間の距離（m）。{lat, lng}
export function distanceMeters(a, b) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 長辺が max に収まるように縮めた大きさ（拡大はしない）
export function fitSize(w, h, max = PHOTO_MAX) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

// 0.5度四方の区画のキー（下端の緯度_経度）。例 35.5_139.5
export function tileKey(lat, lng) {
  const f = (v) => (Math.floor(v / TILE_DEG + 1e-9) * TILE_DEG).toFixed(1);
  return `${f(lat)}_${f(lng)}`;
}

// 範囲（南・西・北・東）にかかる区画のキーの一覧。広すぎる範囲は最大 max 個で打ち切る
export function tilesForBounds(s, w, n, e, max = 64) {
  const keys = [];
  const i0 = Math.floor(s / TILE_DEG + 1e-9);
  const i1 = Math.floor(n / TILE_DEG + 1e-9);
  const j0 = Math.floor(w / TILE_DEG + 1e-9);
  const j1 = Math.floor(e / TILE_DEG + 1e-9);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (keys.length >= max) return keys;
      keys.push(`${(i * TILE_DEG).toFixed(1)}_${(j * TILE_DEG).toFixed(1)}`);
    }
  }
  return keys;
}

// いちばん近い場所と距離。座標のない場所は除く。なければ null
export function nearestSpot(pos, spots) {
  if (!pos) return null;
  let best = null;
  for (const spot of spots) {
    if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) continue;
    const distance = distanceMeters(pos, spot);
    if (!best || distance < best.distance) best = { spot, distance };
  }
  return best;
}

// a から b への方角（北が 0、時計回り、0〜360 度）
export function bearingDeg(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// 立ち寄れるか：距離 − min(位置の誤差, 30m) が 50m 以内（誤差が分からなければ 0 とみなす）
export function canCheckIn(distance, accuracy) {
  const acc = Number.isFinite(accuracy) ? Math.max(0, accuracy) : 0;
  return distance - Math.min(acc, ACCURACY_CAP) <= CHECKIN_METERS;
}

// 判子を押せるか：点の場所は 50m、広い場所は spot.radius（m）以内。誤差の扱いは canCheckIn と同じ
// 下の帯に出す場所。①今いて押せる、今日まだ押していない場所 ②なければ、判子も「通った」もまだの場所でいちばん近いもの（maxMeters まで）。
// 押したり通ったりした場所にいつまでも案内しないため。seen：前に押した・通った id、stampedToday：今日押した id
export const NEXT_METERS = 2000;
export function pickNear(pos, spots, accuracy, stampedToday, seen, maxMeters = NEXT_METERS) {
  if (!pos) return null;
  let here = null; let next = null;
  for (const spot of spots) {
    if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) continue;
    const distance = distanceMeters(pos, spot);
    if (canStamp(spot, distance, accuracy) && !stampedToday.has(spot.id)) {
      if (!here || distance < here.distance) here = { spot, distance };
    } else if (!seen.has(spot.id) && !stampedToday.has(spot.id) && distance <= maxMeters) {
      if (!next || distance < next.distance) next = { spot, distance };
    }
  }
  return here || next;
}

export function canStamp(spot, distance, accuracy) {
  const limit = Math.max(CHECKIN_METERS, Number(spot && spot.radius) || 0);
  const acc = Number.isFinite(accuracy) ? Math.max(0, accuracy) : 0;
  return distance - Math.min(acc, ACCURACY_CAP) <= limit;
}

// 名前の検索用に表記をそろえる
export function normalizeName(s) {
  return (s || '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s・･]/g, '');
}

// ---------- 場所の種類と旅のしかた ----------
// 場所は「一覧に入っている場所」（tier: 'list'。世界遺産・百選・季節の名所など）と「近所の場所」（tier: 'near'。OSM の温泉・銭湯・神社・お寺）の2つ
// 灯台も OSM から取るが、遠くから目当てに行く場所なので tier は 'list'
export const NEAR_KINDS = { onsen: '温泉', sento: '銭湯', shrine: '神社', temple: 'お寺', lighthouse: '灯台' };
export const MODES = {
  walk: { label: '徒歩', range: 2000 },
  bike: { label: '自転車', range: 10000 },
  car: { label: '車', range: 100000 },
  train: { label: '電車', range: 200000 }, // 新幹線・特急で日帰りできるくらい。車（100km）より遠くまで行ける
  plane: { label: '飛行機', range: 3000000, note: '全国' }, // 日本の端から端まで届く距離
};
const FAR_MODES = ['train', 'car', 'plane'];

// 旅のしかたで出す場所か。徒歩・自転車はすべて。電車・車・飛行機は一覧に入っている場所だけ（近所の場所は数が多すぎるので出さない）
export function modeAllows(spot, mode) {
  if (FAR_MODES.includes(mode)) return spot.tier !== 'near';
  return true;
}

// 旅のしかたで範囲と種類を絞る。位置があれば range 以内だけを、近い順に distance 付きで返す。位置がなければ種類だけで絞る
export function spotsForMode(spots, mode, pos) {
  const range = (MODES[mode] || MODES.walk).range;
  const list = spots.filter((s) => modeAllows(s, mode) && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!pos) return list.map((s) => ({ ...s, distance: null }));
  return list.map((s) => ({ ...s, distance: distanceMeters(pos, s) }))
    .filter((s) => s.distance <= range)
    .sort((a, b) => a.distance - b.distance);
}

// ---------- 季節の判子 ----------
const monthOfDate = (date) => {
  if (date instanceof Date) return date.getMonth() + 1;
  if (typeof date === 'number') return new Date(date).getMonth() + 1;
  return Number(String(date).slice(5, 7));
};

// 見頃の月なら、その季節（{ months, label, mark }）。なければ null。date は Date・'YYYY-MM-DD'・ミリ秒
export function seasonOf(spot, date) {
  if (!spot || !Array.isArray(spot.seasons)) return null;
  const m = monthOfDate(date);
  return spot.seasons.find((s) => (s.months || []).includes(m)) || null;
}

// 今月のお題：今月が見頃の場所を最大 limit か所。位置があれば旅のしかたの範囲の中を近い順に、足りなければ範囲の外を近い順に足す。
// 位置がなければ、旅のしかたの格に合う場所を全国から、日付で並びをずらして選ぶ
export function monthlyQuests(spots, date, mode, pos, limit = 5) {
  const m = monthOfDate(date);
  const inSeason = spots.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && seasonOf(s, date));
  const day = date instanceof Date ? date.getDate() : Number(String(date).slice(8, 10)) || 1;
  if (!pos) {
    const list = inSeason.filter((s) => modeAllows(s, mode))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!list.length) return [];
    const k = (day + m) % list.length;
    return [...list.slice(k), ...list.slice(0, k)].slice(0, limit).map((s) => ({ ...s, distance: null }));
  }
  const range = (MODES[mode] || MODES.walk).range;
  const withD = inSeason.map((s) => ({ ...s, distance: distanceMeters(pos, s) })).sort((a, b) => a.distance - b.distance);
  // 範囲の外は出さない（自転車なのに 100km 先の名所がお題に出ていた）
  return withD.filter((s) => s.distance <= range && modeAllows(s, mode)).slice(0, limit);
}

// 徒歩・自転車で見頃の名所が範囲に少ないとき、近くのまだ判子のない場所から「今日のお題」を選ぶ。
// 日付と id から決まる順で選ぶので、同じ日のうちは顔ぶれが変わらない（歩いて範囲が動いた分だけ入れ替わる）。
// stampedToday：今日判子を押した id（押した印を付けて残す）、stampedBefore：前に押した id（出さない）
export const DAILY_MODES = ['walk', 'bike'];
export function dailyQuests(spots, date, mode, pos, stampedToday, stampedBefore, limit = 3) {
  if (!pos || !DAILY_MODES.includes(mode) || limit <= 0) return [];
  const range = MODES[mode].range;
  const day = typeof date === 'string' ? date.slice(0, 10)
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const hash = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return x >>> 0; };
  const seen = new Set();
  const cands = spots
    .filter((s) => {
      if (seen.has(s.id) || !Number.isFinite(s.lat) || !Number.isFinite(s.lng) || Array.isArray(s.seasons)) return false;
      seen.add(s.id);
      return !stampedBefore.has(s.id) || stampedToday.has(s.id);
    })
    .map((s) => ({ ...s, distance: distanceMeters(pos, s), daily: true }))
    .filter((s) => s.distance <= range);
  // 徒歩：回って戻るとちょうどいい運動量になる 2〜3か所を、回る順に。loop は道のりの見積もり（m）
  if (mode === 'walk' && limit >= 2) {
    const r = walkLoopQuests(cands, pos, day, hash);
    if (r.spots.length) return r.spots.slice(0, limit).map((s) => ({ ...s, loop: r.meters }));
  }
  return cands
    .sort((a, b) => hash(day + a.id) - hash(day + b.id))
    .slice(0, limit)
    .sort((a, b) => a.distance - b.distance);
}

// 徒歩の今日のお題は、今いる所から2〜3か所を回って戻ると、ちょうどいい運動量になる組み合わせにする。
// 目安：厚生労働省「健康づくりのための身体活動・運動ガイド2023」の成人 1日8,000歩。普段の生活の歩数もあるので、散歩は約4km（約5,700歩）を狙う。
// 道は直線より長いので、直線距離に WALK_DETOUR を掛けて見積もる
export const WALK_TARGET_METERS = 4000;
export const WALK_DETOUR = 1.25;
export const STEP_METERS = 0.7;
// 今いる所 → 場所を順に → 今いる所、の直線距離がいちばん短い回り方 { order, meters }（meters は道のりの見積もり）
export function bestLoop(pos, spots) {
  const perm = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perm([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  let best = null;
  for (const order of perm(spots)) {
    let d = 0; let at = pos;
    for (const s of order) { d += distanceMeters(at, s); at = s; }
    d += distanceMeters(at, pos);
    if (!best || d < best.straight) best = { order, straight: d };
  }
  return best ? { order: best.order, meters: Math.round(best.straight * WALK_DETOUR) } : { order: [], meters: 0 };
}
// 候補から、回る道のりが target にいちばん近い 3か所（なければ 2か所）を選ぶ。同じくらいなら日付で決まる順。
// 候補は日付で混ぜた先頭 pool 件に絞る（組み合わせが多すぎないように）
export function walkLoopQuests(cands, pos, day, hash, target = WALK_TARGET_METERS, pool = 24) {
  const list = [...cands].sort((a, b) => hash(day + a.id) - hash(day + b.id)).slice(0, pool);
  let best = null;
  for (const k of [3, 2]) {
    if (list.length < k) continue;
    const idx = Array.from({ length: k }, (_, i) => i);
    for (;;) {
      const loop = bestLoop(pos, idx.map((i) => list[i]));
      const score = Math.abs(loop.meters - target);
      if (!best || score < best.score) best = { score, loop };
      // 次の組み合わせ
      let i = k - 1;
      while (i >= 0 && idx[i] === list.length - k + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
    if (best && best.score <= target * 0.25) break; // 3か所でちょうどよいものがあれば、それにする
  }
  if (!best) return { spots: [], meters: 0 };
  return { spots: best.loop.order, meters: best.loop.meters };
}

// ---------- 一覧 ----------
// 見頃（seasons）を持つ場所は、季節の判子（seasonal）を押したときだけ埋まる。それ以外は判子が1つでもあれば埋まる
export function listProgress(visits, spots, listKey) {
  const cells = spots.filter((s) => (s.lists || []).includes(listKey)).map((s) => {
    const mine = visits.filter((v) => v.spotId === s.id && (!Array.isArray(s.seasons) || v.seasonal));
    return { id: s.id, name: s.name, pref: s.pref || '', hasCoord: s.hasCoord !== undefined ? !!s.hasCoord : Number.isFinite(s.lat), got: mine.length > 0, visits: mine.length };
  });
  return { key: listKey, count: cells.filter((c) => c.got).length, total: cells.length, cells };
}

// ---------- 都道府県 ----------
// 47 マスの表（日本地図風）。row・col は表の位置
const GRID = [
  ['北海道', 0, 9], ['青森県', 1, 9], ['秋田県', 2, 8], ['岩手県', 2, 9], ['山形県', 3, 8], ['宮城県', 3, 9],
  ['石川県', 4, 5], ['富山県', 4, 6], ['新潟県', 4, 7], ['福島県', 4, 8],
  ['福井県', 5, 4], ['岐阜県', 5, 5], ['長野県', 5, 6], ['群馬県', 5, 7], ['栃木県', 5, 8], ['茨城県', 5, 9],
  ['島根県', 6, 0], ['鳥取県', 6, 1], ['兵庫県', 6, 2], ['京都府', 6, 3], ['滋賀県', 6, 4], ['愛知県', 6, 5],
  ['山梨県', 6, 6], ['埼玉県', 6, 7], ['東京都', 6, 8], ['千葉県', 6, 9],
  ['広島県', 7, 0], ['岡山県', 7, 1], ['大阪府', 7, 2], ['奈良県', 7, 3], ['三重県', 7, 4], ['静岡県', 7, 5], ['神奈川県', 7, 7],
  ['山口県', 8, 0], ['愛媛県', 8, 1], ['香川県', 8, 2], ['徳島県', 8, 3], ['和歌山県', 8, 4],
  ['福岡県', 9, 0], ['大分県', 9, 1], ['高知県', 9, 2],
  ['佐賀県', 10, 0], ['熊本県', 10, 1], ['宮崎県', 10, 2],
  ['長崎県', 11, 0], ['鹿児島県', 11, 1], ['沖縄県', 13, 0],
];
export const PREFS = GRID.map(([name, row, col]) => ({ name, row, col }));

// 判子・印・体験を記録した都道府県ごとの数 { 都道府県: 件数 }。都道府県が分からないものは数えない
export function prefsVisited(visits, seals, meals, spots) {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const out = {};
  const add = (p) => { if (p) out[p] = (out[p] || 0) + 1; };
  for (const v of visits || []) add((byId.get(v.spotId) || {}).pref);
  for (const s of seals || []) add(s.pref || (byId.get(s.spotId) || {}).pref);
  for (const m of meals || []) add(m.pref || (byId.get(m.spotId) || {}).pref);
  return out;
}

// ---------- 日記・書き出し ----------
// 日付ごとにまとめて新しい日から。visits は at（ミリ秒）、seals は at（'YYYY-MM-DD'）の日
export function groupByDay(visits, seals) {
  const days = new Map();
  const day = (d) => { if (!days.has(d)) days.set(d, { date: d, visits: [], seals: [] }); return days.get(d); };
  for (const v of visits) day(todayStr(new Date(v.at))).visits.push(v);
  for (const s of seals) day(s.at).seals.push(s);
  for (const d of days.values()) d.visits.sort((a, b) => a.at - b.at);
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// visits の spotId を aliases（子 id → 親 id）で張り替える。張り替えた件数も返す（国宝を場所ごとにまとめたときの引っ越し用）
export function remapVisits(visits, aliases) {
  if (!aliases || !Object.keys(aliases).length) return { visits, changed: 0 };
  let changed = 0;
  const out = visits.map((v) => {
    const to = aliases[v.spotId];
    if (!to || to === v.spotId) return v;
    changed++;
    return { ...v, spotId: to };
  });
  return { visits: out, changed };
}

// その場所に今日（date の日）すでに判子があるか
export function stampedOn(visits, spotId, date = new Date()) {
  const d = todayStr(date);
  return visits.some((v) => v.spotId === spotId && todayStr(new Date(v.at)) === d);
}

// 書き出しを勧めるか。前回の書き出しから記録が10件以上増えた、または30日以上たって記録が増えたとき。
// 「あとで」を押してから7日は出さない
const DAY_MS = 24 * 60 * 60 * 1000;
export function shouldRemindBackup({ count, lastExportAt = 0, lastExportCount = 0, snoozedAt = 0, now = Date.now() }) {
  if (!count || count <= lastExportCount) return false;
  if (snoozedAt && now - snoozedAt < 7 * DAY_MS) return false;
  if (count - lastExportCount >= 10) return true;
  return !!lastExportAt && now - lastExportAt >= 30 * DAY_MS;
}

// ---------- 自動の判子・印の自動入力 ----------
export const AUTO_DWELL_MS = 180000; // この間ずっと範囲内にいたら押す（2026-10-13：通っただけで押されるので全部の旅のしかたで滞在を条件に）

// 印の種類を名前から当てる。spot.seal があればそれ。当てられなければ null
// 印をもらわずに、写真とひとことだけ残す記録の種類
export const MEMO_TYPE = '写真・メモ';
export function sealTypeFor(spot) {
  if (!spot) return null;
  if (spot.seal) return spot.seal;
  const name = spot.name || '';
  if (name.includes('城')) return '御城印';
  if (/神社|大社|神宮|宮|稲荷|寺|院|堂|大師|不動/.test(name)) return '御朱印';
  return null;
}

// 開いている間に自動で押してよいか。fixes は新しいものが最後の [{lat, lng, acc, at, speed}]（speed は m/s か null）
export function shouldAutoStamp(spot, fixes, mode, visits, now = new Date()) {
  if (!spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) return false;
  if (!Array.isArray(spot.lists) || !spot.lists.length) return false;
  if (!fixes || !fixes.length) return false;
  if (stampedOn(visits, spot.id, now)) return false;
  const limit = Math.max(CHECKIN_METERS, Number(spot.radius) || 0);
  const inside = (f) => canStamp(spot, distanceMeters(f, spot), f.acc);
  const last = fixes[fixes.length - 1];
  if (!inside(last)) return false;
  if (!(Number.isFinite(last.acc) ? last.acc <= limit : true)) return false;
  // 通っただけでは押さない：どの旅のしかたでも、範囲の中にしばらく（AUTO_DWELL_MS）いたら押す
  let k = fixes.length - 1;
  while (k > 0 && inside(fixes[k - 1])) k--;
  return last.at - fixes[k].at >= AUTO_DWELL_MS;
}

// 印の記録の初期値 { spotId, type, date }。spotId が無ければ、今日の判子のうち今いる場所のものを新しい順に探す
export function sealDraft({ spotId, visits = [], spotById, pos, acc, now = new Date() }) {
  const date = todayStr(now);
  let id = spotId || '';
  if (!id && pos) {
    const d = date;
    const today = visits.filter((v) => todayStr(new Date(v.at)) === d).sort((a, b) => b.at - a.at);
    for (const v of today) {
      const s = spotById(v.spotId);
      if (s && Number.isFinite(s.lat) && canStamp(s, distanceMeters(pos, s), acc)) { id = s.id; break; }
    }
  }
  const spot = id ? spotById(id) : null;
  // 印のない場所（銭湯・道の駅など）や場所を選ばないときは、写真とひとことだけの記録にする
  return { spotId: id, type: (spot && sealTypeFor(spot)) || MEMO_TYPE, date };
}

// JPEG の EXIF から撮影日 'YYYY-MM-DD'（DateTimeOriginal、無ければ DateTime）。読めなければ null
export function readExifDate(buf) {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) return null;
      const marker = v.getUint8(p + 1);
      if (marker === 0xda || marker === 0xd9) return null;
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
        return exifDateFrom(v, p + 10, p + 2 + len);
      }
      p += 2 + len;
    }
  } catch { /* 壊れていれば null */ }
  return null;
}
function exifDateFrom(v, t, end) {
  const order = v.getUint16(t);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  if (v.getUint16(t + 2, le) !== 42) return null;
  const readIfd = (off) => {
    const tags = new Map();
    const n = v.getUint16(t + off, le);
    for (let i = 0; i < n; i++) {
      const e = t + off + 2 + i * 12;
      if (e + 12 > end) break;
      tags.set(v.getUint16(e, le), { type: v.getUint16(e + 2, le), count: v.getUint32(e + 4, le), val: e + 8 });
    }
    return tags;
  };
  const str = (tag) => {
    if (!tag || tag.type !== 2 || tag.count < 10) return null;
    const at = tag.count > 4 ? t + v.getUint32(tag.val, le) : tag.val;
    let s = '';
    for (let i = 0; i < 10; i++) s += String.fromCharCode(v.getUint8(at + i));
    const m = /^(\d{4}):(\d{2}):(\d{2})$/.exec(s);
    return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const ifd0 = readIfd(v.getUint32(t + 4, le));
  const sub = ifd0.get(0x8769) ? readIfd(v.getUint32(ifd0.get(0x8769).val, le)) : null;
  return (sub && str(sub.get(0x9003))) || str(ifd0.get(0x0132)) || null;
}
