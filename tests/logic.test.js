import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters, tileKey, tilesForBounds, nearestSpot, bearingDeg, canCheckIn, canStamp, fitSize, todayStr, MODES,
  modeAllows, spotsForMode, seasonOf, formatBestMonths, majorityMonths, modesOfDay, wafuMonth, markKindOf, visitLevel, normalizeMode, addTrack, monthlyQuests, dailyQuests, pickNear, bestLoop, questCategory, listProgress, prefsVisited, PREFS, countryProgress, countriesOf, countriesVisited, groupByDay, stampedOn, shouldRemindBackup,
  sealTypeFor, shouldAutoStamp, sealDraft, readExifDate, AUTO_DWELL_MS, remapVisits, classifyFood, normalizeName,
  readExifGPS, matchPhotoStamps, monthGrid, shiftMonth, parseGpx, gpxStops, gpxDayDistances, matchGpxVisits,
} from '../logic.js';
import { dataURLToBlob } from '../db.js';
import { readFileSync } from 'node:fs';
import { CLOSED_SPOTS, dropClosed } from '../tools/build-spots.mjs';
import seasons from '../themes/seasons.js';

const at = (m, lat = 35, lng = 135) => ({ lat: lat + m / 111195, lng }); // 北へ m メートル
const base = { lat: 35, lng: 135 };

test('distanceMeters: 東京駅〜新宿駅 約6.1km', () => {
  const d = distanceMeters({ lat: 35.681236, lng: 139.767125 }, { lat: 35.690921, lng: 139.700258 });
  assert.ok(Math.abs(d - 6100) / 6100 < 0.01, `d=${d}`);
});

test('tileKey / tilesForBounds', () => {
  assert.equal(tileKey(35.68, 139.76), '35.5_139.5');
  assert.equal(tileKey(35.5, 139.5), '35.5_139.5');
  assert.deepEqual(tilesForBounds(35.4, 139.4, 35.6, 139.6), ['35.0_139.0', '35.0_139.5', '35.5_139.0', '35.5_139.5']);
  assert.equal(tilesForBounds(20, 120, 50, 150, 10).length, 10);
});

test('canCheckIn: 50m の境目と誤差', () => {
  assert.equal(canCheckIn(50, 0), true);
  assert.equal(canCheckIn(51, 0), false);
  assert.equal(canCheckIn(70, 20), true);
  assert.equal(canCheckIn(90, 100), false); // 誤差は 30m まで
});

test('canStamp: 点は50m、広い場所は radius', () => {
  assert.equal(canStamp({ radius: 50 }, 50, 0), true);
  assert.equal(canStamp({}, 51, 0), false);
  assert.equal(canStamp({ radius: 300 }, 300, 0), true);
  assert.equal(canStamp({ radius: 300 }, 301, 0), false);
  assert.equal(canStamp({ radius: 300 }, 320, 20), true);
  assert.equal(canStamp({ radius: 10 }, 51, 0), false); // 小さい radius でも 50m は守る
});

test('nearestSpot / bearingDeg', () => {
  const spots = [{ id: 'a', ...at(500) }, { id: 'b', ...at(100) }, { id: 'c', lat: null, lng: null }];
  assert.equal(nearestSpot(base, spots).spot.id, 'b');
  assert.equal(nearestSpot(null, spots), null);
  assert.equal(nearestSpot(base, []), null);
  assert.ok(Math.abs(bearingDeg(base, at(100))) < 0.5);
  assert.ok(Math.abs(bearingDeg(base, { lat: 35, lng: 135.01 }) - 90) < 0.5);
});

test('fitSize / todayStr', () => {
  assert.deepEqual(fitSize(4000, 2000, 1280), { w: 1280, h: 640 });
  assert.deepEqual(fitSize(800, 600, 1280), { w: 800, h: 600 });
  assert.equal(todayStr(new Date(2026, 2, 5)), '2026-03-05');
});

const S = (id, tier, dm, extra = {}) => ({ id, name: id, tier, lists: [], ...at(dm), ...extra });

test('spotsForMode: 範囲と種類', () => {
  const spots = [S('list1', 'list', 1500), S('near1', 'near', 1500), S('near9', 'near', 9000),
    S('list9', 'list', 9000), S('list50', 'list', 50000), S('list200', 'list', 200000)];
  const ids = (mode) => spotsForMode(spots, mode, base).map((s) => s.id);
  assert.deepEqual(ids('walk').sort(), ['list1', 'near1']);
  assert.deepEqual(ids('bike').sort(), ['list1', 'list9', 'near1', 'near9']);
  assert.deepEqual(ids('trip').sort(), ['list1', 'list200', 'list50', 'list9', 'near1', 'near9']); // 旅行は世界、近所の場所も出す
  assert.equal(spotsForMode(spots, 'walk', base)[0].distance < 2000, true);
  assert.equal(spotsForMode(spots, 'trip', null).length, 6); // 位置がなければ全部
  assert.equal(modeAllows({ tier: 'near', lists: [] }, 'trip'), true);
  // 前の版の車・電車・飛行機は旅行として扱う
  assert.equal(normalizeMode('car'), 'trip'); assert.equal(normalizeMode('plane'), 'trip'); assert.equal(normalizeMode('walk'), 'walk'); assert.equal(normalizeMode('xyz'), 'walk');
  assert.deepEqual(ids('train').sort(), ids('trip').sort());
});

