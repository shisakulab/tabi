"""XLSX の1枚目のシートを行（列の記号 → 文字列）の JSON にして標準出力へ出す（tools/dam-card.mjs 用。標準ライブラリだけ）。
使い方: python -I tools/read-xlsx.py <file.xlsx>
ふりがな（<rPh>）は外す。"""
import json
import re
import sys
import zipfile

z = zipfile.ZipFile(sys.argv[1])
ss = []
for si in re.findall(r'<si>(.*?)</si>', z.read('xl/sharedStrings.xml').decode('utf8'), re.S):
    si = re.sub(r'<rPh[^>]*>.*?</rPh>', '', si, flags=re.S)
    t = ''.join(re.findall(r'<t[^>]*>(.*?)</t>', si, re.S))
    ss.append(t.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'"))
sheet = z.read('xl/worksheets/sheet1.xml').decode('utf8')
rows = []
for r in re.findall(r'<row [^>]*>(.*?)</row>', sheet, re.S):
    cells = {}
    for m in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', r, re.S):
        col, attrs, body = m.group(1), m.group(2), m.group(3) or ''
        v = re.search(r'<v>(.*?)</v>', body, re.S)
        if not v:
            continue
        val = v.group(1)
        if 't="s"' in attrs:
            val = ss[int(val)]
        cells[col] = val
    rows.append(cells)
sys.stdout.buffer.write(json.dumps(rows, ensure_ascii=False).encode('utf8'))
