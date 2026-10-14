// 写真から場所を推定する（位置情報が消えている写真用）。
// 自分の Claude API キーを設定に入れた人だけが使える。キーはこの端末の localStorage にだけ置き、
// 写真は推定するときだけ、縮めて Anthropic に直接送る（サーバーは通さない）。
// SDK は vendor/anthropic-sdk.mjs（@anthropic-ai/sdk 0.133.0 を esbuild で1ファイルにしたもの）を、使うときだけ読み込む

export const AI_IMAGE_MAX = 1024;

const SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: '場所を推定できたか（室内・料理・人物だけなど、手がかりがなければ false）' },
    place_name: { type: 'string', description: '推定した場所の名前（日本なら日本語の正式名。例：金閣寺、富士屋ホテル）。分からなければ空' },
    lat: { type: 'number', description: '推定した場所の緯度（分からなければ 0）' },
    lng: { type: 'number', description: '推定した場所の経度（分からなければ 0）' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high＝建物や看板で特定できた、medium＝かなり確か、low＝推測' },
    reason: { type: 'string', description: '手がかり（日本語で1文）' },
  },
  required: ['found', 'place_name', 'lat', 'lng', 'confidence', 'reason'],
  additionalProperties: false,
};

const PROMPT = 'この写真が撮られた場所を推定してください。建物・看板・景色・名物などの手がかりから、観光地・寺社・城・温泉・宿・名所などの具体的な場所の名前と座標を答えます。手がかりがなく特定できないときは found を false にしてください。当て推量で有名な場所の名前を出さないでください。';

let clientPromise = null; let clientKey = '';
async function clientFor(apiKey) {
  if (!clientPromise || clientKey !== apiKey) {
    clientKey = apiKey;
    clientPromise = import('./vendor/anthropic-sdk.mjs').then(({ default: Anthropic }) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true }));
  }
  return clientPromise;
}

// jpeg（Blob）1枚から場所を推定する。返り値 { found, place_name, lat, lng, confidence, reason }。断られた・読めなかったときは null
export async function locatePhoto({ apiKey, model, jpeg }) {
  const client = await clientFor(apiKey);
  const data = await blobToBase64(jpeg);
  const params = {
    model,
    max_tokens: 4000,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
      { type: 'text', text: PROMPT },
    ] }],
  };
  let res;
  if (model === 'claude-opus-5') {
    // Opus 5 は安全のための判定で断ることがあるので、そのときは自動で別のモデルに回す（server-side fallback）
    res = await client.beta.messages.create({ ...params, output_config: { ...params.output_config, effort: 'low' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } else if (model === 'claude-sonnet-5') {
    res = await client.messages.create({ ...params, output_config: { ...params.output_config, effort: 'low' } });
  } else {
    res = await client.messages.create(params);
  }
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { return null; }
}

function blobToBase64(blob) {
  return new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => ng(r.error);
    r.readAsDataURL(blob);
  });
}
