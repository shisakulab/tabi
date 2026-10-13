// 農林水産省「うちの郷土料理」から、ご当地グルメの図鑑データを作る
//   node tools/build-foods.mjs            キャッシュがあれば再利用する
//   node tools/build-foods.mjs --refresh  問い合わせ直す
// 元データ：https://www.maff.go.jp/j/keikaku/syokubunka/k_ryouri/
// 利用規約：https://www.maff.go.jp/j/use/link.html（政府標準利用規約・PDL1.0。出典表示と、要約した旨の記載が必要）
//   → アプリ側（app.js の「その他」タブ・料理のシート）に出典と「一部を要約」の旨を出す。このファイルには出典の文言は含めない
// 出力：data/foods.json（{ key, name, pref, url, summary, months?, main } の配列。全国の郷土料理 約1300品のうち、
//   旅先で食べられる有名なもの2〜3品／都道府県を main: true にする）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'tools', '.cache', 'foods');
const OUT = path.join(root, 'data', 'foods.json');
const BASE = 'https://www.maff.go.jp/j/keikaku/syokubunka/k_ryouri/search_menu/';
const HEADERS = { 'User-Agent': 'tabigoyomi-build-foods/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)' };
const refresh = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCached(url, name) {
  const file = path.join(CACHE, name);
  if (!refresh && existsSync(file)) return readFile(file, 'utf8');
  await sleep(1000); // アクセスは1秒に1回程度
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const text = await res.text();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, text);
  return text;
}

// 料理の一覧（shared/js/search_menu.js に全国 約1300品が1つにまとまっている。検索機能のためのデータ）
async function loadList() {
  const text = await fetchCached(`${BASE}shared/js/search_menu.js`, '_search_menu.js');
  const re = /\{\s*"href"\s*:\s*"([^"]+)"\s*,\s*"src"\s*:\s*"([^"]*)"\s*,\s*"alt"\s*:\s*"([^"]*)"\s*,\s*"tit"\s*:\s*"([^"]*)"\s*,\s*"txt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"season"\s*:\s*"([^"]*)"\s*,\s*"type"\s*:\s*"([^"]*)"\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const [, href, , alt, tit] = m;
    const pref = tit.split(' / ').pop();
    const key = href.replace(/^menu\//, '').replace(/\.html$/, '');
    out.push({ key, name: alt, pref, href });
  }
  return out;
}

const decodeEntities = (s) => s
  .replace(/&ldquo;|&rdquo;/g, '「')
  .replace(/&lsquo;|&rsquo;/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/<br\s*\/?>/g, '');
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// 見出し（h3）の次にある最初の <p> の文章を取る
function sectionText(html, title) {
  const i = html.indexOf(`>${title}<`);
  if (i < 0) return null;
  const m = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html.slice(i, i + 4000));
  return m ? stripTags(m[1]) : null;
}

// 説明の冒頭を80字程度に（句読点で切れるところを優先する）
function truncate(s, max = 80) {
  const arr = [...s];
  if (arr.length <= max) return s;
  const head = arr.slice(0, max).join('');
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('、'));
  return (cut > max * 0.6 ? head.slice(0, cut + 1) : head) + '…';
}

// 「食習の機会や時季」にはっきり「◯月」と書いてあるときだけ月を拾う（季節・行事名からの推測はしない）
function extractMonths(text) {
  if (!text) return null;
  const months = [...new Set([...text.matchAll(/([0-9]{1,2})月/g)].map((x) => Number(x[1])))].filter((n) => n >= 1 && n <= 12);
  return months.length ? months.sort((a, b) => a - b) : null;
}

async function loadDetail(item) {
  const html = await fetchCached(`${BASE}${item.href}`, `${item.key}.html`);
  const history = sectionText(html, '歴史・由来・関連行事');
  const season = sectionText(html, '食習の機会や時季');
  return { summary: truncate(history || season || item.name), months: extractMonths(season) };
}

