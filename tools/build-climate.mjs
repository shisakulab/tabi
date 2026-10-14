// 世界遺産（data/lists.json の heritage）の座標から、気候にもとづく「行きやすい月」を作る
//   node tools/build-climate.mjs            キャッシュがあれば再利用し、続きから取りに行く
//   node tools/build-climate.mjs --refresh  格子のキャッシュを無視して取り直す
//
// 元データ：NASA POWER の Daily API（https://power.larc.nasa.gov/docs/services/api/temporal/daily/ 、キー不要）
//   注意：NASA POWER には「climatology」「monthly」という月の平年値を直接返すエンドポイントもあるが、
//   そちらの T2M_MAX / T2M_MIN は「その月で観測された最高・最低」（極値）であり、
//   「日々の最高気温の月平均」ではないことを実測で確認した（例：ロンドン1月の climatology T2M_MAX は
//   13℃前後だが、実際の1月の最高気温の平均は7℃程度。daily のデータを月ごとに自分で平均すると7℃前後になり、
//   実際の気候と合う）。そのため、1地点につき daily（2015-01-01〜2024-12-31の日次データ）を1回だけ取得し、
//   月ごとの平年値はここで計算する（1地点1回のAPI呼び出しという点は変わらない）
//
// 手順：
//   1. 世界遺産の座標（緯度・経度）を 1度格子（floor）にまとめる
//   2. 格子ごとに、中心の座標で 2015-01-01〜2024-12-31 の日次データ（最高・最低気温、降水量）を1回取得
//   3. 月ごとに平年値を出す
//      - 最高気温の平均・最低気温の平均：10年分の該当月の日次値をすべて平均
//      - 降水量の月合計の平均：年ごとに月合計を出し、その10年分を平均（雨の日数は使わない）
//   4. 月ごとの「行きやすさ」の点数を出す（下の scoreMonth 参照）。上位のうち最高点の85%以上を「ベスト」とする
//
// 行きやすさの点数のルール（ここだけに置く。logic.js には入れない）：
//   - 気温スコア：最高気温の平均が 20〜26℃ のとき満点(1)。それより外れたら、はみ出した分（℃）に応じて
//     over/8 だけ減点（max(0, 1 - over/8)）。
//   - 雨スコア：月の降水量が 150mm まで満点(1)。それを超えた分に応じて減点し、400mm（超えた分250mm）で
//     スコア0（雨季を避ける）。
//   - 寒さの罰則：最低気温の平均が0℃未満のとき、はみ出した分に応じて追加で減点（最大0.5点）。
//   - 合計 = 気温スコア×0.6 + 雨スコア×0.4 − 寒さの罰則（0未満には切り下げない。あとで相対比較するだけ）
//   - ベストの月 = 合計が「12か月中の最高点×0.9以上」かつ「0.7以上」の月。多くても6か月（点の高い順に6つ）。
//     0.7以上の月が1つも無ければ、点の高い上位3か月をベストとする
//
// 出力：data/climate.json
//   { "<格子キー lat_lng>": { best: [月...], t: [12か月の最高気温平均(整数℃)], r: [12か月の降水量(整数mm)] },
//     "spots": { "<世界遺産のid>": "<格子キー>" } }
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = path.join(root, 'data', 'lists.json');
const CACHE = path.join(root, 'tools', 'out', 'climate-power-cache.json');
const OUT = path.join(root, 'data', 'climate.json');
const START = '20150101';
const END = '20241231';
const refresh = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gridKeyOf(lat, lng) {
  return `${Math.floor(lat)}_${Math.floor(lng)}`;
}
function gridCenter(key) {
  const [latS, lngS] = key.split('_').map(Number);
  return { lat: latS + 0.5, lng: lngS + 0.5 };
}

async function loadHeritageSpots() {
  const data = JSON.parse(await readFile(LISTS, 'utf8'));
  const list = data.lists.find((l) => l.key === 'heritage');
  if (!list) throw new Error('heritage list not found in data/lists.json');
  // item: [id, 名前, 都道府県, 座標あり1/0, 国, 緯度?, 経度?]
  return list.items.filter((it) => it[3] === 1 || it[3] === true).map((it) => ({ id: it[0], lat: it[5], lng: it[6] }));
}

