// ご当地グルメ（data/foods.json の main=true）ごとに、その料理を出すお店を OSM から拾って data/food-shops.json を作る。
// 材料は tools/osm-food-shops.py が地方ごとに書いた shops-*.json（飲食店の名前・別名・cuisine つき）。検索語は tools/food-shop-terms.json（手で足せる）。
// 使い方: node tools/build-food-shops.mjs <shops-*.json のあるフォルダ>
// 拾い方: 店名（name・name:ja・別名）に検索語が入っている店を、その料理の都道府県と隣の県で拾う。
//         cuisine が一致する店（terms の cuisine）は、その料理の県の中だけで足す。1料理 MAX_PER_FOOD 店まで（語に一致した店を先に）
// 出力 data/food-shops.json: { 料理キー: [{ id: 'n123' | 'w123', name, lat, lng }] }（出典 OSM、ODbL）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) { console.error('使い方: node tools/build-food-shops.mjs <shops-*.json のあるフォルダ>'); process.exit(1); }
const MAX_PER_FOOD = 400;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
// 隣り合う県（県コード 1〜47）
const NEXT = { 2: [3, 5], 3: [2, 5, 4], 4: [3, 5, 6, 7], 5: [2, 3, 4, 6], 6: [4, 5, 7, 15], 7: [4, 6, 8, 9, 10, 15], 8: [7, 9, 11, 12], 9: [7, 8, 10, 11], 10: [7, 9, 11, 15, 20], 11: [8, 9, 10, 12, 13, 19, 20], 12: [8, 11, 13], 13: [11, 12, 14, 19], 14: [13, 19, 22], 15: [6, 7, 10, 16, 20], 16: [15, 17, 20, 21], 17: [16, 18, 21], 18: [17, 21, 25, 26], 19: [11, 13, 14, 20, 22], 20: [10, 11, 15, 16, 19, 21, 22, 23], 21: [16, 17, 18, 20, 23, 24, 25], 22: [14, 19, 20, 23], 23: [20, 21, 22, 24], 24: [21, 23, 25, 26, 29, 30], 25: [18, 21, 24, 26], 26: [18, 24, 25, 27, 28, 29], 27: [26, 28, 29, 30], 28: [26, 27, 31, 33, 36], 29: [24, 26, 27, 30], 30: [24, 27, 29], 31: [28, 32, 33, 34], 32: [31, 34, 35], 33: [28, 31, 34, 37], 34: [31, 32, 33, 35, 38], 35: [32, 34, 40], 36: [28, 37, 38, 39], 37: [33, 36, 38], 38: [34, 36, 37, 39], 39: [36, 38], 40: [35, 41, 43, 44], 41: [40, 42], 42: [41], 43: [40, 44, 45, 46], 44: [40, 43, 45], 45: [43, 44, 46], 46: [43, 45] };

// 比べる前にそろえる：全角半角・大文字小文字・カタカナ→ひらがな・空白と中黒を除く
const norm = (s) => (s || '').normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s・･]/g, '');

const foods = JSON.parse(fs.readFileSync(path.join(root, 'data/foods.json'), 'utf8')).filter((f) => f.main);
const terms = JSON.parse(fs.readFileSync(path.join(root, 'tools/food-shop-terms.json'), 'utf8'));
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => /^shops-.*\.json$/.test(x))) rows.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
// 地方のファイルは境目で重なるので id で1つに
const seen = new Set();
const all = rows.filter((r) => (seen.has(r[1]) ? false : (seen.add(r[1]), true))).map((r) => ({ pref: r[0], id: r[1], name: r[2], names: [r[2], ...r[3]].map(norm), cuisine: r[4].split(';'), lat: r[6], lng: r[7] }));
console.log('飲食店', all.length);

const out = {}; const report = [];
for (const food of foods) {
  const t = terms[food.key] || {};
  const code = PREFS.indexOf(food.pref) + 1;
  const ts = (t.terms || []).map(norm).filter(Boolean);
  const near = new Set([code, ...(NEXT[code] || [])]);
  const byName = ts.length ? all.filter((s) => near.has(s.pref) && s.names.some((n) => ts.some((w) => n.includes(w)))) : [];
  const names = new Set(byName.map((s) => s.id));
  const byCuisine = (t.cuisine || []).length ? all.filter((s) => s.pref === code && !names.has(s.id) && s.cuisine.some((c) => t.cuisine.includes(c))) : [];
  // 同じ県の店を先に、そのあと隣の県。語に一致した店のあとに cuisine
  const rank = (s) => (s.pref === code ? 0 : 1);
  const list = [...byName.sort((a, b) => rank(a) - rank(b)), ...byCuisine].slice(0, MAX_PER_FOOD);
  if (list.length) out[food.key] = list.map((s) => ({ id: s.id, name: s.name, lat: +s.lat.toFixed(5), lng: +s.lng.toFixed(5) }));
  const cnt = new Map(); for (const s of list) cnt.set(s.name, (cnt.get(s.name) || 0) + 1);
  const chains = [...cnt].filter(([, n]) => n >= 3).map(([n, c]) => `${n}×${c}`);
  report.push({ key: food.key, name: food.name, pref: food.pref, n: list.length, byName: byName.length, byCuisine: byCuisine.length, chains });
}
fs.writeFileSync(path.join(root, 'data/food-shops.json'), JSON.stringify(out));
report.sort((a, b) => b.n - a.n);
console.log('拾えた料理', report.filter((r) => r.n).length, '/', report.length, '　0店', report.filter((r) => !r.n).length, '　店の延べ数', report.reduce((a, r) => a + r.n, 0));
for (const r of report.slice(0, 15)) console.log(r.n, r.name, r.pref, `(語${r.byName}/cuisine${r.byCuisine})`, r.chains.join(' '));
console.log('0店:', report.filter((r) => !r.n).map((r) => r.name).join('、'));
console.log('サイズ', fs.statSync(path.join(root, 'data/food-shops.json')).size);
