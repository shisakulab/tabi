# data/

`node tools/build-spots.mjs` で作ります（手で編集しない）。

- `spots/<0.5度区画>.json`：地点。`[id, kind, name, lat, lng, tier, radius, lists, pref]`。id は Wikidata の QID、tier は list（一覧に入っている場所）／near（近所の場所。OSM）、id は Wikidata の QID か OSM の要素（n/w/r＋番号）、radius は判子を押せる半径（m）、pref は Wikidata の P131 をたどった都道府県（取れなければ国土地理院の逆ジオコーダで座標から補う。それでも取れなければ空）
- `spots/meta.json`：作った日時と件数
- `lists.json`：一覧の定義。items は `[id, 名前, 都道府県, 座標あり(1/0)]`。座標のないものも一覧には載り、地図には出ない。aliases は国宝（kokuho）を場所ごとにまとめたことで変わった spotId（子 id → 親 id）
- `seasons-coords.json`：季節の名所（`themes/seasons.js`）の座標。名前で Wikidata を検索し、都道府県が合う候補だけを採用（合わなければ入れない）
- `climate.json`：`node tools/build-climate.mjs` で作ります（手で編集しない）。世界遺産の座標を1度格子にまとめ、格子ごとに `{ best: [ベストの月...], t: [12か月の最高気温の平均(℃)], r: [12か月の降水量の平均(mm)] }`。`spots` は世界遺産の id → 格子キーの対応

一覧（Wikidata）：世界遺産（日本。P757 かつ P17=Q17、radius 500）、重伝建（P1435=Q850649、radius 300）、日本100名城（P361=Q1139439、radius 300）、続日本100名城（P361=Q30927700、radius 300）、名水百選（P361=Q10917783、radius 50）、日本の滝百選（P361=Q40172600、radius 150）

近所の場所（OSM。Overpass は混んで取れないことが多いので、`tools/osm-extract.py` で Geofabrik の地方ごとのファイルから tools/.cache に作ってから build する。`--no-osm` を付けると入れずに作る）：神社・お寺（amenity=place_of_worship＋religion=shinto/buddhist）、温泉（natural=hot_spring、または amenity=public_bath で bath:type=onsen か名前に「温泉」）、銭湯（それ以外の amenity=public_bath。足湯・私有は除く）、灯台（man_made=lighthouse）、博物館・記念館（tourism=museum）、名所（tourism=attraction、または historic=castle/ruins/monument。historic=memorial は小さな碑が多すぎるので除く）、展望（tourism=viewpoint）、パン屋（shop=bakery）、喫茶店（amenity=cafe。brand・brand:wikidata タグのあるチェーン店は除く）、定食屋（amenity=restaurant/fast_food のうち、名前に「食堂」「定食」などを含むか cuisine に teishoku/set_meal を含むもの。brand・brand:wikidata タグのあるもの、チェーン店名、社員食堂・学食などの名前、支店名だけのものは除く）。node・way だけでなく relation（境内などの複数の囲み）も、メンバー way の点の範囲の中心で入れる。名前のないものは入れない

## 出典
場所のデータは [Wikidata](https://www.wikidata.org/)（CC0）と [OpenStreetMap](https://www.openstreetmap.org/copyright)（© OpenStreetMap contributors、ODbL）。地図は国土地理院。 帳面の国の地図の国境は [Natural Earth](https://www.naturalearthdata.com/)（パブリックドメイン）の 1:1億（`countries.geojson`。形のない小さな国は点）。世界遺産のベストシーズン（`climate.json`）の気候データは [NASA POWER](https://power.larc.nasa.gov/)。

- `foods.json`：ご当地グルメの図鑑。`node tools/build-foods.mjs` で作ります（手で編集しない）。`{ key, name, pref, url, summary, months?, main }` の配列。元データは農林水産省「[うちの郷土料理](https://www.maff.go.jp/j/keikaku/syokubunka/k_ryouri/)」（[政府標準利用規約・PDL1.0](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)）。summary は料理ページの説明を要約。main は都道府県ごとに2〜3品、全国的に名が通っていて旅先で食べられるものを手で選んだもの