test('monthlyQuests: 旅のしかたの範囲の外は出さない', () => {
  const sp = (id, dm) => ({ id, name: id, tier: 'list', lists: ['seasons'], ...at(dm), seasons: [{ months: [10], label: 'L', mark: 'M' }] });
  const spots = [sp('near', 5000), sp('mid', 50000), sp('far', 150000)];
  const ids = (mode) => monthlyQuests(spots, new Date(2026, 9, 13), mode, base).map((s) => s.id);
  assert.deepEqual(ids('bike'), ['near']);
  assert.deepEqual(ids('trip'), ['near', 'mid', 'far']);
  assert.deepEqual(ids('walk'), []);
});

test('dataURLToBlob: data URL から元のバイト列に戻る（大きくても）', async () => {
  const bytes = new Uint8Array(300000).map((_, i) => (i * 7) % 256);
  const url = 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
  const b = dataURLToBlob(url);
  assert.equal(b.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), bytes);
  assert.throws(() => dataURLToBlob('abc'));
});

test('majorityMonths: 半数以上の場所でベストに入る月だけ、無ければ空', () => {
  assert.deepEqual(majorityMonths([[5, 6], [5, 6, 7], [6, 7], [10]]), [5, 6, 7]);
  assert.deepEqual(majorityMonths([[5, 6], [7, 8]]), [5, 6, 7, 8]);
  assert.deepEqual(majorityMonths([[1], [2], [3]]), []);
  assert.deepEqual(majorityMonths([null, []]), []);
});

test('modesOfDay: 移動距離か visits の mode から、散歩・サイクリング・旅行の順に', () => {
  assert.deepEqual(modesOfDay([], { walk: 100 }), ['walk']);
  assert.deepEqual(modesOfDay([{ mode: 'trip' }, { mode: 'bike' }], { walk: 5, bike: 0 }), ['walk', 'bike', 'trip']);
  assert.deepEqual(modesOfDay([{ mode: 'plane' }, {}], null), ['trip']);
  assert.deepEqual(modesOfDay([], { walk: 0 }), []);
});

test('wafuMonth: 和風月名', () => {
  assert.equal(wafuMonth(1), '睦月');
  assert.equal(wafuMonth(10), '神無月');
  assert.equal(wafuMonth(12), '師走');
  assert.equal(Array.from({ length: 12 }, (_, i) => wafuMonth(i + 1)).join(''), '睦月如月弥生卯月皐月水無月文月葉月長月神無月霜月師走');
});

test('markKindOf: 種類ごとのマーク（神社＝鳥居・お寺＝卍・飲食＝ナイフとフォーク）', () => {
  assert.equal(markKindOf({ kind: 'shrine' }), 'shrine');
  assert.equal(markKindOf({ kind: 'temple' }), 'temple');
  for (const k of ['teishoku', 'cafe', 'bakery']) assert.equal(markKindOf({ kind: k }), 'food');
  assert.equal(markKindOf({ kind: 'sento' }), 'onsen');
  assert.equal(markKindOf({ kind: 'heritage', name: '慈照寺' }), 'temple');
  assert.equal(markKindOf({ kind: 'meisho', name: '姫路城' }), 'castle');
  assert.equal(markKindOf({ kind: 'meisho', name: '華厳滝', lists: ['taki100'] }), 'waterfall');
  assert.equal(markKindOf({ kind: 'meisho', name: '富士山', lists: ['hyakumeizan'] }), 'mountain');
  assert.equal(markKindOf({ kind: 'heritage', name: 'ヴェルサイユ宮殿', lists: ['heritage'] }), 'heritage');
  assert.equal(markKindOf({ kind: 'kanko', name: 'どこか' }), 'pin');
});

test('visitLevel: 1回・2〜3回・4〜9回・10回以上の4段階', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9, 10, 50].map(visitLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
});

test('もう無い催し・施設は一覧から外れ、座標なしの観光地は残る', () => {
  assert.ok(CLOSED_SPOTS.has('Q283773')); // Pokémon The Park 2005
  assert.deepEqual(dropClosed([{ id: 'Q283773' }, { id: 'Q57965' }, { id: 'QX', lat: null }]).map((i) => i.id), ['Q57965', 'QX']);
  const kanko = JSON.parse(readFileSync(new URL('../data/lists.json', import.meta.url), 'utf8')).lists.find((l) => l.key === 'kanko');
  assert.ok(!kanko.items.some((it) => CLOSED_SPOTS.has(it[0])));
  assert.equal(kanko.items.filter((it) => !it[3]).length, 293 - 8); // 座標なし：293 のうち、閉園などで外した8件を除く（残り285件）
});

test('formatBestMonths: 連続は〜でまとめる、年をまたぐ分も1つに', () => {
  assert.equal(formatBestMonths([4, 5, 6, 10, 11]), '4〜6月・10〜11月');
  assert.equal(formatBestMonths([5]), '5月');
  assert.equal(formatBestMonths([1, 2, 11, 12]), '11〜2月');
  assert.equal(formatBestMonths([]), '');
});

test('themes/seasons: 形', () => {
  assert.ok(seasons.length >= 3);
  assert.equal(new Set(seasons.map((s) => s.key)).size, seasons.length);
  for (const s of seasons) {
    assert.ok(s.key && s.name && s.pref && s.label && s.mark, s.key);
    assert.ok(s.months.length > 0 && s.months.every((m) => m >= 1 && m <= 12), s.key);
    assert.ok(['far', 'day', 'town'].includes(s.tier), s.key);
    assert.ok(s.radius > 0, s.key);
  }
});

