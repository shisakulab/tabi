// 海外の場所の名前と説明文を日本語にする
//   node tools/build-names-ja.mjs            まだ日本語になっていない分だけ調べて訳し、data/ に反映する
//   node tools/build-names-ja.mjs --no-ai    Wikidata から取れる分だけ（AI の翻訳をしない）
//   node tools/build-names-ja.mjs --skip-wd  Wikidata は探し直さず、残りを訳す
//   node tools/build-names-ja.mjs --apply    tools/names-ja.json の内容を data/ に反映するだけ
// 手順
//  1. 日本語名が無い海外の場所（世界遺産の構成資産・世界の祭り・海外のご当地、tools/near-world 等の extra）を集める
//  2. Wikidata を取り直す：日本語版 Wikipedia の題（sitelink）→ 日本語ラベル → 日本語の別名（skos:altLabel）の順
//  3. それでも無いものは `claude -p`（Claude のサブスクの範囲。従量課金の API は使わない）でまとめて日本語に訳す
//     固有名詞はカタカナ、一般名詞は訳す。結果は tools/names-ja.json に入れ、作り直しで毎回は訳さない
//  4. 場所の説明文（data/photos/ の英語の説明）も同じ要領で訳す
//  5. data/ に反映：lists.json・spots/（名前）、festivals.json、world-foods.json、photos/（説明）。元の名前は data/names-en.json（id → 元の名前）
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasJa, loadNamesJa, NAMES_FILE, jaName, jaDesc } from './names-ja.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'data');
const CACHE = path.join(root, 'tools', '.cache');
const UA = 'tabigoyomi-build-names/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const NO_AI = args.includes('--no-ai');
const APPLY_ONLY = args.includes('--apply');
const SKIP_WD = args.includes('--skip-wd'); // Wikidata を探し直さない
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; } };

// ---------- 集める ----------
// 戻り：names = Map(id → { name, kind('place'|'dish'|'festival'), country })、descs = Set(英語の説明)
async function collect() {
  const names = new Map(); const descs = new Set();
  const lists = (await readJson(path.join(DATA, 'lists.json'), { lists: [] })).lists;
  for (const l of lists) {
    if (!l.global) continue;
    for (const it of l.items) if (/^Q\d+$/.test(it[0]) && !hasJa(it[1])) names.set(it[0], { name: it[1], kind: 'place', country: it[4] || '' });
  }
  const fest = await readJson(path.join(DATA, 'festivals.json'), { items: [] });
  for (const r of fest.items) if (r[8] && !hasJa(r[1])) names.set(r[0], { name: r[1], kind: 'festival', country: r[5] });
  const foods = await readJson(path.join(DATA, 'world-foods.json'), []);
  for (const f of foods) {
    const q = (/^w_(Q\d+)/.exec(f.key) || [])[1];
    if (q && !hasJa(f.name)) names.set(q, { name: f.name, kind: 'dish', country: f.country });
    if (f.desc && !hasJa(f.desc)) descs.add(f.desc);
  }
  // 海外の近所の場所（data/spots/ の tier=near で country が日本以外）の OSM 名は、OSM の name:ja を取ったあとの残りだけ extra に入る（tools/near-world-names.json）
  const extra = await readJson(path.join(root, 'tools', 'near-world-names.json'), {});
  for (const [id, v] of Object.entries(extra)) if (!hasJa(v.name)) names.set(id, { name: v.name, kind: v.kind || 'near', country: v.country || '', hint: v.hint || '' });
  for (const f of await readdir(path.join(DATA, 'photos'))) {
    const j = await readJson(path.join(DATA, 'photos', f), {});
    for (const v of Object.values(j)) if (v[3] && !hasJa(v[3])) descs.add(v[3]);
  }
  return { names, descs };
}

