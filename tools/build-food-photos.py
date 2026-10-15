# 農林水産省「うちの郷土料理」の写真を、図鑑に出す料理（foods.json の main）ぶんだけ取ってくる
#   python tools/build-food-photos.py
# 各料理ページの「関連画像」のうち、「『リンク・著作権について』に同意して画像をダウンロード」のボタン（ZIP）がある画像だけを使う
# （リンク・著作権について https://www.maff.go.jp/j/use/link.html は政府標準利用規約。出典表示が条件）。
# ZIP を取り、中の画像を幅 640px の JPEG にして data/foods/<key>.jpg に置く（ページから直リンクはしない）。
# ボタンのない画像（画像提供元の記載だけのもの）は取らない。ページに「画像提供元」の記載があれば data/food-photos.json に残す。
# 出力：data/food-photos.json { "<key>": { "file": "foods/<key>.jpg", "credit": "<画像提供元>" | "" } }
import html as htmllib, io, json, re, sys, time, zipfile
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FOODS = ROOT / 'data' / 'foods.json'
OUTDIR = ROOT / 'data' / 'foods'
OUT = ROOT / 'data' / 'food-photos.json'
CACHE = ROOT / 'tools' / '.cache' / 'food-pages'
UA = 'tabigoyomi-build-foods/1.0 (https://github.com/shisakulab/tabigoyomi; personal project)'
WIDTH = 640


def get(url):
    for i in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': UA}), timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa
            print('  失敗', url, e, file=sys.stderr)
            time.sleep(3 * (i + 1))
    return None


def page_html(food):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (food['key'] + '.html')
    if f.exists():
        return f.read_text('utf-8')
    b = get(food['url'])
    if b is None:
        return None
    f.write_bytes(b)
    time.sleep(1)
    return b.decode('utf-8', 'replace')


def clean_credit(s):
    s = htmllib.unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r'[\s  ]+', ' ', s).strip()
    return "" if s == "テキスト" else s  # 画像の提供元ではない記載は出さない


def first_downloadable(html, base):
    # 関連画像の <li> ごとに：ZIP のリンクがあるものの最初の1つ
    for li in re.findall(r'<li>\s*<div class="js_modal01">(.*?)</li>', html, re.S):
        z = re.search(r'<div class="dl_btn[^"]*"><a href="([^"]+\.zip)"', li)
        if not z:
            continue
        credit = re.search(r'<div class="dl_copy[^"]*">\s*画像提供元\s*[:：]\s*(.*?)\s*</div>', li, re.S)
        return urljoin(base, z.group(1)), clean_credit(credit.group(1)) if credit else ''
    return None, ''


def main():
    foods = [f for f in json.loads(FOODS.read_text('utf-8')) if f.get('main')]
    OUTDIR.mkdir(parents=True, exist_ok=True)
    result = {}
    missing = []
    for i, food in enumerate(foods):
        key = food['key']
        dest = OUTDIR / (key + '.jpg')
        html = page_html(food)
        if html is None:
            missing.append((key, 'ページを取れない'))
            continue
        zurl, credit = first_downloadable(html, food['url'])
        if not zurl:
            missing.append((key, 'ダウンロードできる画像がない'))
            continue
        if not dest.exists():
            b = get(zurl)
            if b is None:
                missing.append((key, 'ZIP を取れない'))
                continue
            time.sleep(1)
            try:
                with zipfile.ZipFile(io.BytesIO(b)) as z:
                    names = [n for n in z.namelist() if re.search(r'\.(jpe?g|png)$', n, re.I) and not n.startswith('__MACOSX')]
                    if not names:
                        missing.append((key, 'ZIP に画像がない'))
                        continue
                    im = Image.open(io.BytesIO(z.read(names[0]))).convert('RGB')
            except Exception as e:  # noqa
                missing.append((key, 'ZIP を開けない: %s' % e))
                continue
            if im.width > WIDTH:
                im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
            im.save(dest, 'JPEG', quality=76, optimize=True, progressive=True)
        result[key] = {'file': 'foods/%s.jpg' % key, 'credit': credit}
        if (i + 1) % 20 == 0:
            print('%d / %d' % (i + 1, len(foods)))
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    size = sum(p.stat().st_size for p in OUTDIR.glob('*.jpg'))
    print('写真あり %d / %d 品、容量 %.1f MB' % (len(result), len(foods), size / 1e6))
    for k, why in missing:
        print('  なし:', k, why)


main()
