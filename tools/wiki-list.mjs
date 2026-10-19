// 日本語版 Wikipedia の「一覧」ページの表（番号つき）から、一覧の項目を作る（tools/build-spots.mjs の LISTS で wiki: { page, lo, hi } を指定した一覧）
// 表の行：番号のセルの次のセルの最初のリンクが、その項目の記事。記事 → Wikidata の項目（pageprops の wikibase_item）→ 座標（P625）を引く。
// 記事へのリンクが無い行（記事のない名水など）は、一覧には載せるが座標のない項目（id は `<キー>_<番号>`）にする
// 出典：Wikipedia（CC BY-SA）の表は一覧の「項目名と順番」だけを使い、座標・名前は Wikidata（CC0）から。Wikipedia のテキストは再配布しない
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const UA = 'tabigoyomi-build-wikilist/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ページの表の行を取り出す：[{ no, title, label }]
export function parseWikiRows(wikitext, lo, hi, opts = {}) {
  const out = new Map();
  const nameCol = opts.nameCol || 1; // 番号のセルから数えて何番目のセルが名前か
  for (const blk of wikitext.split(/\n\|-/)) {
    const lines = blk.split('\n').map((l) => l.trimEnd());
    // 番号のセル：`|1`・`| 1`・`|style="..."|101`・`| 1 || [[...]]`
    let at = -1; let no = 0; let inline = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^[|!](?:[^|\n]*\|(?!\|))?\s*(\d{1,3})\s*(?:\|\|(.*))?$/.exec(lines[i]);
      if (m && !/\[\[/.test(lines[i].slice(0, 4))) { at = i; no = Number(m[1]); inline = m[2] ?? null; break; }
    }
    if (at < 0 || no < lo || no > hi || out.has(no)) continue;
    let cell;
    if (inline !== null) cell = inline.split('||')[nameCol - 1] || '';
    else { const cells = lines.slice(at + 1).filter((l) => /^[|!]/.test(l)); cell = (cells[nameCol - 1] || '').replace(/^[|!](?:[^|[]*\|(?!\|))?/, ''); }
    cell = cell.split('||')[0];
    cell = cell.replace(/<ref[^>]*>.*?<\/ref>/g, '').replace(/<ref[^>]*\/>/g, '');
    const link = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(cell);
    const plain = cell.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').replace(/<[^>]+>/g, '').replace(/["“”]/g, '').trim();
    if (!plain) continue;
    // 名前：リンクの表示名（複数のリンクが並ぶ名前は、リンクを外した文字列全体）
    const label = (link && cell.trim() === link[0] ? (link[2] || link[1]) : plain).replace(/["“”]/g, '').trim();
    out.set(no, { no, title: link ? link[1].trim() : null, label });
  }
  return [...out.values()].sort((a, b) => a.no - b.no);
}

const stripLinks = (t) => t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/<ref[^>]*>.*?<\/ref>/g, '').replace(/<[^>]+>/g, '').replace(/'''?/g, '').trim();
// 箇条書きの一覧（番号なし）：format 'tanada'＝「* [[岩手県]]」の下に「** [[記事|名前]]（市町村）」、'keikan'＝「* 名前（都道府県 市町村） - 選定日」
// 戻り：[{ no, title, label, pref, muni }]（no は出てきた順）
export function parseBulletRows(wikitext, format) {
  const out = [];
  let text = wikitext;
  if (format === 'keikan') { const i = text.indexOf('選定の答申を受けたもの'); if (i > 0) text = text.slice(0, i); const j = text.indexOf('重要文化的景観一覧'); if (j > 0) text = text.slice(j); }
  let pref = '';
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (format === 'tanada') {
      const p = /^\* \[\[([^\]|]*[都道府県])(?:\|[^\]]*)?\]\]\s*$/.exec(line);
      if (p) { pref = p[1]; continue; }
      const m = /^\*\* (.+)$/.exec(line);
      if (!m || /^\*/.test(m[1])) continue;
      const body = m[1];
      const paren = /[（(]([^）)]*(?:\[\[[^\]]*\]\][^）)]*)*)[）)]/.exec(body);
      const namePart = paren ? body.slice(0, paren.index) : body;
      const link = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(namePart);
      const label = stripLinks(namePart);
      if (!label) continue;
      out.push({ no: out.length + 1, title: link ? link[1].trim() : null, label, pref, muni: paren ? stripLinks(paren[1]) : '' });
    } else {
      const plainLine = line.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1'); // 先にリンクを外す（リンクの中の括弧に惑わされない）
      const m = /^\* (.+?)[（(]([^）)]*)[）)]/.exec(plainLine);
      if (!m) continue;
      const loc = stripLinks(m[2]);
      const label = stripLinks(m[1]);
      if (!label || !/[都道府県]/.test(loc)) continue;
      out.push({ no: out.length + 1, title: null, label, pref: '', muni: loc });
    }
  }
  return out;
}

// 国土地理院の住所検索（市町村の中心の座標）。結果はキャッシュ
async function gsiAddress(q, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, q)) return cache[q];
  let r = null;
  try {
    const j = await getJson('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q), 2);
    const f = (j || [])[0];
    if (f && f.geometry) r = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
  } catch { /* 取れなければ座標なし */ }
  cache[q] = r;
  await sleep(250);
  return r;
}

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(6000 * i);
    try { const res = await fetch(url, { headers: { 'User-Agent': UA } }); if (!res.ok) throw new Error(String(res.status)); return await res.json(); } catch (e) { /* 再試行 */ }
  }
  throw new Error('取得できませんでした: ' + url.slice(0, 100));
}
async function cached(file, refresh, fn) {
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const v = await fn();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(v));
  return v;
}

// 記事のタイトル → Wikidata の項目（リダイレクトをたどる）
async function titlesToQids(titles, cacheFile, refresh) {
  return cached(cacheFile, refresh, async () => {
    const map = {};
    for (let i = 0; i < titles.length; i += 40) {
      const chunk = titles.slice(i, i + 40);
      const u = new URL('https://ja.wikipedia.org/w/api.php');
      for (const [k, v] of Object.entries({ action: 'query', format: 'json', prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', titles: chunk.join('|') })) u.searchParams.set(k, v);
      const j = await getJson(u.toString());
      const norm = new Map((j.query.normalized || []).map((n) => [n.from, n.to]));
      const redir = new Map((j.query.redirects || []).map((n) => [n.from, n.to]));
      const byTitle = new Map(Object.values(j.query.pages || {}).map((p) => [p.title, p.pageprops && p.pageprops.wikibase_item]));
      for (const t of chunk) { let x = norm.get(t) || t; x = redir.get(x) || x; if (byTitle.get(x)) map[t] = byTitle.get(x); }
      await sleep(400);
    }
    return map;
  });
}

// 項目 → 座標（P625）
async function qidsToCoords(qids, cacheFile, refresh, sparql) {
  return cached(cacheFile, refresh, async () => {
    const map = {};
    for (let i = 0; i < qids.length; i += 200) {
      const chunk = qids.slice(i, i + 200);
      const rows = await sparql(`SELECT ?s ?c WHERE { VALUES ?s { ${chunk.map((q) => 'wd:' + q).join(' ')} } ?s wdt:P625 ?c . }`, `wl-coord-${path.basename(cacheFile, '.json')}-${i}`);
      for (const r of rows) {
        const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.c.value);
        const id = r.s.value.split('/').pop();
        if (m && !map[id]) map[id] = { lat: Number(m[2]), lng: Number(m[1]) };
      }
    }
    return map;
  });
}

// list.wiki = { page, lo, hi, nameCol? }。戻り：[{ id, name, lat, lng, pref, country }]。sparql：build-spots.mjs の問い合わせ関数、gsi：座標から都道府県を引く関数
export async function fetchWikiList(list, { cacheDir, refresh, sparql, gsiPref }) {
  const w = list.wiki;
  const textFile = path.join(cacheDir, `wl-${list.key}-text.json`);
  const text = await cached(textFile, refresh, async () => {
    const u = new URL('https://ja.wikipedia.org/w/api.php');
    for (const [k, v] of Object.entries({ action: 'parse', prop: 'wikitext', format: 'json', page: w.page, redirects: '1' })) u.searchParams.set(k, v);
    return (await getJson(u.toString())).parse.wikitext['*'];
  });
  const rows = w.format ? parseBulletRows(text, w.format) : parseWikiRows(text, w.lo, w.hi, { nameCol: w.nameCol });
  const titles = [...new Set(rows.map((r) => r.title).filter(Boolean))];
  const qidOf = await titlesToQids(titles, path.join(cacheDir, `wl-${list.key}-qids.json`), refresh);
  const qids = [...new Set(Object.values(qidOf))];
  const coords = await qidsToCoords(qids, path.join(cacheDir, `wl-${list.key}-coords.json`), refresh, sparql);
  const gsiFile = path.join(cacheDir, `wl-${list.key}-gsi.json`);
  const gsi = existsSync(gsiFile) ? JSON.parse(await readFile(gsiFile, 'utf8')) : {};
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    let id = r.title && qidOf[r.title] ? qidOf[r.title] : `${list.key}_${r.no}`;
    if (seen.has(id)) id = `${id}_${r.no}`; // 同じ記事の項目が2つ（同じ川の別の湧水など）
    seen.add(id);
    const q = /^Q\d+/.exec(id) ? id.match(/^Q\d+/)[0] : null;
    // 記事の座標が無い（または景観のように範囲が広い）ものは、所在地（市町村）の中心の座標（国土地理院の住所検索）
    let c = q && !w.areaOnly ? coords[q] : null;
    if (!c && r.muni) c = await gsiAddress(`${/[都道府県]/.test(r.muni.slice(0, 5)) ? '' : r.pref || ''}${r.muni.replace(/\s+/g, '')}`, gsi);
    let pref = '';
    if (c && gsiPref) pref = await gsiPref(id, c.lat, c.lng);
    out.push({ id, name: r.label, lat: c ? c.lat : null, lng: c ? c.lng : null, pref, country: '日本' });
  }
  await writeFile(gsiFile, JSON.stringify(gsi));
  return out;
}
