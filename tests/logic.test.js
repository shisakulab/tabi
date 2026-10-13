import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters, tileKey, tilesForBounds, nearestSpot, bearingDeg, canCheckIn, canStamp, fitSize, todayStr,
  modeAllows, spotsForMode, seasonOf, monthlyQuests, dailyQuests, listProgress, prefsVisited, PREFS, groupByDay, stampedOn, shouldRemindBackup,
  sealTypeFor, shouldAutoStamp, sealDraft, readExifDate, AUTO_DWELL_MS, remapVisits,
} from '../logic.js';
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
  assert.deepEqual(ids('train').sort(), ['list1', 'list50', 'list9']);
  assert.deepEqual(ids('car').sort(), ['list1', 'list50', 'list9']);
  assert.equal(spotsForMode(spots, 'walk', base)[0].distance < 2000, true);
  assert.equal(spotsForMode(spots, 'car', null).length, 4); // 位置がなければ種類だけ
  assert.equal(modeAllows({ tier: 'near', lists: [] }, 'train'), false);
  assert.deepEqual(ids('plane').sort(), ['list1', 'list200', 'list50', 'list9']);
});

test('monthlyQuests: 旅のしかたの範囲の外は出さない', () => {
  const sp = (id, dm) => ({ id, name: id, tier: 'list', lists: ['seasons'], ...at(dm), seasons: [{ months: [10], label: 'L', mark: 'M' }] });
  const spots = [sp('near', 5000), sp('mid', 50000), sp('far', 150000)];
  const ids = (mode) => monthlyQuests(spots, new Date(2026, 9, 13), mode, base).map((s) => s.id);
  assert.deepEqual(ids('bike'), ['near']);
  assert.deepEqual(ids('car'), ['near', 'mid']);
  assert.deepEqual(ids('walk'), []);
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
  for (const mode of ['walk', 'bike', 'car', 'train', 'plane']) assert.equal(shouldAutoStamp(spot, stay, mode, [], now), true, mode);
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
  assert.deepEqual(sealDraft({ visits, spotById: byId, pos: { lat: 40, lng: 140 }, now }), { spotId: '', type: '御朱印', date: '2026-10-12' });
  assert.deepEqual(sealDraft({ spotId: 'b', visits: [], spotById: byId, now }).type, '御朱印');
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
  assert.equal(dailyQuests(spots, '2026-10-13', 'car', pos, none, none).length, 0);
  assert.equal(dailyQuests(spots, '2026-10-13', 'walk', null, none, none).length, 0);
  // 前に押した場所は出さない。今日押した場所は残す
  const before = new Set(a.map((s) => s.id));
  assert.ok(dailyQuests(spots, '2026-10-13', 'walk', pos, none, before).every((s) => !before.has(s.id)));
  assert.deepEqual(dailyQuests(spots, '2026-10-13', 'walk', pos, before, before).map((s) => s.id), a.map((s) => s.id));
});
