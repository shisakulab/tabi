// build-spots.mjs の LISTS に定義した一覧を1つだけ取り、既存の data/spots・data/lists.json に差分で反映する
// （全一覧を作り直すのは重いので、新しい一覧を1つ足すときはこちらを使う。取り方は build-spots.mjs と同じ関数を使うので、
//  いつか --refresh で全部作り直しても同じ結果になる）
//   node tools/add-list.mjs hyakumeizan
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileKey } from '../logic.js';
import { LISTS, fetchList, loadGsiCache, loadOverrides, applyOverrides } from './build-spots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'data');

const key = process.argv[2];
if (!key) { console.error('使い方: node tools/add-list.mjs <list key>'); process.exit(1); }
const list = LISTS.find((l) => l.key === key);
if (!list) { console.error(`${key}: build-spots.mjs の LISTS に定義がありません`); process.exit(1); }

async function main() {
  const gsiCache = await loadGsiCache();
  const overrides = await loadOverrides();
  const items = applyOverrides(await fetchList(list, gsiCache), overrides);
  console.log(`${list.name}: ${items.length} 件（座標あり ${items.filter((i) => i.lat !== null).length}）`);

  // lists.json に一覧を差し込む（同じ key があれば置き換え、なければ続日本100名城の後ろに入れる）
  const listsPath = path.join(OUT, 'lists.json');
  const listsData = JSON.parse(await readFile(listsPath, 'utf8'));
  const entry = {
    key: list.key, name: list.name, note: list.note, global: !!list.global,
    items: items.map((i) => [i.id, i.name, i.pref, i.lat !== null ? 1 : 0, i.country || '日本', ...(i.lat !== null ? [Math.round(i.lat * 1e5) / 1e5, Math.round(i.lng * 1e5) / 1e5] : [])]),
  };
  const existingIdx = listsData.lists.findIndex((l) => l.key === list.key);
  if (existingIdx >= 0) listsData.lists[existingIdx] = entry;
  else {
    const afterIdx = listsData.lists.findIndex((l) => l.key === (list.after || 'zokumeijo'));
    listsData.lists.splice(afterIdx >= 0 ? afterIdx + 1 : listsData.lists.length, 0, entry);
  }
  await writeFile(listsPath, JSON.stringify(listsData));

  // data/spots：同じ id の spot が既にあれば lists に key を足すだけ（build-spots.mjs の合流と同じ扱い）、なければ新規に追加
  const spotsDir = path.join(OUT, 'spots');
  const files = (await readdir(spotsDir)).filter((f) => f.endsWith('.json') && f !== 'meta.json');
  const tiles = new Map(); // tileKey（拡張子なし） → 配列
  const byId = new Map(); // id → tileKey
  for (const f of files) {
    const tk = f.replace(/\.json$/, '');
    const arr = JSON.parse(await readFile(path.join(spotsDir, f), 'utf8'));
    tiles.set(tk, arr);
    for (const s of arr) byId.set(s[0], tk);
  }
  // 作り直す一覧は、前の項目から一覧の印（lists の key）を外す。その一覧だけでできていた場所（kind が key で、他の一覧に入っていないもの）は消す
  let removed = 0;
  for (const [tk, arr] of tiles) {
    const keep = [];
    for (const s of arr) {
      if (!s[7].includes(list.key)) { keep.push(s); continue; }
      s[7] = s[7].filter((k) => k !== list.key);
      if (s[1] === list.key && !s[7].length && s[5] === 'list') { removed++; byId.delete(s[0]); continue; }
      if (s[1] === list.key && s[7].length) s[1] = s[7][0]; // 種類は残った一覧の1つめに
      keep.push(s);
    }
    tiles.set(tk, keep);
  }
  let added = 0, merged = 0;
  for (const it of items) {
    if (it.lat === null) continue; // 座標がない場所は一覧には出すが判子の地図には出さない（他の一覧と同じ）
    const existingTk = byId.get(it.id);
    if (existingTk) {
      const s = tiles.get(existingTk).find((x) => x[0] === it.id);
      if (!s[7].includes(list.key)) { s[7].push(list.key); merged++; }
      s[6] = Math.max(s[6], list.radius);
      if (!s[8]) s[8] = it.pref;
      continue;
    }
    const tk = tileKey(it.lat, it.lng);
    if (!tiles.has(tk)) tiles.set(tk, []);
    tiles.get(tk).push([it.id, list.key, it.name, it.lat, it.lng, 'list', list.radius, [list.key], it.pref, it.country || '日本']);
    byId.set(it.id, tk);
    added++;
  }
  for (const [tk, arr] of tiles) { const f = path.join(spotsDir, `${tk}.json`); if (arr.length) await writeFile(f, JSON.stringify(arr)); else await rm(f, { force: true }); }

  // meta.json：件数・区画一覧・tileCounts・counts を更新
  const metaPath = path.join(spotsDir, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  meta.generatedAt = new Date().toISOString();
  meta.spots = [...tiles.values()].reduce((n, arr) => n + arr.length, 0);
  meta.tiles = [...tiles.keys()].sort();
  meta.counts[list.key] = { total: items.length, withCoord: items.filter((i) => i.lat !== null).length };
  meta.tileCounts = Object.fromEntries([...tiles].map(([k, l]) => [k, [l.filter((s) => s[5] !== 'near').length, l.filter((s) => s[5] === 'near').length]]));
  await writeFile(metaPath, JSON.stringify(meta));

  console.log(`新規の場所 ${added} 件、既存の場所に合流 ${merged} 件、前の項目を外した ${removed} 件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