test('groupByDay / stampedOn / shouldRemindBackup', () => {
  const t1 = new Date(2026, 4, 1, 10).getTime();
  const t2 = new Date(2026, 4, 1, 9).getTime();
  const t3 = new Date(2026, 4, 3, 9).getTime();
  const visits = [{ spotId: 'a', at: t1 }, { spotId: 'b', at: t2 }, { spotId: 'a', at: t3 }];
  const days = groupByDay(visits, [{ at: '2026-05-02' }]);
  assert.deepEqual(days.map((d) => d.date), ['2026-05-03', '2026-05-02', '2026-05-01']);
  assert.deepEqual(days[2].visits.map((v) => v.spotId), ['b', 'a']);
  assert.equal(stampedOn(visits, 'a', new Date(2026, 4, 1, 20)), true);
  assert.equal(stampedOn(visits, 'b', new Date(2026, 4, 3)), false);
  assert.equal(shouldRemindBackup({ count: 10, lastExportCount: 0 }), true);
  assert.equal(shouldRemindBackup({ count: 3, lastExportCount: 0 }), false);
});

test('remapVisits: aliases で spotId を張り替える', () => {
  const visits = [{ spotId: 'a' }, { spotId: 'b' }, { spotId: 'c' }];
  const r = remapVisits(visits, { a: 'parent', c: 'c' });
  assert.deepEqual(r.visits.map((v) => v.spotId), ['parent', 'b', 'c']);
  assert.equal(r.changed, 1);
  assert.equal(visits[0].spotId, 'a'); // 元の配列は変えない
  const none = remapVisits(visits, {});
  assert.equal(none.changed, 0);
  assert.equal(none.visits, visits); // 変える必要がなければ同じ配列を返す
});

test('sealTypeFor: seal 優先、名前から当てる', () => {
  assert.equal(sealTypeFor({ name: '姫路城' }), '御城印');
  assert.equal(sealTypeFor({ name: '首里城跡' }), '御城印');
  assert.equal(sealTypeFor({ name: '厳島神社' }), '御朱印');
  assert.equal(sealTypeFor({ name: '清水寺' }), '御朱印');
  assert.equal(sealTypeFor({ name: '日光東照宮' }), '御朱印');
  assert.equal(sealTypeFor({ name: '白川郷' }), null);
  assert.equal(sealTypeFor({ name: '白川郷', seal: '鉄印' }), '鉄印');
});

test('shouldAutoStamp: どの旅のしかたでも、範囲の中にしばらくいたときだけ押す', () => {
  const spot = { id: 'a', lat: 35, lng: 135, radius: 0, lists: ['x'] };
  const T0 = 1_000_000_000_000;
  const fx = (m, t, extra = {}) => ({ ...at(m), acc: 10, at: T0 + t, speed: null, ...extra });
  const now = new Date(T0);
  const stay = [fx(10, 0), fx(10, AUTO_DWELL_MS)];
  // 通っただけ（入ってすぐ・1分だけ）は押さない
  assert.equal(shouldAutoStamp(spot, [fx(10, 0)], 'walk', [], now), false);
  assert.equal(shouldAutoStamp(spot, [fx(10, 0), fx(10, 60000)], 'bike', [], now), false);
  assert.equal(shouldAutoStamp(spot, [fx(10, 0, { speed: 1 })], 'car', [], now), false);
  // しばらくいたら押す
  for (const mode of ['walk', 'bike', 'trip']) assert.equal(shouldAutoStamp(spot, stay, mode, [], now), true, mode);
  // 途中で範囲の外に出たら、数え直し
  assert.equal(shouldAutoStamp(spot, [fx(10, 0), fx(500, 60000), fx(10, 120000), fx(10, AUTO_DWELL_MS)], 'walk', [], now), false);
  // 精度が悪い・範囲外・一覧にない・座標なし・今日押した は押さない
  assert.equal(shouldAutoStamp(spot, [fx(10, 0), fx(10, AUTO_DWELL_MS, { acc: 80 })], 'walk', [], now), false);
  assert.equal(shouldAutoStamp(spot, [fx(200, 0), fx(200, AUTO_DWELL_MS)], 'walk', [], now), false);
  assert.equal(shouldAutoStamp({ ...spot, lists: [] }, stay, 'walk', [], now), false);
  assert.equal(shouldAutoStamp({ ...spot, lat: null }, stay, 'walk', [], now), false);
  assert.equal(shouldAutoStamp(spot, stay, 'walk', [{ spotId: 'a', at: T0 }], now), false);
});

test('sealDraft: 指定、今いる場所の判子、なし', () => {
  const a = { id: 'a', name: '姫路城', lat: 35, lng: 135, lists: ['x'] };
  const b = { id: 'b', name: '白川郷', lat: 36, lng: 136, lists: ['x'] };
  const byId = (id) => ({ a, b })[id] || null;
  const now = new Date(2026, 9, 12, 15);
  const visits = [{ spotId: 'b', at: new Date(2026, 9, 12, 9).getTime() }, { spotId: 'a', at: new Date(2026, 9, 12, 10).getTime() }];
  assert.deepEqual(sealDraft({ spotId: 'a', visits: [], spotById: byId, now }), { spotId: 'a', type: '御城印', date: '2026-10-12' });
  assert.deepEqual(sealDraft({ visits, spotById: byId, pos: at(5), acc: 10, now }), { spotId: 'a', type: '御城印', date: '2026-10-12' });
  assert.deepEqual(sealDraft({ visits, spotById: byId, pos: { lat: 40, lng: 140 }, now }), { spotId: '', type: '写真・メモ', date: '2026-10-12' });
  assert.deepEqual(sealDraft({ spotId: 'b', visits: [], spotById: byId, now }).type, '写真・メモ');
});

