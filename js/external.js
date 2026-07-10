/* external.js — 無料APIから 天気(Open-Meteo) と OSM(Overpass: 信号/路面) を取得 */
const Ext = (() => {
  function hav(a1, o1, a2, o2) {
    const R = 6371000, r = d => d * Math.PI / 180;
    const dLat = r(a2 - a1), dLng = r(o2 - o1);
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dLng / 2) ** 2));
  }

  // 天気: 現在の気温/風速(km/h)/風向(吹いてくる方位°)
  async function weather(lat, lng) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('天気取得失敗 ' + r.status);
    const c = (await r.json()).current || {};
    return { temp: c.temperature_2m, windSpeed: c.wind_speed_10m, windDir: c.wind_direction_10m };
  }

  // 路面surface → Crr のおおよそ
  const SURF_CRR = { asphalt: 0.005, paved: 0.005, concrete: 0.006, chipseal: 0.006, paving_stones: 0.008, sett: 0.011, cobblestone: 0.012, compacted: 0.008, fine_gravel: 0.009, gravel: 0.011, unpaved: 0.012, ground: 0.014, dirt: 0.014, grass: 0.02, sand: 0.03 };

  // 公式ドキュメントのJSサンプル準拠: POSTで body="data="+encodeURIComponent(query)、独自ヘッダは付けない
  // (Content-Type/Accept を足すと overpass-api.de が 406 Not Acceptable を返すため)
  // 公開インスタンスは OSM wiki「Public Overpass API instances」準拠。
  // 実運用の都合で private.coffee を先頭に:
  //  ・private.coffee(旧overpass.kumi.systems) … ACAO:* を返すため file:// (Origin:null) でも通る。
  //     レート制限なし。overpass-turbo も deploy されている正規インスタンス
  //  ・本家(FOSSGIS) overpass-api.de … overpass-turbo の既定だが (1)2026年に 406 を返す不具合,
  //     (2)null オリジン(file://)には CORSヘッダを返さない → file://実行では失敗する。
  //     正規オリジン(http/https, 例:GitHub Pages)で本家が健全なときに使うフォールバック。
  //     利用目安 <1万クエリ/日・<1GB/日、Referer/User-Agent での識別が推奨（Refererはブラウザが自動送信）
  const OVERPASS = ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter'];
  async function overpass(q) {
    let lastErr;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
        if (r.ok) return await r.json();
        lastErr = new Error('HTTP ' + r.status + ' @ ' + ep);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass 全滅');
  }

  // 点pのローカル平面(等距円筒近似, 基準a)における a→b 線分への垂直距離[m]
  function perpDist(p, a, b) {
    const R = 6371000, rad = d => d * Math.PI / 180, lat0 = rad(a.lat);
    const X = q => R * rad(q.lng - a.lng) * Math.cos(lat0), Y = q => R * rad(q.lat - a.lat);
    const bx = X(b), by = Y(b), px = X(p), py = Y(p);
    const L2 = bx * bx + by * by;
    if (L2 === 0) return Math.hypot(px, py);
    let t = (px * bx + py * by) / L2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - t * bx, py - t * by);
  }
  // Ramer–Douglas–Peucker 折れ線簡略化（直線は大胆に間引き, カーブは点を保持）。反復版。
  function rdp(points, epsM) {
    const n = points.length;
    if (n < 3) return points.slice();
    const keep = new Array(n).fill(false); keep[0] = keep[n - 1] = true;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let idx = -1, dmax = 0;
      for (let i = a + 1; i < b; i++) {
        const d = perpDist(points[i], points[a], points[b]);
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax > epsM && idx > -1) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return points.filter((_, i) => keep[i]);
  }

  // 簡略化した折れ線を、1点重ねながら maxPts ごとのチャンクに分割（linestringを連続に保つ）
  function toChunks(pts, maxPts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i += maxPts - 1) out.push(pts.slice(i, Math.min(i + maxPts, pts.length)));
    return out;
  }
  const coordStr = ch => ch.map(p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5)).join(',');

  const RDP_EPS = 18;      // 簡略化許容誤差[m]（radより十分小さく）
  const AROUND_RAD = 50;   // linestringバッファ半径[m]（誤差18mを内包し信号を取りこぼさない）
  const SIG_CHUNK = 120;   // 信号: 小さめの分割（応答ごとに地図反映＆進捗更新）
  const SURF_CHUNK = 300;  // 路面: やや大きめ（リクエスト数を抑制）

  // OSM: ルート線沿い(around=linestring)だけを、間引き＆分割して取得。
  // opts.onSignals(累積signals, {done,total}) を各レスポンスごとに呼ぶ（逐次反映用）。
  // opts.onPhase(name) でフェーズ通知。
  async function osm(points, opts = {}) {
    const simplified = rdp(points, RDP_EPS);
    const sigChunks = toChunks(simplified, SIG_CHUNK);

    // --- 信号（細かく分割し、応答ごとにコールバック） ---
    const seen = new Set(), signals = [];
    for (let i = 0; i < sigChunks.length; i++) {
      const list = coordStr(sigChunks[i]);
      if (!list) continue;
      const j = await overpass(`[out:json][timeout:60];(node(around:${AROUND_RAD},${list})["highway"="traffic_signals"];node(around:${AROUND_RAD},${list})["crossing"="traffic_signals"];);out;`);
      for (const el of (j.elements || [])) {
        if (el.type === 'node' && el.lat != null && !seen.has(el.id)) { seen.add(el.id); signals.push({ lat: el.lat, lng: el.lon }); }
      }
      if (opts.onSignals) opts.onSignals(signals.slice(), { done: i + 1, total: sigChunks.length });
    }

    // --- 路面（way を id で一意化してから代表surfaceを長さ集計） ---
    let surface = null, crr = null;
    if (opts.onPhase) opts.onPhase('surface');
    try {
      const surfChunks = toChunks(simplified, SURF_CHUNK);
      const wayLen = {}; // id -> {surface, len}
      for (const ch of surfChunks) {
        const list = coordStr(ch);
        if (!list) continue;
        const jw = await overpass(`[out:json][timeout:60];way(around:${AROUND_RAD},${list})["highway"]["surface"];out geom;`);
        for (const el of (jw.elements || [])) {
          if (el.type !== 'way' || wayLen[el.id] || !el.geometry || !el.tags || !el.tags.surface) continue;
          let l = 0;
          for (let i = 1; i < el.geometry.length; i++) l += hav(el.geometry[i - 1].lat, el.geometry[i - 1].lon, el.geometry[i].lat, el.geometry[i].lon);
          wayLen[el.id] = { surface: el.tags.surface, len: l };
        }
      }
      const surfLen = {};
      for (const id in wayLen) surfLen[wayLen[id].surface] = (surfLen[wayLen[id].surface] || 0) + wayLen[id].len;
      let mx = 0; for (const k in surfLen) if (surfLen[k] > mx) { mx = surfLen[k]; surface = k; }
      crr = surface && SURF_CRR[surface] || null;
    } catch (_) { }

    return { signals, surface, crr, meta: { raw: points.length, simplified: simplified.length, chunks: sigChunks.length } };
  }

  return { weather, osm };
})();
