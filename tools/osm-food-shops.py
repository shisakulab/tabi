"""Geofabrik の地方ごとの .osm.pbf から、飲食店（amenity=restaurant/fast_food/cafe/food_court/ice_cream/pub、
shop=confectionery/bakery/pastry/deli/seafood ほか）を、名前（name・name:ja・alt_name など）と cuisine つきで都道府県ごとに抜き出す。
ご当地グルメのお店の紐づけ（tools/build-food-shops.mjs）の材料。osm-extract.py と同じ3回読み（node・way の位置はあとで読む）。
relation は入れない。

使い方（パスに日本語を含むと osmium が開けないので英字だけの場所で。日本全体を一度に処理するとメモリが足りないので地方ごと）:
  python tools/osm-food-shops.py <japan.geojson> <地方.osm.pbf> <出力.json>
  japan.geojson: https://github.com/dataofjapan/land の都道府県界（出典：地球地図日本）。県を決めるのにだけ使う
  必要: pip install osmium shapely
出力は [[県コード(1〜47), id("n123"/"w123"), 名前, 別名の配列, cuisine, 種類, lat, lon], ...]。
境界の外は20km以内でいちばん近い県にする。
"""
import json, pathlib, sys
import osmium
import shapely
import shapely.geometry
from shapely.strtree import STRtree

AMENITY = {"restaurant", "fast_food", "cafe", "food_court", "ice_cream", "pub", "bar"}
SHOP = {"confectionery", "bakery", "pastry", "deli", "seafood", "butcher", "farm", "tea", "coffee"}
NAMEKEYS = ("name:ja", "name:ja-Hira", "name:ja_kana", "alt_name", "official_name", "old_name", "short_name", "brand", "brand:ja")


def kind_of(t):
    if not t.get("name"):
        return None
    if t.get("amenity") in AMENITY:
        return t["amenity"]
    if t.get("shop") in SHOP:
        return "shop:" + t["shop"]
    return None


def main(geojson, pbf, out):
    j = json.loads(pathlib.Path(geojson).read_text(encoding="utf-8"))
    codes = [int(f["properties"]["id"]) for f in j["features"]]
    geoms = [shapely.geometry.shape(f["geometry"]) for f in j["features"]]
    tree = STRtree(geoms)
    found = []  # [id, name, alts, cuisine, kind, lat, lon]
    ways = []
    fp = osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_filter(osmium.filter.KeyFilter("amenity", "shop"))
    for o in fp:
        tg = {k: v for k, v in o.tags}
        k = kind_of(tg)
        if not k:
            continue
        alts = []
        for key in NAMEKEYS:
            v = tg.get(key)
            if v:
                alts += [x.strip() for x in v.split(";") if x.strip()]
        rec = [tg["name"], sorted(set(a for a in alts if a != tg["name"])), tg.get("cuisine", ""), k]
        if o.is_node():
            found.append([f"n{o.id}", *rec, o.location.lat, o.location.lon])
        else:
            ways.append((f"w{o.id}", rec, [nd.ref for nd in o.nodes]))
    print("node", len(found), "way", len(ways))
    need = set(i for _, _, ids in ways for i in ids)
    loc = {}
    for o in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(need)):
        loc[o.id] = (o.location.lat, o.location.lon)
    for wid, rec, ids in ways:
        pts = [loc[i] for i in ids if i in loc]
        if pts:
            found.append([wid, *rec, (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2, (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2])
    pts = shapely.points([f[6] for f in found], [f[5] for f in found])  # x=lon, y=lat
    res = {}
    for pi, gi in zip(*tree.query(pts, predicate="intersects")):
        res.setdefault(int(pi), int(gi))
    rows = []
    for i, f in enumerate(found):
        if i in res:
            c = codes[res[i]]
        else:
            g = int(tree.nearest(pts[i]))
            if geoms[g].distance(pts[i]) > 0.2:
                continue
            c = codes[g]
        rows.append([c, f[0], f[1], f[2], f[3], f[4], round(f[5], 6), round(f[6], 6)])
    pathlib.Path(out).write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("書き出し", len(rows))


if __name__ == "__main__":
    main(*sys.argv[1:4])