function makeJpeg(le, withDate = true) {
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const u16 = (n) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const date = ascii('2024:05:06 07:08:09'); // 20 バイト
  // TIFF: ヘッダ 8、IFD0 (1 エントリ: ExifIFD ポインタ) 、ExifIFD (1 エントリ: 0x9003)、日付
  const ifd0 = 8; const sub = ifd0 + 2 + 12 + 4; const dat = sub + 2 + 12 + 4;
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(sub), ...u32(0),
    ...u16(1), ...u16(0x9003), ...u16(2), ...u32(20), ...u32(dat), ...u32(0), ...date];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = body.length + 2;
  const app1 = withDate ? [0xff, 0xe1, len >> 8, len & 255, ...body] : [];
  return new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9]).buffer;
}

test('readExifDate: II / MM / なし / 壊れ', () => {
  assert.equal(readExifDate(makeJpeg(true)), '2024-05-06');
  assert.equal(readExifDate(makeJpeg(false)), '2024-05-06');
  assert.equal(readExifDate(makeJpeg(true, false)), null);
  assert.equal(readExifDate(new Uint8Array([1, 2, 3]).buffer), null);
  assert.equal(readExifDate(makeJpeg(true).slice(0, 30)), null);
  assert.equal(readExifDate(new ArrayBuffer(0)), null);
});

// GPS 付き JPEG（IFD0 に ExifIFD と GPS IFD の両方を持つ、iPhone の写真に近い形）
function makeGpsJpeg(le, { withGps = true, lat = { d: 35, m: 41, s: 222, sDen: 10, ref: 'N' }, lng = { d: 139, m: 41, s: 306, sDen: 10, ref: 'E' } } = {}) {
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const u16 = (n) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const rational = (num, den) => [...u32(num), ...u32(den)];
  const refInline = (ch) => [ch.charCodeAt(0), 0, 0, 0]; // ASCII count2 は4バイトの値欄にそのまま入る
  const date = ascii('2024:05:06 07:08:09');

  const ifd0Off = 8;
  const exifOff = ifd0Off + 2 + 2 * 12 + 4; // 38
  const dateOff = exifOff + 2 + 1 * 12 + 4; // 56
  const gpsOff = dateOff + 20; // 76
  const latOff = gpsOff + 2 + 4 * 12 + 4; // 130
  const lngOff = latOff + 24; // 154

  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0Off),
    ...u16(2), // IFD0: ExifIFD ポインタ・GPS IFD ポインタ
    ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifOff),
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsOff),
    ...u32(0),
    ...u16(1), // ExifIFD: 撮影日時
    ...u16(0x9003), ...u16(2), ...u32(20), ...u32(dateOff),
    ...u32(0),
    ...date,
    ...u16(withGps ? 4 : 0), // GPS IFD
    ...(withGps ? [
      ...u16(0x0001), ...u16(2), ...u32(2), ...refInline(lat.ref),
      ...u16(0x0002), ...u16(5), ...u32(3), ...u32(latOff),
      ...u16(0x0003), ...u16(2), ...u32(2), ...refInline(lng.ref),
      ...u16(0x0004), ...u16(5), ...u32(3), ...u32(lngOff),
    ] : []),
    ...u32(0),
    ...(withGps ? [
      ...rational(lat.d, 1), ...rational(lat.m, 1), ...rational(lat.s, lat.sDen),
      ...rational(lng.d, 1), ...rational(lng.m, 1), ...rational(lng.s, lng.sDen),
    ] : []),
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = body.length + 2;
  const app1 = [0xff, 0xe1, len >> 8, len & 255, ...body];
  return new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9]).buffer;
}

test('readExifGPS: II / MM / 南緯西経 / GPS なし / 壊れ', () => {
  const near = (v, t) => Math.abs(v - t) < 1e-6;
  const le = readExifGPS(makeGpsJpeg(true));
  assert.ok(near(le.lat, 35.6895) && near(le.lng, 139.6918333));
  const be = readExifGPS(makeGpsJpeg(false));
  assert.ok(near(be.lat, 35.6895) && near(be.lng, 139.6918333));
  const sw = readExifGPS(makeGpsJpeg(true, { lat: { d: 35, m: 41, s: 222, sDen: 10, ref: 'S' }, lng: { d: 139, m: 41, s: 306, sDen: 10, ref: 'W' } }));
  assert.ok(near(sw.lat, -35.6895) && near(sw.lng, -139.6918333));
  assert.equal(readExifGPS(makeGpsJpeg(true, { withGps: false })), null);
  assert.equal(readExifGPS(new Uint8Array([1, 2, 3]).buffer), null);
  assert.equal(readExifGPS(new ArrayBuffer(0)), null);
  // readExifDate はそのまま読める（同じ写真から日付と位置の両方を読む想定）
  assert.equal(readExifDate(makeGpsJpeg(true)), '2024-05-06');
});

