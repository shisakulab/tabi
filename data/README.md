# data/

`node tools/build-spots.mjs` で作ります（手で編集しない）。

- `spots/<0.5度区画>.json`：地点。`[id, kind, name, lat, lng, tier, radius, lists, pref]`。id は Wikidata の QID、tier は far（遠征級）／day（日帰り級）／town（街歩き級）、radius は判子を押せる半径（m）、pref は Wikidata の P131 をたどった都道府県（取れなければ空）
- `spots/meta.json`：作った日時と件数
- `lists.json`：一覧の定義。items は `[id, 名前, 都道府県, 座標あり(1/0)]`。座標のないものも一覧には載り、地図には出ない
- `seasons-coords.json`：季節の名所（`themes/seasons.js`）の座標。名前で Wikidata を検索し、都道府県が合う候補だけを採用（合わなければ入れない）

一覧：世界遺産（日本。P757 かつ P17=Q17、radius 500、遠征級）、名水百選（P361=Q10917783、radius 50、日帰り級）、重伝建（P1435=Q850649、radius 300、遠征級）

## 出典
場所のデータは [Wikidata](https://www.wikidata.org/)（CC0）。地図は国土地理院。
