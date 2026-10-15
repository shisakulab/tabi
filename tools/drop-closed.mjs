// もう無い催し・施設（tools/build-spots.mjs の CLOSED_SPOTS）を、いまの data/ から外す
//   node tools/drop-closed.mjs
// build-spots.mjs を丸ごと作り直すと、他の場所の座標が少し動くことがあるので、
// 作り直さずに lists.json・区画・meta.json から該当の場所だけを取り除く（何度走らせても同じ結果）。
// 作り直すときは build-spots.mjs が同じ表で外す。判子（端末の IndexedDB）には触らない
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLOSED_SPOTS } from './build-spots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'data');
const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));

const lists = await readJson(path.join(DATA, 'lists.json'));
const meta = await readJson(path.join(DATA, 'spots', 'meta.json'));

let listRemoved = 0;
for (const l of lists.lists) {
  const kept = l.items.filter((it) => !CLOSED_SPOTS.has(it[0]));
  listRemoved += l.items.length - kept.length;
  l.items = kept;
  if (meta.counts && meta.counts[l.key]) meta.counts[l.key] = { total: kept.length, withCoord: kept.filter((it) => it[3] === 1).length };
}
await writeFile(path.join(DATA, 'lists.json'), JSON.stringify(lists));

let spotRemoved = 0;
const tiles = new Set(meta.tiles);
for (const k of meta.tiles) {
  const f = path.join(DATA, 'spots', `${k}.json`);
  const list = await readJson(f);
  const kept = list.filter((s) => !CLOSED_SPOTS.has(s[0]));
  if (kept.length === list.length) continue;
  spotRemoved += list.length - kept.length;
  if (kept.length) {
    await writeFile(f, JSON.stringify(kept));
    meta.tileCounts[k] = [kept.filter((s) => s[5] !== 'near').length, kept.filter((s) => s[5] === 'near').length];
  } else {
    await rm(f);
    tiles.delete(k);
    delete meta.tileCounts[k];
  }
}
meta.tiles = [...tiles].sort();
meta.spots -= spotRemoved;
await writeFile(path.join(DATA, 'spots', 'meta.json'), JSON.stringify(meta));
console.log(`一覧から ${listRemoved} 件、地図の場所から ${spotRemoved} 件を外した（対象 ${CLOSED_SPOTS.size} 件）`);