test('matchPhotoStamps: 近くの場所（一覧・近所の両方）に撮影日の判子、同じ日同じ場所はまとめて1つ', () => {
  const spots = [
    { id: 'a', lat: 35, lng: 135, radius: 50, tier: 'list' },
    { id: 'b', lat: 35, lng: 135, radius: 50, tier: 'near' }, // a と同じ場所を指す別の場所データ
    { id: 'far', lat: 36, lng: 135, radius: 50, tier: 'list' },
  ];
  const photos = [
    { date: '2026-10-10', lat: 35.0001, lng: 135 },
    { date: '2026-10-10', lat: 35.0001, lng: 135 }, // 同じ日・同じ場所のもう1枚
    { date: '2026-10-11', lat: 36, lng: 135 },
    { date: null, lat: 35, lng: 135 }, // 日付が読めない
    { date: '2026-10-12', lat: 10, lng: 10 }, // 近くに場所がない
  ];
  const r = matchPhotoStamps(photos, spots, []);
  assert.equal(r.matches.length, 3); // a@10-10, b@10-10, far@10-11
  assert.deepEqual(r.matches.map((m) => `${m.spotId}_${m.date}`).sort(), ['a_2026-10-10', 'b_2026-10-10', 'far_2026-10-11']);
  assert.equal(r.matches.find((m) => m.spotId === 'a').photoIndex, 0); // 1枚目の写真が付く
  assert.equal(r.withoutLocation, 1);
  assert.equal(r.withoutSpot, 1);
  // 既に押してある判子は増やさない
  const visits = [{ id: 'v1', spotId: 'a', at: new Date('2026-10-10T12:00:00').getTime() }];
  const r2 = matchPhotoStamps(photos, spots, visits);
  assert.deepEqual(r2.matches.map((m) => `${m.spotId}_${m.date}`).sort(), ['b_2026-10-10', 'far_2026-10-11']);
});

test('dailyQuests: 徒歩・自転車だけ、範囲内のまだ押していない場所から、同じ日は同じ顔ぶれ', () => {
  const pos = { lat: 35.68, lng: 139.76 };
  const spots = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'shrine', tier: 'near', lat: 35.68 + i * 0.001, lng: 139.76 }));
  spots.push({ id: 'far', kind: 'shrine', tier: 'near', lat: 36.5, lng: 139.76 });
  spots.push({ id: 'season', kind: 'x', tier: 'list', lat: 35.68, lng: 139.76, seasons: [{ months: [10] }] });
  const none = new Set();
  const a = dailyQuests(spots, '2026-10-13', 'walk', pos, none, none);
  assert.equal(a.length, 3);
  assert.ok(a.every((s) => s.daily && s.distance <= 2000 && s.id !== 'far' && s.id !== 'season'));
  assert.deepEqual(dailyQuests(spots, '2026-10-13', 'walk', pos, none, none).map((s) => s.id), a.map((s) => s.id));
  assert.equal(dailyQuests(spots, '2026-10-13', 'trip', pos, none, none).length, 0);
  assert.equal(dailyQuests(spots, '2026-10-13', 'walk', null, none, none).length, 0);
  // 前に押した場所は出さない。今日押した場所は残す
  const before = new Set(a.map((s) => s.id));
  assert.ok(dailyQuests(spots, '2026-10-13', 'walk', pos, none, before).every((s) => !before.has(s.id)));
  assert.deepEqual(dailyQuests(spots, '2026-10-13', 'walk', pos, before, before).map((s) => s.id), a.map((s) => s.id));
});

test('pickNear: 今いて押せる場所を先に、押した・通った後はまだの場所でいちばん近いところ', () => {
  const pos = { lat: 35, lng: 139 };
  const at = (id, dLat, radius = 50) => ({ id, lat: 35 + dLat, lng: 139, radius });
  const here = at('here', 0.0001); const near = at('near', 0.002); const far = at('far', 0.005); const tooFar = at('tooFar', 0.05);
  const spots = [far, near, here, tooFar];
  const none = new Set();
  assert.equal(pickNear(pos, spots, 10, none, none).spot.id, 'here');
  // 今日押した → 次のまだの場所（near）
  assert.equal(pickNear(pos, spots, 10, new Set(['here']), none).spot.id, 'near');
  // 通った・前に押した場所は飛ばす
  assert.equal(pickNear(pos, spots, 10, new Set(['here']), new Set(['near'])).spot.id, 'far');
  // 通った場所でも、今いて押せるなら出す
  assert.equal(pickNear(pos, spots, 10, none, new Set(['here'])).spot.id, 'here');
  // 2km より遠いものだけなら出さない
  assert.equal(pickNear(pos, [tooFar], 10, none, none), null);
});

test('散歩の今日のお題：回って戻ると約2.5km（30分）になる2〜3か所を、回る順に', () => {
  const pos = { lat: 35.68, lng: 139.76 };
  // 0.0005度刻み（約55m）〜2km 弱まで、いろいろな向きに40か所
  const spots = Array.from({ length: 40 }, (_, i) => {
    const r = 0.0005 * (i + 1) * 0.4; const a = i * 2.4;
    return { id: `s${i}`, kind: 'temple', tier: 'near', lat: pos.lat + r * Math.cos(a), lng: pos.lng + r * Math.sin(a) / Math.cos(pos.lat * Math.PI / 180) };
  });
  const none = new Set();
  const q = dailyQuests(spots, '2026-10-13', 'walk', pos, none, none);
  assert.ok(q.length >= 2 && q.length <= 3);
  assert.ok(Math.abs(q[0].loop - 2500) <= 700, `道のり ${q[0].loop}m`);
  // 回る順：bestLoop で並べ直しても同じ順（か逆回り）で、同じ道のり
  const r = bestLoop(pos, q);
  assert.equal(r.meters, q[0].loop);
  // 同じ日は同じ組み合わせ
  assert.deepEqual(dailyQuests(spots, '2026-10-13', 'walk', pos, none, none).map((s) => s.id), q.map((s) => s.id));
  // サイクリングも回るお題（loop が付く）
  const b = dailyQuests(spots, '2026-10-13', 'bike', pos, none, none);
  assert.ok(b.length >= 2 && b.every((s) => s.loop > 0));
});

