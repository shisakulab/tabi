"""Geofabrik の日本の OSM ファイル（.osm.pbf）から、近所の場所（温泉・銭湯・神社・お寺・灯台・博物館・名所・展望・パン屋・喫茶店）を
都道府県ごとに抜き出す。Overpass が混んで取れないときの代わり。出力は Overpass と同じ形で
tools/.cache/osm-JP-XX-{shinto,buddhist,bath,museum,sight,viewpoint,bakery,cafe}.json に書くので、
そのあと node tools/build-spots.mjs を走らせればキャッシュとして使われる。

使い方:
  python tools/osm-extract.py part <japan.geojson> <地方.osm.pbf> <名前>   … tools/.cache/osm-part-<名前>.json に書く
  python tools/osm-extract.py merge                                       … 全部の part をまとめて osm-JP-XX-*.json に書く
  .osm.pbf: Geofabrik の地方ごとのファイル（https://download.geofabrik.de/asia/japan/ の hokkaido, tohoku, kanto, chubu, kansai,
    chugoku, shikoku, kyushu）。日本全体（2.5GB）を一度に処理するとメモリが足りない。パスに日本語を含むと osmium が開けないので英字だけの場所に置く
  japan.geojson: https://github.com/dataofjapan/land の都道府県界（出典：地球地図日本）。都道府県を決めるのにだけ使い、配らない
  必要: pip install osmium shapely
境界の外（海の上の灯台など）は 20km 以内でいちばん近い県にする。
node・way だけでなく relation（複数の囲みでできた境内など）も入れる。relation は名前のついたメンバー way すべての点の
範囲（bbox）の中心を使う（node・way の中心と同じ考え方。osmium の area 組み立てまではしない）。
点の位置をすべてメモリに載せると足りないので、①名前つきの場所（点・線・relation）を集める ②relation が使う way の
メンバー node id を集める ③線・relation に使う点だけ位置を読む、の3回読む。
"""
import json, pathlib, sys
import osmium
import shapely
import shapely.geometry
from shapely.strtree import STRtree

CACHE = pathlib.Path(__file__).parent / ".cache"
KEEP = ("name", "name:ja", "amenity", "religion", "natural", "man_made", "bath:type", "access",
        "tourism", "historic", "shop", "brand", "brand:wikidata")
GROUPS = ("shinto", "buddhist", "bath", "museum", "sight", "viewpoint", "bakery", "cafe")


def load_prefs(geojson):
    j = json.loads(pathlib.Path(geojson).read_text(encoding="utf-8"))
    return [(f"JP-{int(f['properties']['id']):02d}", shapely.geometry.shape(f["geometry"])) for f in j["features"]]


# 種類を決める。チェーン店の除外や historic=memorial を入れるかどうかなど、細かい絞り込みは
# build-spots.mjs の nearKind() 側でタグを見て決める（ここでは広めに拾う）
def group_of(t):
    if not t.get("name"):
        return None
    if t.get("amenity") == "place_of_worship":
        return {"shinto": "shinto", "buddhist": "buddhist"}.get(t.get("religion"))
    if t.get("amenity") == "public_bath" or t.get("natural") == "hot_spring" or t.get("man_made") == "lighthouse":
        return "bath"
    if t.get("tourism") == "museum":
        return "museum"
    if t.get("tourism") == "attraction" or t.get("historic") in ("castle", "ruins", "monument", "memorial"):
        return "sight"
    if t.get("tourism") == "viewpoint":
        return "viewpoint"
    if t.get("shop") == "bakery":
        return "bakery"
    if t.get("amenity") == "cafe":
        return "cafe"
    return None


def part(geojson, pbf, name):
    prefs = load_prefs(geojson)
    print("都道府県の境界", len(prefs), "/ 47")
    tree = STRtree([g for _, g in prefs])
    # ① 名前つきの場所（node・way・relation）を集める。way・relation はあとで使う id を覚えておく
    found = []  # (node, id, tags, group, lat, lon) / (way, id, tags, group, node_ids) / (rel, id, tags, group, way_ids)
    way_need = set()  # relation のメンバーで、node の位置を知るために読む必要がある way の id
    fp = osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY | osmium.osm.RELATION) \
        .with_filter(osmium.filter.KeyFilter("amenity", "natural", "man_made", "tourism", "historic", "shop"))
    for o in fp:
        t = {k: v for k, v in o.tags if k in KEEP}
        g = group_of(t)
        if not g:
            continue
        if o.is_node():
            found.append(("node", o.id, t, g, o.location.lat, o.location.lon))
        elif o.is_way():
            ids = [nd.ref for nd in o.nodes]
            found.append(("way", o.id, t, g, ids))
        else:
            wids = [m.ref for m in o.members if m.type == "w"]
            if not wids:
                continue
            way_need.update(wids)
            found.append(("rel", o.id, t, g, wids))
    print("場所", len(found), "件、relation が使う way", len(way_need))
    # ② relation のメンバー way のノード id を集める
    way_nodes = {}
    if way_need:
        for o in osmium.FileProcessor(pbf, osmium.osm.WAY).with_filter(osmium.filter.IdFilter(way_need)):
            way_nodes[o.id] = [nd.ref for nd in o.nodes]
    # ③ 線・relation に使う点の位置だけ読む
    need = set()
    for f in found:
        if f[0] == "way":
            need.update(f[4])
        elif f[0] == "rel":
            for wid in f[4]:
                need.update(way_nodes.get(wid, []))
    loc = {}
    for o in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(need)):
        loc[o.id] = (o.location.lat, o.location.lon)
    out = []
    n = 0
    for f in found:
        if f[0] == "node":
            typ, oid, t, g, lat, lon = f
        elif f[0] == "way":
            typ, oid, t, g, ids = f
            pts = [loc[i] for i in ids if i in loc]
            if not pts:
                continue
            lat = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
            lon = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
        else:
            typ, oid, t, g, wids = f
            pts = [loc[i] for wid in wids for i in way_nodes.get(wid, []) if i in loc]
            if not pts:
                continue
            lat = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
            lon = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
        pt = shapely.Point(lon, lat)
        hit = [i for i in tree.query(pt) if prefs[i][1].contains(pt)]
        if hit:
            iso = prefs[hit[0]][0]
        else:
            i = tree.nearest(pt)
            if prefs[i][1].distance(pt) > 0.2:  # 約20km
                continue
            iso = prefs[i][0]
        el = {"type": "relation" if typ == "rel" else typ, "id": oid, "tags": t}
        if typ == "node":
            el["lat"], el["lon"] = round(lat, 7), round(lon, 7)
        else:
            el["center"] = {"lat": round(lat, 7), "lon": round(lon, 7)}
        out.append([f"osm-{iso}-{g}", el])
        n += 1
    CACHE.mkdir(exist_ok=True)
    (CACHE / f"osm-part-{name}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(name, "書き出し", n, "件")


def merge():
    out, seen = {}, set()
    for f in sorted(CACHE.glob("osm-part-*.json")):
        for key, el in json.loads(f.read_text(encoding="utf-8")):
            k = (el["type"], el["id"])  # 地方のファイルは境目で重なるので1つに
            if k in seen:
                continue
            seen.add(k)
            out.setdefault(key, []).append(el)
    for i in range(1, 48):
        for g in GROUPS:
            key = f"osm-JP-{i:02d}-{g}"
            (CACHE / f"{key}.json").write_text(json.dumps(out.get(key, []), ensure_ascii=False), encoding="utf-8")
    print("まとめ", len(seen), "件")


if __name__ == "__main__":
    if sys.argv[1] == "part":
        part(*sys.argv[2:5])
    else:
        merge()
