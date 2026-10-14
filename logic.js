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
export const NEAR_KINDS = { onsen: '温泉', sento: '銭湯', shrine: '神社', temple: 'お寺', lighthouse: '灯台', museum: '博物館・記念館', sight: '名所', viewpoint: '展望', bakery: 'パン屋', cafe: '喫茶店', teishoku: '定食屋' };
// 旅のしかたは3つ（2026-10-14 に 徒歩・自転車・車・電車・飛行機 から分け直した）
export const MODES = {
  walk: { label: '散歩', range: 2000 },
  bike: { label: 'サイクリング', range: 10000 },
  trip: { label: '旅行', range: 20100000, note: '世界' }, // 地球上のどの2点でも届く距離（対極点のきょり、約20,000km）
};
// 前の版で保存した旅のしかた（車・電車・飛行機）は旅行にする
export function normalizeMode(mode) { return MODES[mode] ? mode : ['car', 'train', 'plane'].includes(mode) ? 'trip' : 'walk'; }

// 旅のしかたで出す場所か。どの旅のしかたでも全部出す（2026-10-14：旅行でも近所の場所を消さない。旅先の神社や喫茶店も押せるように）
export function modeAllows(spot, mode) {
  return true;
}

// 旅のしかたで範囲と種類を絞る。位置があれば range 以内だけを、近い順に distance 付きで返す。位置がなければ種類だけで絞る
export function spotsForMode(spots, mode, pos) {
  const range = (MODES[normalizeMode(mode)]).range;
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

// 月の一覧（1〜12、順不同でも可）を「4〜6月・10〜11月」のように、連続した月を「〜」でまとめて表す。
// 12→1月のように年をまたいで連続する分も1つにまとめる（例：[12,1,2] → "12〜2月"）
export function formatBestMonths(months) {
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const runs = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const m = sorted[i];
    if (m === end + 1) { end = m; continue; }
    runs.push([start, end]); start = m; end = m;
  }
  runs.push([start, end]);
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][1] === 12) {
    runs[0][0] = runs.pop()[0];
  }
  return runs.map(([a, b]) => (a === b ? `${a}月` : `${a}〜${b}月`)).join('・');
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
  const range = (MODES[normalizeMode(mode)]).range;
  const withD = inSeason.map((s) => ({ ...s, distance: distanceMeters(pos, s) })).sort((a, b) => a.distance - b.distance);
  // 範囲の外は出さない（自転車なのに 100km 先の名所がお題に出ていた）
  return withD.filter((s) => s.distance <= range && modeAllows(s, mode)).slice(0, limit);
}

// 徒歩・自転車で見頃の名所が範囲に少ないとき、近くのまだ判子のない場所から「今日のお題」を選ぶ。
// 日付と id から決まる順で選ぶので、同じ日のうちは顔ぶれが変わらない（歩いて範囲が動いた分だけ入れ替わる）。
// stampedToday：今日判子を押した id（押した印を付けて残す）、stampedBefore：前に押した id（出さない）
export const DAILY_MODES = ['walk', 'bike'];
// minutes：回って戻る時間（設定の 15・30・60 分）
export function dailyQuests(spots, date, mode, pos, stampedToday, stampedBefore, limit = 3, minutes = LOOP_MINUTES) {
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
  // 散歩・サイクリング：回って戻るとちょうどいい運動量になる 2〜3か所を、回る順に。loop は道のりの見積もり（m）
  if (LOOP_TARGET[mode] && limit >= 2) {
    const r = walkLoopQuests(cands, pos, day, hash, loopTarget(mode, minutes));
    if (r.spots.length) return r.spots.slice(0, limit).map((s) => ({ ...s, loop: r.meters }));
  }
  // 自転車：日付で混ぜた順に、まだ選んでいない分類（ご飯・寺社・その他）→ 種類 を先に取る
  const mixed = cands.sort((a, b) => hash(day + a.id) - hash(day + b.id));
  const out = []; const cats = new Set(); const kinds = new Set();
  for (const s of mixed) { if (out.length >= limit) break; if (!cats.has(questCategory(s))) { out.push(s); cats.add(questCategory(s)); kinds.add(s.kind); } }
  for (const s of mixed) { if (out.length >= limit) break; if (!out.includes(s) && !kinds.has(s.kind)) { out.push(s); kinds.add(s.kind); } }
  for (const s of mixed) { if (out.length >= limit) break; if (!out.includes(s)) out.push(s); }
  return out.sort((a, b) => a.distance - b.distance);
}