test('今日のお題は種類が分かれるように選ぶ', () => {
  const pos = { lat: 35.68, lng: 139.76 };
  const kinds = ['shrine', 'shrine', 'shrine', 'temple', 'temple', 'temple', 'sento', 'museum'];
  const spots = Array.from({ length: 48 }, (_, i) => {
    const r = 0.003 + 0.0003 * i; const a = i * 2.4;
    return { id: `k${i}`, kind: kinds[i % kinds.length], tier: 'near', lat: pos.lat + r * Math.cos(a), lng: pos.lng + r * Math.sin(a) };
  });
  const none = new Set();
  for (const mode of ['walk', 'bike']) {
    const q = dailyQuests(spots, '2026-10-14', mode, pos, none, none);
    assert.equal(new Set(q.map((s) => s.kind)).size, q.length, `${mode}: ${q.map((s) => s.kind)}`);
  }
});

test('今日のお題はご飯・寺社・その他から1つずつ', () => {
  const pos = { lat: 35.68, lng: 139.76 };
  // 喫茶店が大半の都心を想定
  const kinds = ['cafe', 'cafe', 'cafe', 'cafe', 'cafe', 'bakery', 'shrine', 'museum'];
  const spots = Array.from({ length: 64 }, (_, i) => {
    const r = 0.003 + 0.0002 * i; const a = i * 2.4;
    return { id: `c${i}`, kind: kinds[i % kinds.length], tier: 'near', lat: pos.lat + r * Math.cos(a), lng: pos.lng + r * Math.sin(a) };
  });
  const none = new Set();
  for (const mode of ['walk', 'bike']) {
    const q = dailyQuests(spots, '2026-10-14', mode, pos, none, none);
    assert.deepEqual(q.map(questCategory).sort(), ['food', 'other', 'sacred'], `${mode}: ${q.map((s) => s.kind)}`);
  }
});

test('サイクリングの今日のお題：回って戻ると約7.5km（30分）', () => {
  const pos = { lat: 35.68, lng: 139.76 };
  const kinds = ['cafe', 'shrine', 'museum', 'temple', 'bakery', 'sight'];
  const spots = Array.from({ length: 60 }, (_, i) => {
    const r = 0.004 + 0.0014 * i; const a = i * 2.4; // 〜9km
    return { id: `b${i}`, kind: kinds[i % kinds.length], tier: 'near', lat: pos.lat + r * Math.cos(a), lng: pos.lng + r * Math.sin(a) / Math.cos(pos.lat * Math.PI / 180) };
  });
  const q = dailyQuests(spots, '2026-10-14', 'bike', pos, new Set(), new Set());
  assert.ok(Math.abs(q[0].loop - 7500) <= 1500, `道のり ${q[0].loop}m`);
  assert.ok(q.every((s) => s.distance <= 10000));
});

test('classifyFood: 表記ゆれ（ひらがな/カタカナ、「鍋」「汁」の有無）を吸収して当てる', () => {
  const foods = [
    { key: 'kiritampo', name: 'きりたんぽ鍋', pref: '秋田県' },
    { key: 'houtou', name: 'ほうとう', pref: '山梨県' },
    { key: 'zoni', name: '雑煮', pref: '東京都' },
  ];
  assert.equal(classifyFood('きりたんぽ', foods), 'kiritampo'); // 「鍋」なしでも当たる
  assert.equal(classifyFood('キリタンポ鍋を食べた', foods), 'kiritampo'); // カタカナでも当たる
  assert.equal(classifyFood('ほうとうを食べた', foods), 'houtou');
  assert.equal(classifyFood('冷やし中華', foods), null); // 当たらなければ null
  assert.equal(classifyFood('', foods), null);
  assert.equal(classifyFood('何か', null), null);
});

