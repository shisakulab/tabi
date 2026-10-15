// 海外の場所の日本語名・英語の説明文の日本語訳（tools/names-ja.json）を読む。ビルドの各ツールが共有する（ネットワークは使わない）
//   names：{ <id>: [日本語名, 出どころ, 元の名前] }  出どころ：wiki（日本語版 Wikipedia の題）・alias（Wikidata の日本語の別名）・label（日本語ラベル）・ai（claude -p による翻訳）
//   desc ：{ <英語の説明文>: <日本語> }
//   wd   ：Wikidata で日本語名を探し終えた id（探し直さないため）
// 作り方は tools/build-names-ja.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const NAMES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'names-ja.json');
export const hasJa = (s) => /[ぁ-んァ-ン一-龥]/.test(s || '');
export function loadNamesJa() {
  try { const j = JSON.parse(readFileSync(NAMES_FILE, 'utf8')); return { names: j.names || {}, desc: j.desc || {}, wd: j.wd || [] }; } catch { return { names: {}, desc: {}, wd: [] }; }
}
// 名前が英語（元の名前）のままなら日本語名にする。すでに日本語なら変えない。{ name, orig }（orig は置き換えたときの元の名前、無ければ ''）
export function jaName(tables, id, name) {
  const e = tables.names[id];
  if (!e || hasJa(name) || !e[0] || e[2] !== name) return { name, orig: '' };
  return { name: e[0], orig: name };
}
export const jaDesc = (tables, desc) => (desc && !hasJa(desc) && tables.desc[desc]) || desc;
