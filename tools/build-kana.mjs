// 帳面の検索用に、一覧の場所の読み仮名（Wikidata P1814）と日本語の別名を取って data/kana.json に書く
// 例：鹿苑寺 → 「ろくおんじ 金閣寺 きんかくじ」。名前が漢字だけでも、ひらがなや通称で探せるようにする
// Wikidata の読み（P1814）は少ないので、名前と別名の読みを kuromoji（形態素解析）で作って足す
//   npm i --prefix <どこか> kuromoji してから
//   KUROMOJI_DIR=<どこか>/node_modules/kuromoji node tools/build-kana.mjs
// 対象は data/lists.json の Q 番号と themes/seasons.js（季節の名所は s_<key>）
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import seasons from '../themes/seasons.js';

const HEADERS = {
  'User-Agent': 'tabigoyomi-build-kana/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)',
  Accept: 'application/sparql-results+json',
};
const KURO = process.env.KUROMOJI_DIR;
if (!KURO) throw new Error('KUROMOJI_DIR を指定してください');
const kuromoji = createRequire(import.meta.url)(KURO);
const tokenizer = await new Promise((ok, ng) => kuromoji.builder({ dicPath: KURO + '/dict' }).build((e, t) => (e ? ng(e) : ok(t))));
const readingOf = (w) => tokenizer.tokenize(w).map((t) => (t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join('');

const lists = JSON.parse(readFileSync(new URL('../data/lists.json', import.meta.url), 'utf8')).lists;
const ids = new Set();
const names = new Map();
for (const l of lists) for (const [id, name] of l.items) if (/^Q\d+$/.test(id)) { ids.add(id); names.set(id, name); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function query(q) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch('https://query.wikidata.org/sparql', { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'query=' + encodeURIComponent(q) });
    if (res.ok) return (await res.json()).results.bindings;
    await sleep(5000 * (i + 1));
  }
  throw new Error('Wikidata に繋がりませんでした');
}

const out = {};
const add = (id, w) => {
  if (!w) return;
  const set = out[id] || (out[id] = new Set());
  set.add(w.trim());
};
const all = [...ids];
for (let i = 0; i < all.length; i += 300) {
  const values = all.slice(i, i + 300).map((q) => 'wd:' + q).join(' ');
  const rows = await query(`SELECT ?item ?kana ?alias WHERE {
    VALUES ?item { ${values} }
    { ?item wdt:P1814 ?kana. } UNION { ?item skos:altLabel ?alias. FILTER(LANG(?alias) = "ja") }
  }`);
  for (const r of rows) {
    const id = r.item.value.split('/').pop();
    add(id, r.kana && r.kana.value);
    add(id, r.alias && r.alias.value);
  }
  console.log(`${Math.min(i + 300, all.length)} / ${all.length}`);
  await sleep(1000);
}
// 名前と別名の読みを足す（同じ読みは1つに）
for (const [id, name] of names) {
  const words = [name, ...(out[id] || [])];
  for (const w of words) { const r = readingOf(w); if (r && r !== w) add(id, r); }
}
for (const s of seasons) {
  const id = `s_${s.key}`;
  add(id, readingOf(s.name));
}
const json = Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, [...v].join(' ')]));
writeFileSync(new URL('../data/kana.json', import.meta.url), JSON.stringify(json));
console.log(`読み・別名あり ${Object.keys(json).length} 件（一覧 ${all.length}・季節の名所 ${seasons.length}）`);
