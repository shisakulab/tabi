# data/

`node tools/build-spots.mjs` で作ります（手で編集しない）。

- `spots/<0.5度区画>.json`：地点。`[id, kind, name, lat, lng, tier, radius, lists, pref]`。id は Wikidata の QID、tier は list（一覧に入っている場所）／near（近所の場所。OSM）、id は Wikidata の QID か OSM の要素（n/w/r＋番号）、radius は判子を押せる半径（m）、pref は Wikidata の P131 をたどった都道府県（取れなければ国土地理院の逆ジオコーダで座標から補う。それでも取れなければ空）
- `spots/meta.json`：作った日時と件数
- `lists.json`：一覧の定義。items は `[id, 名前, 都道府県, 座標あり(1/0)]`。座標のないものも一覧には載り、地図には出ない。aliases は国宝（kokuho）を場所ごとにまとめたことで変わった spotId（子 id → 親 id）
- `seasons-coords.json`：季節の名所（`themes/seasons.js`）の座標。名前で Wikidata を検索し、都道府県が合う候補だけを採用（合わなければ入れない）
- `climate.json`：`node tools/build-climate.mjs` で作ります（手で編集しない）。世界遺産の座標を1度格子にまとめ、格子ごとに `{ best: [ベストの月...], t: [12か月の最高気温の平均(℃)], r: [12か月の降水量の平均(mm)] }`。`spots` は世界遺産の id → 格子キーの対応

一覧（Wikidata）：世界遺産（日本。P757 かつ P17=Q17、radius 500）、重伝建（P1435=Q850649、radius 300）、日本100名城（P361=Q1139439、radius 300）、続日本100名城（P361=Q30927700、radius 300）、名水百選（昭和）・平成の名水百選・続日本100名城・日本の滝百選は、Wikidata の「〜の一部」では取りこぼす（続100名城71・滝59）ので、日本語版 Wikipedia の一覧の表（番号つき）から項目の順と名前を取り、記事 → Wikidata の項目 → 座標（P625）を引く（tools/wiki-list.mjs。記事のない平成の名水は位置なし）

近所の場所（OSM。Overpass は混んで取れないことが多いので、`tools/osm-extract.py` で Geofabrik の地方ごとのファイルから tools/.cache に作ってから build する。`--no-osm` を付けると入れずに作る）：神社・お寺（amenity=place_of_worship＋religion=shinto/buddhist）、温泉（natural=hot_spring、または amenity=public_bath で bath:type=onsen か名前に「温泉」）、銭湯（それ以外の amenity=public_bath。足湯・私有は除く）、灯台（man_made=lighthouse）、博物館・記念館（tourism=museum）、名所（tourism=attraction、または historic=castle/ruins/monument。historic=memorial は小さな碑が多すぎるので除く）、展望（tourism=viewpoint）、パン屋（shop=bakery）、喫茶店（amenity=cafe。brand・brand:wikidata タグのあるチェーン店は除く）、定食屋（amenity=restaurant/fast_food のうち、名前に「食堂」「定食」などを含むか cuisine に teishoku/set_meal を含むもの。brand・brand:wikidata タグのあるもの、チェーン店名、社員食堂・学食などの名前、支店名だけのものは除く）。node・way だけでなく relation（境内などの複数の囲み）も、メンバー way の点の範囲の中心で入れる。名前のないものは入れない