// 表の図鑑（main: true）。全国的に名が通っていて旅先で食べられるものを、都道府県ごとに2〜3品手で選ぶ
const MAIN_KEYS = new Set([
  'ishikarinabe_hokkaido', 'jingisukan_hokkaido', 'ikameshi_hokkaido',
  'ichigoni_aomori', 'senbei_jiru_aomori',
  '28_1_iwate', '28_3_iwate',
  'sendai_zouni_miyagi', 'zunda_mochi_miyagi', 'harako_meshi_miyagi',
  '29_6_akita', '29_1_akita',
  'imoni_yamagata', 'dashi_yamagata',
  '30_2_fukushima', '30_23_fukushima',
  'soboronatto_ibaraki', 'shimotukare_ibaraki',
  '31_1_tochigi', '31_2_tochigi',
  '32_1_gunma', '32_26_gunma',
  '33_3_saitama', '33_8_saitama',
  'futomaki_zushi_chiba', 'namerou_chiba',
  '34_1_tokyo', '34_3_tokyo',
  '35_3_kanagawa', '35_5_kanagawa',
  'noppe_niigata', 'hegisoba_niigata_niigata', 'sasa_zushi_niigata',
  '37_4_toyama', '37_20_toyama',
  'jibuni_ishikawa', 'kaburazushi_ishikawa',
  'heshiko_fukui', 'oroshi_soba_fukui',
  'houtou_yama_nashi', 'yoshida_no_udon_yama_nashi',
  'gohei_mochi_nagano', 'oyaki_nagano', 'teuchi_soba_nagano',
  '38_1_gifu', '38_8_gifu', '38_17_gifu',
  '36_16_shizuoka', '36_18_shizuoka',
  'misonikomiudon_aichi', 'kishimen_aichi',
  'iseudon_mie', 'tekone_zushi_mie',
  'funa_zushi_shiga', 'saba_soumen_shiga',
  'shiromisonozoni_kyoto', 'semmaizuke_kyoto', 'kamonasunodengaku_kyoto',
  '39_15_osaka', '39_20_osaka', '39_17_osaka',
  '40_3_hyogo', '40_2_hyogo', '40_14_hyogo',
  'kakinoha_zushi_nara', 'asuka_nabe_nara',
  'mehari_zushi_wakayama', 'umeboshi_wakayama',
  'daisen_okowa_tottori', 'toufu_chikuwa_tottori',
  'izumosoba_shimane', 'uzumemeshi_shimane',
  '41_27_okayama', '41_20_okayama',
  '42_7_hiroshima', '42_30_hiroshima',
  '43_16_yamaguchi', '43_30_yamaguchi',
  '44_5_tokushima', '44_2_tokushima',
  'sippoku_udon_kagawa', 'anmochi_zouni_kagawa',
  'taimeshi_ehime', 'jakoten_ehime',
  'katuonotataki_kochi', 'sawachiryori_kochi',
  'wakadori_no_mizutaki_fukuoka', 'hakata_zouni_fukuoka',
  '45_10_saga', '45_1_saga',
  '46_7_nagasaki', '46_8_nagasaki', '46_1_nagasaki',
  'basashi_kumamoto', 'karashi_renkon_kumamoto', 'taipiien_kumamoto',
  'toriten_oita', 'dangojiru_oita',
  'chikin_nanban_miyazaki', 'hiyajiru_miyazaki',
  'keihan_kagoshima', 'karukan_kagoshima', 'tonkotsu_kagoshima',
  '47_11_okinawa', '47_20_okinawa', '47_8_okinawa',
]);

async function main() {
  const list = await loadList();
  const out = [];
  for (const item of list) {
    const { summary, months } = await loadDetail(item);
    const food = { key: item.key, name: item.name, pref: item.pref, url: `${BASE}${item.href}`, summary, main: MAIN_KEYS.has(item.key) };
    if (months) food.months = months;
    out.push(food);
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  const mains = out.filter((f) => f.main);
  console.log(`foods.json: ${out.length}件（main: ${mains.length}件、months 判明: ${out.filter((f) => f.months).length}件）`);
  const missingMain = [...MAIN_KEYS].filter((k) => !out.some((f) => f.key === k));
  if (missingMain.length) console.log('見つからなかった main のキー:', missingMain);
}

main().catch((err) => { console.error(err); process.exit(1); });