// 今日のお題（散歩・サイクリング）は、毎日続けるトレーニングとして、今いる所から2〜3か所を回って戻ると約30分になる組み合わせにする。
// 根拠：厚生労働省「健康づくりのための身体活動・運動ガイド2023」。成人は身体活動を1日60分以上（約8,000歩、通勤・家事を含む）、
// 加えて息が弾み汗をかく程度の運動を週60分以上。20〜64歳の平均歩数は男性8,564歩・女性7,287歩（令和6年国民健康・栄養調査）で、
// 身体活動は普段の生活で目安に近い人が多い。足りないのは運動のほうなので、少し速めの散歩（やや速歩 4.3メッツ）か
// ゆっくりのサイクリング（16km/h 未満 4.0メッツ）を毎日30分。最短の持続時間はない（ガイドの Q&A）ので、30分を上限の目安にする。
// 道は直線より長いので、直線距離に WALK_DETOUR を掛けて見積もる
export const LOOP_MINUTES = 30;
export const LOOP_SPEED_KMH = { walk: 5, bike: 15 };
export const WALK_TARGET_METERS = LOOP_SPEED_KMH.walk * 1000 * LOOP_MINUTES / 60; // 2,500m
export const BIKE_TARGET_METERS = LOOP_SPEED_KMH.bike * 1000 * LOOP_MINUTES / 60; // 7,500m
export const LOOP_TARGET = { walk: WALK_TARGET_METERS, bike: BIKE_TARGET_METERS };
export const LOOP_MINUTE_CHOICES = [15, 30, 60];
export const loopTarget = (mode, minutes = LOOP_MINUTES) => (LOOP_SPEED_KMH[mode] || 0) * 1000 * minutes / 60;
export const WALK_DETOUR = 1.25;
export const STEP_METERS = 0.7;
export const KIND_DUP_PENALTY = 600; // m 相当
export const CATEGORY_DUP_PENALTY = 2500; // m 相当。分類が重なるのは、道のりが多少ずれるより避けたい
// 今日のお題は「ご飯」「寺社」「その他」から1つずつ出す
const FOOD_KINDS = ['cafe', 'bakery', 'teishoku'];
const SACRED_KINDS = ['shrine', 'temple'];
export function questCategory(spot) {
  if (FOOD_KINDS.includes(spot.kind)) return 'food';
  if (SACRED_KINDS.includes(spot.kind)) return 'sacred';
  return 'other';
}
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
// 候補から、ご飯・寺社・その他が1つずつで、回る道のりが target にいちばん近い 3か所（なければ 2か所）を選ぶ。同じくらいなら日付で決まる順。
// 候補は日付で混ぜた先頭 pool 件に絞る（組み合わせが多すぎないように）
export function walkLoopQuests(cands, pos, day, hash, target = WALK_TARGET_METERS, pool = 24) {
  // 分類ごとに日付で混ぜた先頭から同じ数ずつ取る（喫茶店ばかりの都心でも、寺社やその他が候補に残るように）
  // 行って戻るだけで道のりを超える遠い場所は候補にしない（範囲いっぱいから取ると、遠い場所どうしの組み合わせしか残らなかった）
  const reach = (target / (2 * WALK_DETOUR)) * 1.1;
  const nearCands = cands.filter((x) => x.distance <= reach);
  const mixed = [...(nearCands.length >= 3 ? nearCands : cands)].sort((a, b) => hash(day + a.id) - hash(day + b.id));
  const per = Math.ceil(pool / 3);
  const list = ['food', 'sacred', 'other'].flatMap((c) => mixed.filter((x) => questCategory(x) === c).slice(0, per));
  // 分類が足りない場所（神社しかない等）では、残りを混ぜた順で足して pool 件にする
  for (const x of mixed) { if (list.length >= pool) break; if (!list.includes(x)) list.push(x); }
  let best = null;
  const kindCount = new Set(list.map((x) => x.kind)).size;
  const catCount = new Set(list.map(questCategory)).size;
  for (const k of [3, 2]) {
    if (list.length < k) continue;
    const idx = Array.from({ length: k }, (_, i) => i);
    for (;;) {
      const picked = idx.map((i) => list[i]);
      const loop = bestLoop(pos, picked);
      // 同じ種類ばかり（神社とお寺だけ等）にならないよう、種類が重なるごとに減点する
      // 候補に種類が足りず避けられない重なりは数えない（全部神社なら3か所とも神社でよい）
      const dup = picked.length - new Set(picked.map((x) => x.kind)).size - Math.max(0, k - kindCount);
      const catDup = picked.length - new Set(picked.map(questCategory)).size - Math.max(0, k - catCount);
      const score = Math.abs(loop.meters - target) + dup * KIND_DUP_PENALTY + catDup * CATEGORY_DUP_PENALTY;
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

// ---------- ご当地グルメ ----------
// 品名から図鑑（foods：{ key, name, pref, summary, ... }）の項目を当てる。表記ゆれ（ひらがな/カタカナ、「鍋」「汁」の有無）程度を吸収する。当たらなければ null
const bareFoodName = (s) => normalizeName(s).replace(/(鍋|汁)$/, '');
export function classifyFood(name, foods) {
  const t = bareFoodName(name);
  if (!t || !Array.isArray(foods)) return null;
  let best = null;
  let bestLen = 0;
  for (const f of foods) {
    for (const w of [f.name, f.kana, ...(f.aliases || [])]) {
      if (!w) continue;
      const n = bareFoodName(w);
      if (n && t.includes(n) && n.length > bestLen) { best = f.key; bestLen = n.length; }
    }
  }
  return best;
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

// ---------- 国 ----------
// 世界に広がる一覧（世界遺産など）の、国ごとの進み具合。listProgress の国版
export function countryProgress(visits, spots, country) {
  const cells = spots.filter((s) => (s.country || '日本') === country).map((s) => {
    const mine = visits.filter((v) => v.spotId === s.id && (!Array.isArray(s.seasons) || v.seasonal));
    return { id: s.id, name: s.name, pref: s.pref || '', hasCoord: s.hasCoord !== undefined ? !!s.hasCoord : Number.isFinite(s.lat), got: mine.length > 0, visits: mine.length };
  });
  return { country, count: cells.filter((c) => c.got).length, total: cells.length, cells };
}

// spots に出てくる国の一覧（重複なし）
export function countriesOf(spots) {
  return [...new Set(spots.map((s) => s.country || '日本'))];
}

// 判子を押した国ごとの数 { 国名: 件数 }
export function countriesVisited(visits, spots) {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const out = {};
  for (const v of visits || []) {
    const c = (byId.get(v.spotId) || {}).country || '日本';
    out[c] = (out[c] || 0) + 1;
  }
  return out;
}

// ---------- 日記（カレンダー） ----------
// year・month（1〜12）の月を1つ進める／戻す。年をまたぐ分は Date に任せる
export function shiftMonth(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// 月のカレンダーのマス。日曜始まりで、前後の月の日も7の倍数になるまで埋める。
// weeks は7日ずつの配列。各マスは { date: 'YYYY-MM-DD', inMonth }
export function monthGrid(year, month) {
  const first = new Date(year, month - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const toDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const cells = [];
  for (let i = startDow; i > 0; i--) cells.push({ date: toDate(new Date(year, month - 1, 1 - i)), inMonth: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: toDate(new Date(year, month - 1, d)), inMonth: true });
  for (let i = 1; cells.length % 7 !== 0; i++) cells.push({ date: toDate(new Date(year, month - 1, daysInMonth + i)), inMonth: false });
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { year, month, weeks };
}

// ---------- 日記・書き出し ----------
// 日付ごとにまとめて新しい日から。visits は at（ミリ秒）、seals・meals は at（'YYYY-MM-DD'）の日
export function groupByDay(visits, seals, meals = []) {
  const days = new Map();
  const day = (d) => { if (!days.has(d)) days.set(d, { date: d, visits: [], seals: [], meals: [] }); return days.get(d); };
  for (const v of visits) day(todayStr(new Date(v.at))).visits.push(v);
  for (const s of seals) day(s.at).seals.push(s);
  for (const m of meals) day(m.at).meals.push(m);
  for (const d of days.values()) d.visits.sort((a, b) => a.at - b.at);
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// 歩いた・走った距離を積む。fix：{ lat, lng, acc, at }、track：{ last, meters }。新しい track を返す（元は変えない）
// 精度の悪い位置（40m 超）は使わない。精度より小さい・15m 未満の動きは揺れとみなして数えない。
// 10分以上あいたときと、時速90km を超える動き（位置の飛び）は、つながずにそこから数え直す
export const TRACK_MAX_ACC = 40;
export function addTrack(track, fix) {
  const t = { last: track.last || null, meters: track.meters || 0 };
  if (!fix || !Number.isFinite(fix.lat) || !(fix.acc <= TRACK_MAX_ACC)) return t;
  if (!t.last) return { ...t, last: fix };
  const d = distanceMeters(t.last, fix);
  const dt = (fix.at - t.last.at) / 1000;
  if (dt > 600 || dt <= 0) return { ...t, last: fix };
  if (d < Math.max(15, fix.acc)) return t;
  if (d / dt > 25) return { ...t, last: fix };
  return { last: fix, meters: t.meters + d };
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
// JPEG 以外（iPhone の HEIC など）の EXIF：ファイルの中から「Exif  」＋TIFF の頭（II*  / MM *）を探して、その位置を返す。
// HEIC は箱（ISOBMFF）の中に EXIF をそのまま持っているので、箱をたどらなくても見つかる
export function findTiffStart(v) {
  const n = v.byteLength - 10; // 大きな HEIC は EXIF が後ろの方にあることがあるので、全体を探す
  for (let i = 0; i < n; i++) {
    if (v.getUint8(i) !== 0x45 || v.getUint32(i) !== 0x45786966 || v.getUint16(i + 4) !== 0) continue; // 'Exif' 00 00
    const o = v.getUint16(i + 6);
    if ((o === 0x4949 && v.getUint16(i + 8) === 0x2a00) || (o === 0x4d4d && v.getUint16(i + 8) === 0x002a)) return i + 6;
  }
  return -1;
}
export function readExifDate(buf) {
  try {
    const v = new DataView(buf);
    if (v.byteLength >= 4 && v.getUint16(0) !== 0xffd8) { const t = findTiffStart(v); return t < 0 ? null : exifDateFrom(v, t, v.byteLength); }
    if (v.byteLength < 4) return null;
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

// ---------- 写真からまとめて判子 ----------
// JPEG の EXIF から撮影位置 { lat, lng }。GPS 情報がなければ（HEIC が変換されずに来た場合など）null
export function readExifGPS(buf) {
  try {
    const v = new DataView(buf);
    if (v.byteLength >= 4 && v.getUint16(0) !== 0xffd8) { const t = findTiffStart(v); return t < 0 ? null : exifGpsFrom(v, t, v.byteLength); }
    if (v.byteLength < 4) return null;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) return null;
      const marker = v.getUint8(p + 1);
      if (marker === 0xda || marker === 0xd9) return null;
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
        return exifGpsFrom(v, p + 10, p + 2 + len);
      }
      p += 2 + len;
    }
  } catch { /* 壊れていれば null */ }
  return null;
}
function exifGpsFrom(v, t, end) {
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
  const ifd0 = readIfd(v.getUint32(t + 4, le));
  const gpsTag = ifd0.get(0x8825);
  if (!gpsTag) return null;
  const gps = readIfd(v.getUint32(gpsTag.val, le));
  // 度分秒（RATIONAL×3）。緯度・経度とも、符号は参照（N/S・E/W）で付ける
  const dms = (tag) => {
    if (!tag || tag.type !== 5 || tag.count < 3) return null;
    const at = t + v.getUint32(tag.val, le);
    const part = (i) => { const num = v.getUint32(at + i * 8, le); const den = v.getUint32(at + i * 8 + 4, le); return den ? num / den : 0; };
    return part(0) + part(1) / 60 + part(2) / 3600;
  };
  // 参照（ASCII 1 文字 + NUL）は 4 バイト以内なのでタグに収まっている
  const ref = (tag) => (tag ? String.fromCharCode(v.getUint8(tag.val)) : null);
  const lat = dms(gps.get(0x0002));
  const lng = dms(gps.get(0x0004));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: ref(gps.get(0x0001)) === 'S' ? -lat : lat, lng: ref(gps.get(0x0003)) === 'W' ? -lng : lng };
}

// 写真（{ date: 'YYYY-MM-DD'|null, lat, lng }）と場所から、撮影日ごとに押せる判子を選ぶ。
// 一覧の場所・近所の場所の両方を対象に、canStamp の範囲に入るものを全部選ぶ（同じ場所・同じ建物を複数の一覧が指していることがあるため）。
// 同じ日・同じ場所はまとめて1つ（この一括の中の重複も、既に押してある判子も、どちらも増やさない）
// 返り値：matches（{ spotId, date, photoIndex }の配列。photoIndex はその判子に付ける写真の最初の1枚）、
//         withoutLocation（位置か日付が読めなかった写真の数）、withoutSpot（位置はあるが近くに場所がなかった写真の数）
// 写真は少し離れた所から撮ることが多いので、判子の範囲より PHOTO_SLACK_METERS 広く取る（範囲 50m の場所なら 150m 以内）
export const PHOTO_SLACK_METERS = 100;
export function matchPhotoStamps(photos, spots, visits, slack = PHOTO_SLACK_METERS) {
  const matches = [];
  const seen = new Set();
  let withoutLocation = 0;
  let withoutSpot = 0;
  let nearest = null; // 判子が付かなかった写真から、いちばん近かった場所 { name, distance }（理由を伝えるため）
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || !p.date || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) { withoutLocation++; continue; }
    let any = false;
    for (const spot of spots) {
      if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) continue;
      // 緯度の差だけで明らかに遠いものは先に外す（経路は点が多いので、距離の計算を減らす）
      if (Math.abs(p.lat - spot.lat) * 111195 > Math.max(CHECKIN_METERS, Number(spot.radius) || 0)) continue;
      const d = distanceMeters(p, spot);
      if (!canStamp(spot, Math.max(0, d - slack), undefined)) {
        if (!nearest || d < nearest.distance) nearest = { name: spot.name, distance: d };
        continue;
      }
      any = true;
      const key = `${spot.id}_${p.date}`;
      if (seen.has(key) || stampedOn(visits, spot.id, new Date(`${p.date}T12:00:00`))) continue;
      seen.add(key);
      matches.push({ spotId: spot.id, date: p.date, photoIndex: i });
    }
    if (!any) withoutSpot++;
  }
  return { matches, withoutLocation, withoutSpot, nearest: matches.length ? null : nearest };
}

// ---------- GPX（経路）からまとめて判子 ----------
// Strava・ヘルスケアの経路などの GPX から、点（trkpt・rtept・wpt）の { lat, lng, time } を取り出す。
// time は ms（読めなければ null）。点に時刻がなければ <metadata> の時刻を使う。属性の順番や名前空間の接頭辞は問わない
export function parseGpx(text) {
  const src = String(text || '');
  const timeOf = (s) => { const m = /<(?:\w+:)?time>\s*([^<\s]+)\s*</.exec(s); const t = m ? Date.parse(m[1]) : NaN; return Number.isFinite(t) ? t : null; };
  const meta = /<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/.exec(src);
  const fallback = meta ? timeOf(meta[0]) : null;
  const points = [];
  const re = /<(?:\w+:)?(trkpt|rtept|wpt)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g;
  let m;
  while ((m = re.exec(src))) {
    const attr = (name) => { const a = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(m[2]); return a ? Number(a[1]) : NaN; };
    const lat = attr('lat');
    const lng = attr('lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const t = m[4] ? timeOf(m[4]) : null;
    points.push({ lat, lng, time: t !== null ? t : fallback });
  }
  return points;
}

export const GPX_STEP_METERS = 20; // 判子の範囲（50m〜）を通り過ぎても取りこぼさない間隔

// GPX の点を、日ごとに step メートルおきに間引いて { date, lat, lng, time } にする（matchPhotoStamps にそのまま渡せる形）。
// 時刻のない点は date: null（位置や日付が分からない扱い）
export function gpxStops(points, step = GPX_STEP_METERS) {
  const out = [];
  const lastByDate = new Map();
  for (const p of points || []) {
    const date = Number.isFinite(p.time) ? todayStr(new Date(p.time)) : null;
    if (!date) { out.push({ date: null, lat: p.lat, lng: p.lng, time: null }); continue; }
    const last = lastByDate.get(date);
    if (last && distanceMeters(last, p) < step) continue;
    const stop = { date, lat: p.lat, lng: p.lng, time: p.time };
    lastByDate.set(date, stop);
    out.push(stop);
  }
  return out;
}

// GPX の点から、日ごとの移動距離（m）を旅のしかた別に出す：{ 'YYYY-MM-DD': { walk|bike|trip: m } }。
// 点と点が 1km 以上飛んでいるところ（記録の途切れ）は数えない。平均の速さで分ける（時速 8km 未満＝散歩、30km 未満＝サイクリング、それ以上＝旅行の移動）
export function gpxDayDistances(points) {
  const days = {};
  const byDay = new Map();
  for (const p of points || []) {
    if (!Number.isFinite(p.time)) continue;
    const d = todayStr(new Date(p.time));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  for (const [d, list] of byDay) {
    list.sort((a, b) => a.time - b.time);
    let meters = 0; let ms = 0;
    for (let i = 1; i < list.length; i++) {
      const step = distanceMeters(list[i - 1], list[i]);
      if (step >= 1000) continue;
      meters += step; ms += list[i].time - list[i - 1].time;
    }
    if (meters < 50) continue;
    const kmh = ms > 0 ? (meters / 1000) / (ms / 3600000) : 0;
    const mode = kmh < 8 ? 'walk' : kmh < 30 ? 'bike' : 'trip';
    days[d] = { [mode]: Math.round(meters) };
  }
  return days;
}

// 経路（GPX）の点（{ lat, lng, time }）から、立ち寄った場所と通っただけの場所を分ける。
// 立ち寄り＝半径 stopMeters の中に dwellMs 以上とどまった地点。その地点が判子の範囲に入る場所は stamps（その日）。
// 範囲に入っただけの場所は passed（大きな公園や城跡を歩いて通り抜けただけでは押さない）。点の間が maxGapMs より空いたら、とどまったとは数えない
export const GPX_STOP_METERS = 100;
export function matchGpxVisits(points, spots, visits, dwellMs = AUTO_DWELL_MS, stopMeters = GPX_STOP_METERS, maxGapMs = 600000) {
  const pts = (points || []).filter((p) => Number.isFinite(p.time) && Number.isFinite(p.lat) && Number.isFinite(p.lng)).sort((a, b) => a.time - b.time);
  // 場所を 0.01 度の格子に入れて、点ごとに近くの場所だけ見る
  const CELL = 0.01;
  const grid = new Map();
  const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}_${Math.floor(lng / CELL)}`;
  for (const s of spots) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const k = cellKey(s.lat, s.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const near = (p) => {
    const i = Math.floor(p.lat / CELL); const j = Math.floor(p.lng / CELL);
    const out = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const g = grid.get(`${i + di}_${j + dj}`); if (g) out.push(...g); }
    return out;
  };
  // とどまった地点を探す
  const stops = [];
  for (let i = 0; i < pts.length;) {
    let j = i;
    while (j + 1 < pts.length && distanceMeters(pts[i], pts[j + 1]) <= stopMeters && pts[j + 1].time - pts[j].time <= maxGapMs) j++;
    if (pts[j].time - pts[i].time >= dwellMs) {
      const seg = pts.slice(i, j + 1);
      stops.push({ lat: seg.reduce((a, p) => a + p.lat, 0) / seg.length, lng: seg.reduce((a, p) => a + p.lng, 0) / seg.length, time: pts[i].time });
      i = j + 1;
    } else i++;
  }
  const stamps = []; const stamped = new Set();
  for (const st of stops) {
    const date = todayStr(new Date(st.time));
    for (const s of near(st)) {
      const key = `${s.id}_${date}`;
      if (stamped.has(key) || !canStamp(s, distanceMeters(st, s), undefined)) continue;
      stamped.add(key);
      if (!stampedOn(visits, s.id, new Date(`${date}T12:00:00`))) stamps.push({ spotId: s.id, date, time: st.time, lat: st.lat, lng: st.lng });
    }
  }
  const stampedIds = new Set([...stamped].map((k) => k.slice(0, k.lastIndexOf('_'))));
  const passed = new Map();
  for (const p of pts) {
    for (const s of near(p)) {
      if (stampedIds.has(s.id) || passed.has(s.id) || !canStamp(s, distanceMeters(p, s), undefined)) continue;
      passed.set(s.id, { spotId: s.id, time: p.time });
    }
  }
  return { stamps, passed: [...passed.values()] };
}

// 写真の EXIF に何が入っているか（読めなかったときの原因を調べるため）。
// { ifd0: タグの数, tags: IFD0 のタグ番号（16進）, exif: 撮影情報の IFD があるか, date: 撮影日時のタグがあるか, gps: GPS の IFD があるか, gpsTags: GPS のタグの数 }
export function exifSummary(buf) {
  try {
    const v = new DataView(buf);
    let t = -1;
    if (v.byteLength >= 4 && v.getUint16(0) === 0xffd8) {
      let p = 2;
      while (p + 10 <= v.byteLength && v.getUint8(p) === 0xff) {
        const marker = v.getUint8(p + 1);
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) { t = p + 10; break; }
        p += 2 + v.getUint16(p + 2);
      }
    } else t = findTiffStart(v);
    if (t < 0) return null;
    const le = v.getUint16(t) === 0x4949;
    const ifd = (off) => {
      const tags = new Map();
      const n = v.getUint16(t + off, le);
      for (let i = 0; i < n && t + off + 2 + i * 12 + 12 <= v.byteLength; i++) { const e = t + off + 2 + i * 12; tags.set(v.getUint16(e, le), v.getUint32(e + 8, le)); }
      return tags;
    };
    const ifd0 = ifd(v.getUint32(t + 4, le));
    const sub = ifd0.has(0x8769) ? ifd(ifd0.get(0x8769)) : null;
    const gps = ifd0.has(0x8825) ? ifd(ifd0.get(0x8825)) : null;
    return { ifd0: ifd0.size, tags: [...ifd0.keys()].map((k) => k.toString(16)), exif: !!sub, date: !!(sub && sub.has(0x9003)) || ifd0.has(0x0132), gps: !!gps, gpsTags: gps ? gps.size : 0 };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