## 出典
場所のデータは [Wikidata](https://www.wikidata.org/)（CC0）と [OpenStreetMap](https://www.openstreetmap.org/copyright)（© OpenStreetMap contributors、ODbL）。地図は国土地理院。 帳面の国の地図の国境は [Natural Earth](https://www.naturalearthdata.com/)（パブリックドメイン）の 1:1億（`countries.geojson`。形のない小さな国は点）。世界遺産のベストシーズン（`climate.json`）の気候データは [NASA POWER](https://power.larc.nasa.gov/)。

- `foods.json`：ご当地グルメの図鑑。`node tools/build-foods.mjs` で作ります（手で編集しない）。`{ key, name, pref, url, summary, months?, main }` の配列。元データは農林水産省「[うちの郷土料理](https://www.maff.go.jp/j/keikaku/syokubunka/k_ryouri/)」（[政府標準利用規約・PDL1.0](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)）。summary は料理ページの説明を要約。main は都道府県ごとに2〜3品、全国的に名が通っていて旅先で食べられるものを手で選んだもの

- `festivals.json`：祭り。`node tools/build-festivals.mjs` で作ります（手で編集しない）。`items` は `[id, 名前, 緯度, 経度, 開催月[], 国, 都道府県, flags[], 原語名]`。元データは [Wikidata](https://www.wikidata.org/)（CC0）の祭り（P31/P279* Q132241）。日本は P17=Q17（座標は P625 → 会場 P276 → P361 → P131 の順）、開催月は P837（定期的に起こる日）から。世界は日本以外で座標 P625 と P837 があるもの。ユネスコ「山・鉾・屋台行事」33件（flags に `yama`）と日本三大祭（`sandai`）は `tools/festival-extra.mjs` の値（出所はそのコメント）で上書き。開催月がある祭りは季節の名所と同じ仕組み（その月に押すと季節の判子）、月がない祭りは普通の場所
- `names-en.json`：日本語にした海外の場所の名前の、元の名前（id → 元の名前）。カードに小さく併記し、検索でも使う。`node tools/build-names-ja.mjs` で作ります。日本語名は、Wikidata の日本語ラベル → 日本語版 Wikipedia の題 → 日本語の別名 → `claude -p` での翻訳（固有名詞はカタカナ、一般名詞は訳す。Claude のサブスクの範囲）の順。訳は `tools/names-ja.json` に残し、作り直しで毎回は訳さない。場所の説明文（`photos/`）の英語も同じ要領で日本語にしてある

海外の近所の場所（OSM。`node tools/build-world-near.mjs --fetch` で Overpass から海外100都市（`tools/world-cities.mjs`。各国の首都と世界遺産のある観光都市、中心から半径5km）を都市ごとに tools/.cache に取り、`node tools/build-world-near.mjs` で `spots/` に tier=near で入れる。日本の分や世界遺産などは触らず、海外の近所の場所だけを毎回入れ替える）：教会・モスク・シナゴーグ・ヒンドゥー寺院・お寺（amenity=place_of_worship で wikidata か heritage があるもの。宗教は christian/muslim/jewish/hindu/buddhist・taoist）、博物館・美術館（tourism=museum、tourism=gallery は wikidata があるもの）、展望（tourism=viewpoint）、名所（tourism=attraction で wikidata あり）、パン屋、喫茶店（brand・brand:wikidata のあるチェーンとチェーン名は除く）。数が多すぎないよう都市ごとに種類別の上限（教会100・モスク60・博物館80・名所120・喫茶店60・パン屋40 など。wikidata・heritage があるもの、中心に近いものを優先）。名前は OSM の name:ja → 日本語に訳した名前（`tools/names-ja.json`）→ 元の name。訳した名前の元の名前は行の11番目（orig）に残す。行は `[id, kind, name, lat, lng, tier, radius, lists, pref, country, orig?]`

- `damcard.json`：ダムカードの配布場所（id → 配布場所の一覧）。一覧「ダムカード」は、国土交通省「[ダムカード](https://www.mlit.go.jp/river/kankyo/campaign/shunnkan/damcard.html)」配布ダム一覧（令和8年1月16日現在。政府標準利用規約 PDL1.0 に準拠、加工して作成）のダム名・都道府県を、Wikidata（CC0）のダム（Q12323 とその下位、P17=Q17、P625 あり）のラベル・別名と合わせて座標を付けたもの（`tools/dam-card.mjs`）。合わなかったダムは一覧には載せ、地図には出さない。カードの画像は使わない。マンホールカードは配布場所の一覧を入れない（GKP の利用条件）。印の種類にだけ「マンホールカード」を足して、写真で記録できる
