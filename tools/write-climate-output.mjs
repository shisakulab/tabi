// tools/build-climate.mjs が作った tools/out/climate-power-cache.json から、
// その時点で取れている格子だけで data/climate.json を書き出す（取得をせず、キャッシュの読み書きだけ）。
// 時間切れで build-climate.mjs を止めたとき、ここまでの分だけ出力するために使う。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = path.join(root, 'data', 'lists.json');
const CACHE = path.join(root, 'tools', 'out', 'climate-power-cache.json');
const OUT = path.join(root, 'data', 'climate.json');

function gridKeyOf(lat, lng) {
  return `${Math.floor(lat)}_${Math.floor(lng)}`;
}

// 行きやすさの点数のルールは tools/build-climate.mjs の冒頭コメントと同じ
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

async function main() {
  const data = JSON.parse(await readFile(LISTS, 'utf8'));
  const list = data.lists.find((l) => l.key === 'heritage');
  const spots = list.items.filter((it) => it[3] === 1 || it[3] === true).map((it) => ({ id: it[0], lat: it[5], lng: it[6] }));
  const cache = JSON.parse(await readFile(CACHE, 'utf8'));

  const spotGrid = {};
  const allGridKeys = new Set();
  for (const s of spots) {
    const key = gridKeyOf(s.lat, s.lng);
    spotGrid[s.id] = key;
    allGridKeys.add(key);
  }

  const out = { spots: {} };
  let withData = 0;
  for (const key of allGridKeys) {
    const climate = cache[key];
    if (!climate) continue;
    withData++;
    out[key] = {
      best: bestMonths(climate),
      t: climate.tMax.map((v) => v == null ? null : Math.round(v)),
      r: climate.precip.map((v) => v == null ? null : Math.round(v)),
    };
  }
  for (const [id, key] of Object.entries(spotGrid)) {
    if (cache[key]) out.spots[id] = key;
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`climate.json: 格子 ${withData}/${allGridKeys.size}件、spots ${Object.keys(out.spots).length}/${spots.length}件`);
}

main().catch((err) => { console.error(err); process.exit(1); });