// ---------- Wikidata ----------
async function sparql(query) {
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(8000 * i);
    try {
      const res = await fetch('https://query.wikidata.org/sparql', { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'query=' + encodeURIComponent(query) });
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()).results.bindings;
    } catch (e) { console.log('Wikidata 失敗', e.message, '（再試行）'); }
  }
  throw new Error('Wikidata を取れませんでした');
}
const cleanTitle = (t) => t.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim() || t;
async function fromWikidata(ids) {
  const out = new Map(); // id → [名前, 出どころ]
  const rank = { wiki: 3, label: 2, alias: 1 };
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const file = path.join(CACHE, `names-wd-${i}-${chunk[0]}-${chunk.length}.json`);
    let rows = existsSync(file) ? await readJson(file, null) : null;
    if (!rows) {
      rows = await sparql(`SELECT ?s ?kind ?v WHERE { VALUES ?s { ${chunk.map((q) => 'wd:' + q).join(' ')} }
        { ?s rdfs:label ?v FILTER(LANG(?v) = "ja") BIND("label" AS ?kind) }
        UNION { ?s skos:altLabel ?v FILTER(LANG(?v) = "ja") BIND("alias" AS ?kind) }
        UNION { ?a schema:about ?s ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?v BIND("wiki" AS ?kind) } }`);
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, JSON.stringify(rows));
    }
    for (const r of rows) {
      const id = r.s.value.split('/').pop(); const kind = r.kind.value; const v = kind === 'wiki' ? cleanTitle(r.v.value) : r.v.value;
      const cur = out.get(id);
      if (!cur || rank[kind] > rank[cur[1]]) out.set(id, [v, kind]);
    }
    console.log(`Wikidata：${Math.min(i + 150, ids.length)} / ${ids.length}`);
    await sleep(1500);
  }
  return out;
}

// ---------- claude -p ----------
function claudeP(prompt, model) {
  return new Promise((resolve, reject) => {
    const p = spawn('C:/Users/小林/.local/bin/claude.exe', ['-p', '--model', model, '--tools', '', '--no-session-persistence'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, 300000);
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`exit ${code} ${err.slice(0, 200)}`)); });
    p.stdin.end(prompt);
  });
}
const PROMPTS = {
  place: '次は海外の名所・世界遺産・史跡・施設などの名前（英語や現地語）と所在する国です。日本語の名前にしてください。',
  festival: '次は海外の祭り・行事の名前（英語や現地語）と国です。日本語の名前にしてください。',
  near: '次は海外の街にある施設（教会・モスク・博物館・美術館・展望台・名所・パン屋・喫茶店など）の名前（現地語や英語）と国です。日本語の名前にしてください。店名は音をカタカナにし、一般名詞の部分（教会・博物館・カフェなど）は日本語にする。',
  dish: '次は海外の料理・食べ物の名前（英語や現地語）と国です。日本語での一般的な呼び名にしてください（知られていなければカタカナ）。',
  desc: '次は Wikidata の場所の短い説明文（英語）です。日本語の短い説明（名詞句。例「ドイツの大聖堂」「世界遺産の一部（ドイツ）」「イタリアの宮殿」）にしてください。',
};
const RULES = `規則：
- 固有名詞（人名・地名・作品名）はカタカナ、一般名詞（教会・城・橋・公園・遺跡・駅・修道院など）は日本語に訳す。
- 日本語の資料で定着した呼び名（例：メンフィスとその墓地遺跡）があればそれを使う。
- 原語の併記や括弧書きの注釈は付けない。長い名前も省略しない。
- 記号・番号だけで意味のない名前（例：EC-CQ-09/CS-2011）はそのまま返す。
- 入力と同じ長さ・同じ順番の JSON 配列（文字列だけ）だけを出力する。前後の説明やコードブロックは付けない。`;
// 出力から最初の JSON 配列を取り出す（前後に説明が付いていてもよい）
function extractArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0; let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '[') depth++; else if (ch === ']' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}
async function translateBatch(items, kind, model, depth = 0) {
  const input = kind === 'desc' ? items : items.map((x) => `${x.name}${x.hint ? `（英語名：${x.hint}）` : ''} ／ ${x.country}`);
  const prompt = `${PROMPTS[kind]}\n${RULES}\n\n入力（JSON 配列、${input.length} 件）：\n${JSON.stringify(input)}\n`;
  try {
    const text = await claudeP(prompt, model);
    const arr = extractArray(text);
    if (!Array.isArray(arr) || arr.length !== input.length || arr.some((s) => typeof s !== 'string')) throw new Error('形が合いません');
    return arr;
  } catch (e) {
    if (items.length > 1 && depth < 3) { // 半分に分けてやり直す
      console.log(`  翻訳やり直し（${items.length} 件を半分に）：${String(e.message).slice(0, 80)}`);
      const h = Math.ceil(items.length / 2);
      return [...await translateBatch(items.slice(0, h), kind, model, depth + 1), ...await translateBatch(items.slice(h), kind, model, depth + 1)];
    }
    console.log(`  翻訳できませんでした：${JSON.stringify(items).slice(0, 80)} ${e.message.slice(0, 80)}`);
    return items.map(() => '');
  }
}
async function runPool(jobs, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; await jobs[k](); } }));
}