async function loadCache() {
  if (!refresh && existsSync(CACHE)) {
    try {
      return JSON.parse(await readFile(CACHE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

async function saveCache(cache) {
  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache));
}

// NASA POWER の欠損値（-999付近）を null にする
function clean(v) {
  return v == null || v <= -900 ? null : v;
}

// 格子1つ分の日次データを取得して、月ごとの平年値にまとめる
async function fetchClimate(lat, lng) {
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR&community=RE&longitude=${lng}&latitude=${lat}&start=${START}&end=${END}&format=JSON`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const json = await res.json();
  const p = json.properties.parameter;
  const dates = Object.keys(p.T2M_MAX);

  const tMaxSum = Array(12).fill(0);
  const tMaxCount = Array(12).fill(0);
  const tMinSum = Array(12).fill(0);
  const tMinCount = Array(12).fill(0);
  const byYearMonth = new Map(); // "year-month" -> precip合計

  for (const d of dates) {
    // d は "YYYYMMDD"
    const year = d.slice(0, 4);
    const monthS = d.slice(4, 6);
    const mi = Number(monthS) - 1;
    const tMax = clean(p.T2M_MAX[d]);
    const tMin = clean(p.T2M_MIN[d]);
    const precip = clean(p.PRECTOTCORR[d]);
    if (tMax != null) { tMaxSum[mi] += tMax; tMaxCount[mi]++; }
    if (tMin != null) { tMinSum[mi] += tMin; tMinCount[mi]++; }
    const ymKey = `${year}-${monthS}`;
    if (!byYearMonth.has(ymKey)) byYearMonth.set(ymKey, 0);
    if (precip != null) byYearMonth.set(ymKey, byYearMonth.get(ymKey) + precip);
  }

  // 年ごとの月合計を月インデックスごとに集めて平均する
  const precipByMonth = Array.from({ length: 12 }, () => []);
  for (const [ymKey, total] of byYearMonth) {
    const mi = Number(ymKey.split('-')[1]) - 1;
    precipByMonth[mi].push(total);
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const tMax12 = Array.from({ length: 12 }, (_, mi) => tMaxCount[mi] ? tMaxSum[mi] / tMaxCount[mi] : null);
  const tMin12 = Array.from({ length: 12 }, (_, mi) => tMinCount[mi] ? tMinSum[mi] / tMinCount[mi] : null);
  const precip12 = Array.from({ length: 12 }, (_, mi) => precipByMonth[mi].length ? avg(precipByMonth[mi]) : null);

  return { tMax: tMax12, tMin: tMin12, precip: precip12 };
}

// 月の「行きやすさ」の点数（ファイル冒頭のコメント参照）
function tempScore(tMax) {
  if (tMax == null) return 0;
  let over = 0;
  if (tMax < 20) over = 20 - tMax;
  else if (tMax > 26) over = tMax - 26;
  return Math.max(0, 1 - over / 8);
}
function rainScore(precipMm) {
  if (precipMm == null) return 0;
  const over = Math.max(0, precipMm - 150);
  return Math.max(0, 1 - over / 250);
}
function coldPenalty(tMin) {
  if (tMin == null || tMin >= 0) return 0;
  return Math.min(1, -tMin / 10) * 0.5;
}
function scoreMonth({ tMax, tMin, precip }) {
  return tempScore(tMax) * 0.6 + rainScore(precip) * 0.4 - coldPenalty(tMin);
}

function bestMonths(climate) {
  const scores = Array.from({ length: 12 }, (_, mi) => ({
    month: mi + 1,
    s: scoreMonth({ tMax: climate.tMax[mi], tMin: climate.tMin[mi], precip: climate.precip[mi] }),
  }));
  const max = Math.max(...scores.map((x) => x.s));
  let best = scores.filter((x) => x.s >= max * 0.9 && x.s >= 0.7);
  if (!best.length) best = [...scores].sort((a, b) => b.s - a.s).slice(0, 3);
  else if (best.length > 6) best = [...best].sort((a, b) => b.s - a.s).slice(0, 6);
  return best.map((x) => x.month).sort((a, b) => a - b);
}

export function buildOutputEntry(climate) {
  return {
    best: bestMonths(climate),
    t: climate.tMax.map((v) => v == null ? null : Math.round(v)),
    r: climate.precip.map((v) => v == null ? null : Math.round(v)),
  };
}

async function main() {
  const spots = await loadHeritageSpots();
  const spotGrid = {};
  const grids = new Map(); // gridKey -> center
  for (const s of spots) {
    const key = gridKeyOf(s.lat, s.lng);
    spotGrid[s.id] = key;
    if (!grids.has(key)) grids.set(key, gridCenter(key));
  }
  console.log(`世界遺産（座標あり）: ${spots.length}件 / 格子: ${grids.size}件`);

  const cache = await loadCache();
  let fetched = 0, skipped = 0, failed = 0;
  let i = 0;
  for (const [key, center] of grids) {
    i++;
    if (cache[key]) { skipped++; continue; }
    try {
      await sleep(1000); // 1秒1回程度
      const climate = await fetchClimate(center.lat, center.lng);
      cache[key] = climate;
      fetched++;
      if (fetched % 10 === 0) await saveCache(cache);
      if (i % 50 === 0) console.log(`[${i}/${grids.size}] 取得済み:${fetched} 再利用:${skipped} 失敗:${failed}`);
    } catch (err) {
      failed++;
      console.error(`格子 ${key} の取得に失敗: ${err.message}`);
    }
  }
  await saveCache(cache);
  console.log(`取得終了。取得:${fetched} 再利用:${skipped} 失敗:${failed} / 格子合計:${grids.size}`);

  // 出力（取れた格子だけで作る）
  const out = { spots: {} };
  let withData = 0;
  for (const [key] of grids) {
    const climate = cache[key];
    if (!climate) continue;
    withData++;
    out[key] = buildOutputEntry(climate);
  }
  for (const [id, key] of Object.entries(spotGrid)) {
    if (cache[key]) out.spots[id] = key;
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`climate.json: 格子 ${withData}/${grids.size}件、spots ${Object.keys(out.spots).length}/${spots.length}件`);
  if (withData < grids.size) {
    console.log('足りない格子がある。再実行（node tools/build-climate.mjs）すれば続きから取れる。');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
