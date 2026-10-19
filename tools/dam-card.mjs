// ダムカード：国土交通省「ダムカード」配布ダム一覧（XLSX）を取り、Wikidata（CC0）のダムと名前（＋都道府県）で名寄せして一覧にする
// 出典：国土交通省「ダムカード」配布ダム一覧（政府標準利用規約 PDL1.0 に準拠、加工して作成）
//   https://www.mlit.go.jp/river/kankyo/campaign/shunnkan/damcard.html のページから最新の配布ダム一覧（damcard_*_update.xlsx）のリンクをたどって取る
//   列：A 番号・B 水系名・C 河川名・D ダム名・E ver・F 配布場所・G 配布時間・H 都道府県・I 配布場所の住所・J URL
//   座標は一覧に無いので、Wikidata のダム（Q12323 とその下位、P17=Q17、P625 あり）のラベル・別名と名前で合わせる。合わなかったものは座標なし（一覧には載せ、地図には出さない）
//   カードの画像は載せない
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'tabigoyomi-build-damcard/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)';
const PAGE = 'https://www.mlit.go.jp/river/kankyo/campaign/shunnkan/damcard.html';

// ダム名の表記ゆれをそろえる（全角半角・空白・「ダム」「堰」の有無・括弧書き）
export const DAM_STATS = {};
export const normDam = (s) => (s || '').normalize('NFKC').replace(/[\s　]/g, '').replace(/[（(].*?[）)]/g, '').replace(/(ダム|堰|えん堤|堰堤)$/, '').replace(/ヶ|ケ|ヵ/g, 'ケ').replace(/[ー－‐-]/g, '');

// 配布ダム一覧の行 → [{ no, name, pref, place, river }]（ダム名・都道府県の組で重複を1つに）
export function damRowsOf(rows) {
  const out = []; const seen = new Set();
  for (const r of rows) {
    if (!/^\d+$/.test(r.A || '') || !r.D) continue;
    const key = `${r.D}|${r.H}`;
    if (seen.has(key)) { const prev = out.find((x) => `${x.name}|${x.pref}` === key); if (prev && r.F && !prev.places.includes(r.F)) prev.places.push(r.F); continue; }
    seen.add(key);
    out.push({ no: Number(r.A), name: r.D.trim(), pref: (r.H || '').trim(), places: r.F ? [r.F.trim()] : [], river: (r.C || '').trim() });
  }
  return out;
}

async function download(cacheDir, refresh) {
  const xlsx = path.join(cacheDir, 'damcard.xlsx');
  const meta = path.join(cacheDir, 'damcard-meta.json');
  if (!refresh && existsSync(xlsx) && existsSync(meta)) return JSON.parse(await readFile(meta, 'utf8'));
  const html = await (await fetch(PAGE, { headers: { 'User-Agent': UA } })).text();
  const m = /href="([^"]*damcard_\d+_update\.xlsx)"/.exec(html); // ページの先頭に出る最新のもの
  if (!m) throw new Error('配布ダム一覧（xlsx）のリンクが見つかりません');
  const url = new URL(m[1], PAGE).toString();
  const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  await mkdir(cacheDir, { recursive: true });
  await writeFile(xlsx, buf);
  const info = { url, bytes: buf.length };
  await writeFile(meta, JSON.stringify(info));
  return info;
}

// Wikidata のダム：{ id, label, aliases[], lat, lng, pref }[]
async function wikidataDams(cacheDir, sparql) {
  const rows = await sparql(`SELECT ?s ?l ?al ?c WHERE { ?s wdt:P31/wdt:P279* wd:Q12323 ; wdt:P17 wd:Q17 ; wdt:P625 ?c .
    OPTIONAL { ?s rdfs:label ?l FILTER(LANG(?l) = "ja") } OPTIONAL { ?s skos:altLabel ?al FILTER(LANG(?al) = "ja") } }`, 'damcard-wd-dams');
  const m = new Map();
  for (const r of rows) {
    const id = r.s.value.split('/').pop();
    const p = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.c.value);
    if (!p) continue;
    const cur = m.get(id) || { id, label: '', aliases: new Set(), lat: Number(p[2]), lng: Number(p[1]), pref: '' };
    if (r.l) cur.label = r.l.value;
    if (r.al) cur.aliases.add(r.al.value);
    m.set(id, cur);
  }
  const ids = [...m.keys()];
  for (let i = 0; i < ids.length; i += 300) {
    const pr = await sparql(`SELECT ?s ?pl WHERE { VALUES ?s { ${ids.slice(i, i + 300).map((q) => 'wd:' + q).join(' ')} } ?s wdt:P131+ ?p . ?p wdt:P31 wd:Q50337 ; rdfs:label ?pl FILTER(LANG(?pl) = "ja") }`, `damcard-wd-pref-${i}`);
    for (const r of pr) { const d = m.get(r.s.value.split('/').pop()); if (d && !d.pref) d.pref = r.pl.value; }
  }
  return [...m.values()].filter((d) => d.label);
}

// list.dam：戻り [{ id, name, lat, lng, pref, country, places }]。report にあわせた件数・合わなかった名前は stats に
export async function fetchDamList(list, { cacheDir, refresh, sparql, gsiPref, stats = DAM_STATS }) {
  const info = await download(cacheDir, refresh);
  const rows = JSON.parse(execFileSync('python', ['-I', path.join(root, 'tools', 'read-xlsx.py'), path.join(cacheDir, 'damcard.xlsx')], { maxBuffer: 1 << 26 }).toString('utf8'));
  const dams = damRowsOf(rows);
  const wd = await wikidataDams(cacheDir, sparql);
  const byName = new Map();
  for (const d of wd) for (const n of [d.label, ...d.aliases]) { const k = normDam(n); if (!byName.has(k)) byName.set(k, []); if (!byName.get(k).includes(d)) byName.get(k).push(d); }
  const used = new Set(); const out = []; const missing = [];
  for (const r of dams) {
    const cands = (byName.get(normDam(r.name)) || []).filter((d) => !used.has(d.id));
    let hit = cands.find((d) => d.pref && d.pref === r.pref) || (cands.length === 1 && (!cands[0].pref || cands[0].pref === r.pref) ? cands[0] : null);
    // 都道府県が合うものが無ければ、同じ名前が1つだけで、県が違う場合は採らない（同名の別のダム）
    if (hit) used.add(hit.id);
    else missing.push(`${r.name}（${r.pref}）`);
    out.push({ id: hit ? hit.id : `damcard_${r.no}`, name: r.name, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null, pref: r.pref, country: '日本', places: r.places });
  }
  stats.total = dams.length; stats.matched = dams.length - missing.length; stats.missing = missing; stats.source = info.url; stats.rows = rows.filter((r) => /^\d+$/.test(r.A || '')).length;
  return out;
}