// 並行する翻訳の保存が重ならないよう、1つずつ順に書く
let saving = Promise.resolve();
function save(tables) {
  saving = saving.then(async () => {
    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
    // 書き込みの途中で止まっても壊れないよう、別のファイルに書いてから置き換える
    await writeFile(NAMES_FILE + '.tmp', JSON.stringify({ names: sortObj(tables.names), desc: sortObj(tables.desc), wd: [...new Set(tables.wd)].sort() }));
    await rename(NAMES_FILE + '.tmp', NAMES_FILE);
  });
  return saving;
}

// ---------- data/ に反映 ----------
async function applyAll(tables) {
  const stat = {};
  const orig = {}; // id → 元の名前（置き換えたもの）
  // lists.json
  const lf = path.join(DATA, 'lists.json');
  const lj = await readJson(lf, null);
  let n = 0;
  for (const l of lj.lists) for (const it of l.items) {
    const r = jaName(tables, it[0], it[1]);
    if (r.orig) { it[1] = r.name; orig[it[0]] = r.orig; n++; }
    else if (tables.names[it[0]] && hasJa(it[1]) && tables.names[it[0]][2] !== it[1] && l.global) orig[it[0]] = tables.names[it[0]][2];
  }
  if (n) await writeFile(lf, JSON.stringify(lj));
  stat.lists = n;
  // spots/（一覧の場所の名前。区画ごと）
  n = 0; let tilesChanged = 0;
  for (const f of await readdir(path.join(DATA, 'spots'))) {
    if (f === 'meta.json') continue;
    const file = path.join(DATA, 'spots', f);
    const text = await readFile(file, 'utf8');
    const tile = JSON.parse(text); let changed = false;
    for (const s of tile) {
      if (s[5] === 'near') continue; // 海外の街の場所は tools/build-world-near.mjs が名前と元の名前（行の11番目）を入れる
      const r = jaName(tables, s[0], s[2]);
      if (r.orig) { s[2] = r.name; orig[s[0]] = r.orig; changed = true; n++; }
      else if (tables.names[s[0]] && hasJa(s[2]) && tables.names[s[0]][2] !== s[2]) orig[s[0]] = tables.names[s[0]][2];
    }
    if (changed) { await writeFile(file, JSON.stringify(tile)); tilesChanged++; }
  }
  stat.spots = n; stat.tiles = tilesChanged;
  // festivals.json（名前を日本語に。元の名前は 9 番目に残す）
  const ff = path.join(DATA, 'festivals.json');
  const fj = await readJson(ff, null);
  if (fj) {
    n = 0;
    for (const r of fj.items) { const x = jaName(tables, r[0], r[1]); if (x.orig) { r[1] = x.name; r[8] = x.orig; n++; } }
    if (n) await writeFile(ff, JSON.stringify(fj));
    stat.festivals = n;
  }
  // world-foods.json（名前と説明。元の名前は en）
  const wf = path.join(DATA, 'world-foods.json');
  const wj = await readJson(wf, null);
  if (wj) {
    n = 0;
    for (const f of wj) {
      const q = (/^w_(Q\d+)/.exec(f.key) || [])[1];
      const x = q ? jaName(tables, q, f.name) : { name: f.name, orig: '' };
      if (x.orig) { f.name = x.name; f.en = x.orig; n++; }
      const d = jaDesc(tables, f.desc); if (d !== f.desc) { f.desc = d; n++; }
    }
    if (n) await writeFile(wf, JSON.stringify(wj));
    stat.worldFoods = n;
  }
  // photos/（説明文）
  n = 0;
  for (const f of await readdir(path.join(DATA, 'photos'))) {
    const file = path.join(DATA, 'photos', f);
    const j = await readJson(file, {}); let changed = false;
    for (const v of Object.values(j)) { const d = jaDesc(tables, v[3]); if (d !== v[3]) { v[3] = d; changed = true; n++; } }
    if (changed) await writeFile(file, JSON.stringify(j));
  }
  stat.descs = n;
  // 元の名前（検索と、カードの小さな併記に使う）。festivals・near-world は各ファイルから足す
  if (fj) for (const r of fj.items) if (r[8] && r[8] !== r[1]) orig[r[0]] = r[8];
  await writeFile(path.join(DATA, 'names-en.json'), JSON.stringify(Object.fromEntries(Object.entries(orig).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })))));
  console.log('反映：', JSON.stringify(stat), `元の名前 ${Object.keys(orig).length} 件`);
}