test('normalizeName: 帳面の検索用に、ひらがな/カタカナ・空白・全角半角の違いを吸収する', () => {
  assert.equal(normalizeName('きんかくじ'), normalizeName('キンカクジ'));
  assert.equal(normalizeName('金 閣寺'), normalizeName('金閣寺'));
  assert.equal(normalizeName('ｶﾞｰﾄﾞﾊﾟｰｼﾞ'), normalizeName('ガードパージ'));
  assert.ok(normalizeName('きんかくじ京都').includes(normalizeName('かくじ')));
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('prefsVisited: meals（ご当地グルメ）も都道府県の塗りに数える', () => {
  const spots = [{ id: 's1', pref: '山梨県' }];
  const meals = [{ pref: '秋田県' }, { spotId: 's1' }, { pref: '' }];
  const counts = prefsVisited([], [], meals, spots);
  assert.deepEqual(counts, { 秋田県: 1, 山梨県: 1 });
});

test('MODES.trip: 範囲は世界（東京からパリまで届く）', () => {
  const tokyo = { lat: 35.681236, lng: 139.767125 };
  const paris = { lat: 48.8566, lng: 2.3522 };
  assert.ok(distanceMeters(tokyo, paris) < MODES.trip.range);
});

test('countryProgress・countriesOf・countriesVisited: 世界遺産など世界に広がる一覧の国ごとの進み具合', () => {
  const spots = [
    { id: 'jp1', name: '富士山', country: '日本', lists: ['heritage'] },
    { id: 'jp2', name: '姫路城', country: '日本', lists: ['heritage'] },
    { id: 'fr1', name: 'モンサンミッシェル', country: 'フランス', lists: ['heritage'] },
    { id: 'it1', name: 'コロッセオ', country: 'イタリア', lists: ['heritage'] }, // 国が同じでも未訪問のまま残る
  ];
  assert.deepEqual(countriesOf(spots).sort(), ['イタリア', 'フランス', '日本']);
  const visits = [{ spotId: 'jp1' }, { spotId: 'fr1' }];
  assert.deepEqual(countriesVisited(visits, spots), { 日本: 1, フランス: 1 });
  const jp = countryProgress(visits, spots, '日本');
  assert.equal(jp.count, 1); assert.equal(jp.total, 2);
  const it = countryProgress(visits, spots, 'イタリア');
  assert.equal(it.count, 0); assert.equal(it.total, 1);
  // country が無い場所（まだ古いデータなど）は日本として数える
  assert.deepEqual(countriesOf([{ id: 'x' }]), ['日本']);
});

test('groupByDay: meals も日付にまとめる', () => {
  const meals = [{ at: '2026-05-01', name: 'きりたんぽ鍋' }, { at: '2026-05-03', name: 'ほうとう' }];
  const days = groupByDay([], [], meals);
  assert.deepEqual(days.map((d) => d.date), ['2026-05-03', '2026-05-01']);
  assert.deepEqual(days[1].meals.map((m) => m.name), ['きりたんぽ鍋']);
});

test('addTrack：揺れ・精度の悪い位置・飛びは数えない', () => {
  const p = (dLat, sec, acc = 10) => ({ lat: 35 + dLat, lng: 139, acc, at: sec * 1000 });
  let t = {};
  t = addTrack(t, p(0, 0));
  t = addTrack(t, p(0.00005, 10)); // 約5.6m：揺れ
  assert.equal(t.meters, 0);
  t = addTrack(t, p(0.0009, 60)); // 約100m 進んだ
  assert.ok(Math.abs(t.meters - 100) < 3, `${t.meters}`);
  t = addTrack(t, p(0.002, 90, 80)); // 精度が悪い
  assert.ok(Math.abs(t.meters - 100) < 3);
  t = addTrack(t, p(0.05, 100)); // 10秒で5km：飛び
  assert.ok(Math.abs(t.meters - 100) < 3);
  t = addTrack(t, p(0.0509, 2000)); // 10分以上あいた
  assert.ok(Math.abs(t.meters - 100) < 3);
});

test('今日のお題の長さ：15分なら道のりも短く', () => {
  const pos = { lat: 35.68, lng: 139.76 };
  const kinds = ['cafe', 'shrine', 'museum'];
  const spots = Array.from({ length: 60 }, (_, i) => {
    const r = 0.001 + 0.00025 * i; const a = i * 2.4;
    return { id: `m${i}`, kind: kinds[i % 3], tier: 'near', lat: pos.lat + r * Math.cos(a), lng: pos.lng + r * Math.sin(a) / Math.cos(pos.lat * Math.PI / 180) };
  });
  const none = new Set();
  const q15 = dailyQuests(spots, '2026-10-14', 'walk', pos, none, none, 3, 15);
  const q60 = dailyQuests(spots, '2026-10-14', 'walk', pos, none, none, 3, 60);
  assert.ok(Math.abs(q15[0].loop - 1250) <= 400, `15分 ${q15[0].loop}m`);
  assert.ok(q60[0].loop > q15[0].loop * 2, `60分 ${q60[0].loop}m`);
});

test('monthGrid: 週の始まりは日曜、7の倍数のマスになる', () => {
  // 2026年10月1日は木曜（getDay()===4）。先頭4マスは9月の日になる
  const g = monthGrid(2026, 10);
  assert.equal(g.weeks[0].length, 7);
  assert.equal(g.weeks.flat().length % 7, 0);
  assert.deepEqual(g.weeks[0].slice(0, 4), [
    { date: '2026-09-27', inMonth: false },
    { date: '2026-09-28', inMonth: false },
    { date: '2026-09-29', inMonth: false },
    { date: '2026-09-30', inMonth: false },
  ]);
  assert.deepEqual(g.weeks[0][4], { date: '2026-10-01', inMonth: true });
  const last = g.weeks.flat().at(-1);
  assert.ok(last.date >= '2026-10-31');
  // 月の全日が1回ずつ、ちょうど出てくる
  const inMonthDates = g.weeks.flat().filter((c) => c.inMonth).map((c) => c.date);
  assert.deepEqual(inMonthDates, Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`));
});

test('monthGrid: うるう年の2月は29日、平年は28日', () => {
  const leap = monthGrid(2024, 2);
  assert.equal(leap.weeks.flat().filter((c) => c.inMonth).length, 29);
  const normal = monthGrid(2023, 2);
  assert.equal(normal.weeks.flat().filter((c) => c.inMonth).length, 28);
});

test('monthGrid: 1月は前年12月の日を、12月は翌年1月の日をまたぐ', () => {
  const jan = monthGrid(2026, 1);
  const firstOut = jan.weeks[0][0];
  if (!firstOut.inMonth) assert.ok(firstOut.date.startsWith('2025-12'));
  const dec = monthGrid(2026, 12);
  const lastOut = dec.weeks.at(-1).at(-1);
  if (!lastOut.inMonth) assert.ok(lastOut.date.startsWith('2027-01'));
});

test('shiftMonth: 年をまたぐ', () => {
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 10, 1), { year: 2026, month: 11 });
});

test('parseGpx: trkpt・wpt の位置と時刻、属性の順番違い・時刻なしは metadata の時刻', () => {
  const gpx = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>2026-10-01T00:00:00Z</time></metadata>
    <wpt lon="135.1" lat="35.1"><name>x</name></wpt>
    <trk><trkseg><trkpt lat="35" lon="135"><ele>3</ele><time>2026-10-10T03:00:00Z</time></trkpt>
    <trkpt lat='35.001' lon='135'/><trkpt lat="999" lon="135"></trkpt></trkseg></trk></gpx>`;
  const p = parseGpx(gpx);
  assert.equal(p.length, 3); // 緯度がおかしい点は外す
  assert.deepEqual(p[0], { lat: 35.1, lng: 135.1, time: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(p[1].time, Date.parse('2026-10-10T03:00:00Z'));
  assert.equal(p[2].time, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepEqual(parseGpx('<gpx><trkpt lat="35" lon="135"></trkpt></gpx>'), [{ lat: 35, lng: 135, time: null }]);
});

test('gpxStops: 日ごとに20mおきに間引き、時刻なしは日付なし→matchPhotoStamps で判子', () => {
  const t = new Date('2026-10-10T12:00:00').getTime();
  const pts = [0, 5, 10, 25, 30, 60, 300].map((m, i) => ({ ...at(m), time: t + i * 1000 }));
  pts.push({ ...at(0), time: null });
  const stops = gpxStops(pts);
  assert.deepEqual(stops.filter((s) => s.date).map((s) => Math.round(distanceMeters(base, s))), [0, 25, 60, 300]);
  assert.equal(stops.filter((s) => !s.date).length, 1);
  const spots = [{ id: 'a', ...at(40), radius: 0 }, { id: 'far', ...at(5000), radius: 0 }];
  const r = matchPhotoStamps(stops, spots, []);
  assert.deepEqual(r.matches.map((m) => `${m.spotId}_${m.date}`), ['a_2026-10-10']);
  assert.equal(r.withoutLocation, 1);
});

test('gpxDayDistances: 日ごとの距離、速さで散歩・サイクリングに分け、1km 以上の飛びは数えない', () => {
  const t = new Date('2026-10-10T09:00:00').getTime();
  const walk = [0, 100, 200, 300].map((m, i) => ({ ...at(m), time: t + i * 72000 })); // 100m/72秒＝時速5km
  const jump = { ...at(5300), time: t + 4 * 72000 }; // 5km 飛ぶ
  const t2 = new Date('2026-10-11T09:00:00').getTime();
  const bike = [0, 500, 1000].map((m, i) => ({ ...at(m), time: t2 + i * 120000 })); // 500m/2分＝時速15km
  const r = gpxDayDistances([...walk, jump, ...bike]);
  assert.deepEqual(Object.keys(r).sort(), ['2026-10-10', '2026-10-11']);
  assert.ok(Math.abs(r['2026-10-10'].walk - 300) <= 1);
  assert.ok(Math.abs(r['2026-10-11'].bike - 1000) <= 1);
});

test('matchGpxVisits: 大きな場所を歩いて通り抜けただけでは押さない', () => {
  const t = new Date('2026-10-10T09:00:00').getTime();
  const big = [{ id: 'park', ...at(500), radius: 600 }];
  const walk = []; for (let i = 0; i <= 30; i++) walk.push({ ...at(i * 40), time: t + i * 30000 }); // 15分かけて 1.2km 通り抜ける
  const r = matchGpxVisits(walk, big, []);
  assert.equal(r.stamps.length, 0);
  assert.deepEqual(r.passed.map((s) => s.spotId), ['park']);
});

test('matchGpxVisits: 3分以上いた場所だけ判子、通っただけは「通った」', () => {
  const t = new Date('2026-10-10T09:00:00').getTime();
  const spots = [{ id: 'stay', ...at(0), radius: 0 }, { id: 'pass', ...at(1000), radius: 0 }, { id: 'far', ...at(9000), radius: 0 }];
  const pts = [];
  for (let i = 0; i <= 5; i++) pts.push({ ...at(i * 5), time: t + i * 60000 }); // stay の近くに5分
  for (let i = 1; i <= 20; i++) pts.push({ ...at(i * 100), time: t + 300000 + i * 72000 }); // pass を歩いて通り過ぎる
  const r = matchGpxVisits(pts, spots, []);
  assert.deepEqual(r.stamps.map((s) => s.spotId), ['stay']);
  assert.equal(r.stamps[0].date, '2026-10-10');
  assert.deepEqual(r.passed.map((s) => s.spotId), ['pass']);
  // 既に押してあれば増やさない
  assert.equal(matchGpxVisits(pts, spots, [{ spotId: 'stay', at: t }]).stamps.length, 0);
});

test('readExifGPS / readExifDate: HEIC（JPEG でない）でも EXIF を探して読む', () => {
  // JPEG の EXIF の部分（'Exif' から後ろ）を、HEIC の箱の頭（ftyp heic）の後ろに置いたもの
  const toHeic = (jpegBuf) => {
    const j = new Uint8Array(jpegBuf);
    let i = 0; while (!(j[i] === 0x45 && j[i + 1] === 0x78 && j[i + 2] === 0x69 && j[i + 3] === 0x66)) i++;
    const head = [0, 0, 0, 24, ...[...'ftypheic'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[...'mif1heic'].map((c) => c.charCodeAt(0)), 1, 2, 3, 4];
    const out = new Uint8Array(head.length + j.length - i);
    out.set(head, 0); out.set(j.slice(i), head.length);
    return out.buffer;
  };
  const g = readExifGPS(toHeic(makeGpsJpeg(true)));
  assert.ok(g && Math.abs(g.lat - (35 + 41 / 60 + 22.2 / 3600)) < 1e-6);
  assert.equal(readExifDate(toHeic(makeJpeg(false))), '2024-05-06');
  assert.equal(readExifGPS(new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]).buffer), null);
});
