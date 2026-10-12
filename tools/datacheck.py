"""候補テーマの地点データが Wikidata / OSM からどれだけ取れるかを数える。
使い方: python datacheck.py [wd|osm|all]   結果は tools/out/ に JSON 保存。"""
import json, sys, time, pathlib, requests

OUT = pathlib.Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)
UA = {"User-Agent": "tabi-datacheck/0.1 (personal project)"}
WD = "https://query.wikidata.org/sparql"
OP = "https://overpass-api.de/api/interpreter"

# (キー, 表示名, 公式件数, 絞り込みの SPARQL 断片, 説明)  ?s が対象
def via(prop, qid):
    return "?s wdt:%s wd:%s ." % (prop, qid)

WD_LISTS = [
    ("heritage", "世界遺産(P757あり)", 26, "?s wdt:P757 [] .", "P757 あり(日本は P17=Q17。公式は日本の登録数=26 件)"),
    ("judenken", "重伝建", 130, via("P1435", "Q850649"), "P1435=Q850649"),
    ("meisui", "名水百選", 100, via("P361", "Q10917783"), "P361=Q10917783"),
    ("heisei", "平成の名水百選", 100, via("P361", "Q11482873"), "P361=Q11482873"),
    ("tanada100", "日本の棚田百選", 134, via("P361", "Q85719567"), "P361=Q85719567"),
    ("tsunagu", "つなぐ棚田遺産", 271, via("P361", "Q141434714"), "P361=Q141434714"),
    ("nihonisan", "日本遺産(ストーリー)", 104, via("P1435", "Q18382798"), "P1435=Q18382798"),
    ("taki100", "日本の滝百選", 100, via("P361", "Q40172600"), "P361=Q40172600"),
    ("meijo100", "日本100名城", 100, via("P361", "Q1139439"), "P361=Q1139439"),
    ("zokumeijo", "続日本100名城", 100, via("P361", "Q30927700"), "P361=Q30927700"),
]

def sparql(q):
    for i in range(5):
        r = requests.post(WD, data={"query": q}, headers={**UA, "Accept": "application/sparql-results+json"}, timeout=120)
        if r.status_code == 200:
            return r.json()["results"]["bindings"]
        time.sleep(8 * (i + 1))
    raise RuntimeError("sparql %s" % r.status_code)

def wikidata():
    res = {}
    for key, name, official, cond, note in WD_LISTS:
        # 日本限定(P17=Q17)と、国を問わない全体の両方を数える
        q = """SELECT (COUNT(DISTINCT ?s) AS ?all) (COUNT(DISTINCT ?jp) AS ?jp)
        (COUNT(DISTINCT ?jpc) AS ?jpcoord) (COUNT(DISTINCT ?jpl) AS ?jplabel) (COUNT(DISTINCT ?c) AS ?allcoord) (COUNT(DISTINCT ?l) AS ?alllabel) WHERE {
          %s
          OPTIONAL { ?s wdt:P625 ?cx . BIND(?s AS ?c) }
          OPTIONAL { ?s rdfs:label ?lx . FILTER(LANG(?lx)="ja") BIND(?s AS ?l) }
          OPTIONAL { ?s wdt:P17 wd:Q17 . BIND(?s AS ?jp)
            OPTIONAL { ?s wdt:P625 ?cc . BIND(?s AS ?jpc) }
            OPTIONAL { ?s rdfs:label ?ll . FILTER(LANG(?ll)="ja") BIND(?s AS ?jpl) } }
        }""" % cond
        b = sparql(q)[0]
        res[key] = {"name": name, "official": official, "note": note, **{k: int(v["value"]) for k, v in b.items()}}
        print(key, res[key], flush=True)
        time.sleep(3)
    # 世界遺産の全世界件数
    b = sparql("SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s wdt:P757 [] }")
    res["heritage"]["world"] = int(b[0]["n"]["value"])
    (OUT / "wikidata_counts.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res

# Overpass: (キー, 表示名, タグ条件)
AREA = 'area["ISO3166-1"="JP"]->.a;'
OSM_SETS = [
    ("onsen_bath", "温泉(public_bath+onsen)", '["amenity"="public_bath"]["bath:type"="onsen"]'),
    ("hot_spring", "温泉(natural=hot_spring)", '["natural"="hot_spring"]'),
    ("lighthouse", "灯台", '["man_made"="lighthouse"]'),
    ("waterfall", "滝", '["natural"="waterfall"]'),
    ("shinto", "神社", '["amenity"="place_of_worship"]["religion"="shinto"]'),
    ("buddhist", "寺", '["amenity"="place_of_worship"]["religion"="buddhist"]'),
]

def overpass(body):
    q = "[out:json][timeout:600];%s%s" % (AREA, body)
    for i in range(4):
        r = requests.post(OP, data={"data": q}, headers=UA, timeout=700)
        if r.status_code == 200:
            return r.json()["elements"][0]["tags"]
        time.sleep(15 * (i + 1))
    raise RuntimeError("overpass %s" % r.status_code)

def osm():
    res = {}
    for key, name, tags in OSM_SETS:
        row = {"name": name, "tags": tags}
        for sub, extra in [("total", ""), ("named", '["name"]'), ("name_ja", '["name:ja"]')]:
            try:
                t = overpass("nwr%s%s(area.a);out count;" % (tags, extra))
                row[sub] = int(t["total"])
            except Exception as e:
                row[sub] = None
                row["err_" + sub] = str(e)
            time.sleep(6)
        res[key] = row
        print(key, row, flush=True)
    (OUT / "osm_counts.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res

def osm_pref(codes=("JP-13", "JP-22")):
    """日本全体が 504 で通らないため、都県単位(ISO3166-2)で数える。"""
    global AREA
    res = {}
    for code in codes:
        AREA = 'area["ISO3166-2"="%s"]->.a;' % code
        for key, name, tags in OSM_SETS:
            row = {"name": name, "tags": tags}
            for sub, extra in [("total", ""), ("named", '["name"]'), ("name_ja", '["name:ja"]')]:
                try:
                    row[sub] = int(overpass("nwr%s%s(area.a);out count;" % (tags, extra))["total"])
                except Exception as e:
                    row[sub] = None; row["err_" + sub] = str(e)
                time.sleep(5)
            res[code + ":" + key] = row
            print(code, key, row, flush=True)
    (OUT / "osm_pref_counts.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")

if __name__ == "__main__":
    if sys.argv[1:2] == ["osmpref"]:
        osm_pref(); sys.exit()
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("wd", "all"): wikidata()
    if what in ("osm", "all"): osm()