async function main() {
  const tables = loadNamesJa();
  if (!APPLY_ONLY) {
    const { names, descs } = await collect();
    const todo = [...names.entries()].filter(([id, v]) => !(tables.names[id] && tables.names[id][0] && tables.names[id][2] === v.name));
    console.log(`日本語名がない：${names.size} 件（うち調べる分 ${todo.length}）、英語の説明文 ${descs.size} 種`);
    // 2. Wikidata
    const qids = todo.map(([id]) => id).filter((id) => /^Q\d+$/.test(id));
    const wd = await fromWikidata(qids);
    let got = 0;
    for (const [id, v] of todo) { const w = wd.get(id); if (w && hasJa(w[0])) { tables.names[id] = [w[0], w[1], v.name]; got++; } }
    const bySource = {}; for (const [id] of todo) { const e = tables.names[id]; if (e) bySource[e[1]] = (bySource[e[1]] || 0) + 1; }
    console.log(`Wikidata で日本語名が取れた：${got} 件`, JSON.stringify(bySource));
    tables.wd.push(...qids);
    await save(tables);
    // 3. AI
    if (!NO_AI) {
      const rest = todo.filter(([id]) => !tables.names[id]);
      const BATCH = 70;
      for (const kind of ['place', 'festival', 'dish', 'near']) {
        const items = rest.filter(([, v]) => v.kind === kind);
        const jobs = [];
        for (let i = 0; i < items.length; i += BATCH) {
          const chunk = items.slice(i, i + BATCH);
          jobs.push(async () => {
            const out = await translateBatch(chunk.map(([, v]) => v), kind, kind === 'near' ? 'haiku' : 'sonnet'); // 街の施設名（数が多い）は haiku
            chunk.forEach(([id, v], k) => { if (hasJa(out[k])) tables.names[id] = [out[k].trim(), 'ai', v.name]; });
            console.log(`  ${kind}：${Math.min(i + BATCH, items.length)} / ${items.length}`);
            await save(tables);
          });
        }
        if (jobs.length) { console.log(`AI で訳す（${kind}）：${items.length} 件`); await runPool(jobs, 3); }
      }
      const dl = [...descs].filter((d) => !tables.desc[d]);
      const jobs = [];
      for (let i = 0; i < dl.length; i += 100) {
        const chunk = dl.slice(i, i + 100);
        jobs.push(async () => {
          const out = await translateBatch(chunk, 'desc', 'sonnet');
          chunk.forEach((d, k) => { if (hasJa(out[k])) tables.desc[d] = out[k].trim(); });
          console.log(`  説明文：${Math.min(i + 100, dl.length)} / ${dl.length}`);
          await save(tables);
        });
      }
      if (jobs.length) { console.log(`AI で訳す（説明文）：${dl.length} 種`); await runPool(jobs, 3); }
    }
    await save(tables);
    const left = [...names.keys()].filter((id) => !tables.names[id]);
    console.log(`残り（日本語にできなかった名前）：${left.length} 件`, left.slice(0, 10).map((id) => names.get(id).name).join(' / '));
    console.log(`説明文の残り：${[...descs].filter((d) => !tables.desc[d]).length} 種`);
  }
  await applyAll(tables);
}
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exit(1); });
