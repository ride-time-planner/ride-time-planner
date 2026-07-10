/* map.js — Leaflet 地図とルートライン、カーソル連動マーカー */
const MapView = (() => {
  let map, line, cursor, bases, baseIdx = 0, colorLayers = [];
  const BASE_DEFS = [
    { name: '標準', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opt: { maxZoom: 19, attribution: '&copy; OpenStreetMap' } },
    { name: '地形', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opt: { maxZoom: 17, attribution: '&copy; OpenTopoMap' } },
    { name: '航空写真', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19, attribution: '&copy; Esri' } }
  ];

  function init() {
    map = L.map('map', { zoomControl: true }).setView([35.68, 139.76], 11);
    bases = BASE_DEFS.map(b => L.tileLayer(b.url, b.opt));
    bases[0].addTo(map);
    map.createPane('signals'); map.getPane('signals').style.zIndex = 450; // ルート線(400)より上
    addControls();
  }

  // 信号機アイコン（SVG・小さめ・ルート線の上）
  const SIGNAL_SVG = '<svg width="12" height="18" viewBox="0 0 12 18" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="1" y="1" width="10" height="16" rx="3" fill="#23272e" stroke="#fff" stroke-width="1"/>' +
    '<circle cx="6" cy="5" r="1.8" fill="#ef4444"/><circle cx="6" cy="9" r="1.8" fill="#fbbf24"/><circle cx="6" cy="13" r="1.8" fill="#22c55e"/></svg>';
  let signalLayers = [];
  function drawSignals(signals) {
    signalLayers.forEach(l => l.remove()); signalLayers = [];
    (signals || []).forEach(s => {
      signalLayers.push(L.marker([s.lat, s.lng], {
        pane: 'signals', interactive: false,
        icon: L.divIcon({ className: 'signal-ico', html: SIGNAL_SVG, iconSize: [12, 18], iconAnchor: [6, 9] })
      }).addTo(map));
    });
  }

  function fitRoute() { if (line) map.fitBounds(line.getBounds(), { padding: [24, 24] }); }
  function cycleBase(btn) {
    map.removeLayer(bases[baseIdx]);
    baseIdx = (baseIdx + 1) % bases.length;
    bases[baseIdx].addTo(map);
    if (btn) { btn.textContent = BASE_DEFS[baseIdx].name[0]; btn.title = '地図モード: ' + BASE_DEFS[baseIdx].name; }
  }
  function addControls() {
    const Ctl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar map-ctl');
        const fit = L.DomUtil.create('a', '', box);
        fit.href = '#'; fit.title = 'ルート全体を表示'; fit.innerHTML = '⤢';
        const mode = L.DomUtil.create('a', '', box);
        mode.href = '#'; mode.title = '地図モード切替: ' + BASE_DEFS[0].name; mode.textContent = BASE_DEFS[0].name[0]; mode.className = 'mode-btn';
        L.DomEvent.on(fit, 'click', e => { L.DomEvent.preventDefault(e); fitRoute(); });
        L.DomEvent.on(mode, 'click', e => { L.DomEvent.preventDefault(e); cycleBase(mode); });
        L.DomEvent.disableClickPropagation(box);
        return box;
      }
    });
    map.addControl(new Ctl());
  }

  function draw(points) {
    colorLayers.forEach(l => l.remove()); colorLayers = [];
    const latlngs = points.map(p => [p.lat, p.lng]);
    if (line) line.remove();
    line = L.polyline(latlngs, { className: 'route-line', weight: 4 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [24, 24] });
  }

  // 日の出/日の入り（緯度経度＋日付, ローカル時刻の10進時）Sunrise equation
  function sunTimes(lat, lng, date) {
    const rad = Math.PI / 180, J2000 = 2451545;
    const toJ = d => d.valueOf() / 86400000 + 2440587.5;
    const n = Math.round(toJ(date) - J2000 - 0.0009);
    const Js = J2000 + 0.0009 + (-lng / 360) + n;
    const M = (357.5291 + 0.98560028 * (Js - J2000)) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lam = (M + C + 180 + 102.9372) % 360;
    const Jtr = Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
    const dec = Math.asin(Math.sin(lam * rad) * Math.sin(23.44 * rad));
    const cosH = (Math.sin(-0.83 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
    if (cosH > 1) return { rise: null, set: null };  // 極夜
    if (cosH < -1) return { rise: 0, set: 24 };       // 白夜
    const H = Math.acos(cosH) / rad;
    const Jset = J2000 + 0.0009 + ((H - lng) / 360) + n + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
    const Jrise = Jtr - (Jset - Jtr);
    const loc = J => { const d = new Date((J - 2440587.5) * 86400000); return d.getHours() + d.getMinutes() / 60; };
    return { rise: loc(Jrise), set: loc(Jset) };
  }

  // 経過時間 e(秒) に対応するルート上の地点（arrive配列を逆引き・線形補間）
  function pointAtElapsed(points, arrive, e) {
    let i = 1; while (i < points.length && (arrive[i] || 0) < e) i++;
    const p0 = points[i - 1], p1 = points[Math.min(i, points.length - 1)];
    const a0 = arrive[i - 1] || 0, a1 = arrive[Math.min(i, points.length - 1)] || a0;
    const r = a1 > a0 ? (e - a0) / (a1 - a0) : 0;
    return { lat: p0.lat + r * (p1.lat - p0.lat), lng: p0.lng + r * (p1.lng - p0.lng), dist: p0.dist + r * (p1.dist - p0.dist), ele: p0.ele + r * (p1.ele - p0.ele) };
  }
  // ライドが日の出/日の入り時刻を通過する地点を求める
  function sunEvents(points, arrive, startSec) {
    if (!points || points.length < 2) return [];
    const st = sunTimes(points[0].lat, points[0].lng, new Date());
    const total = arrive[arrive.length - 1] || 0;
    const out = [];
    for (const [kind, h] of [['sunrise', st.rise], ['sunset', st.set]]) {
      if (h == null) continue;
      let e = h * 3600 - startSec; if (e < 0) e += 86400;
      if (e < 0 || e > total) continue;            // ライド時間内に該当しなければ表示しない
      const p = pointAtElapsed(points, arrive, e);
      out.push({ kind, lat: p.lat, lng: p.lng, distKm: p.dist, ele: p.ele, clock: Schedule.fmtClock(startSec, e) });
    }
    return out;
  }
  // 日の出☀/日の入り🌙アイコンをルート線上に描画
  let sunLayers = [];
  function drawSun(events) {
    sunLayers.forEach(l => l.remove()); sunLayers = [];
    (events || []).forEach(ev => {
      const ic = ev.kind === 'sunrise' ? '☀' : '🌙';
      const name = ev.kind === 'sunrise' ? '日の出' : '日の入り';
      sunLayers.push(L.marker([ev.lat, ev.lng], {
        icon: L.divIcon({ className: 'sun-marker sun-' + ev.kind, html: `<span class="ic">${ic}</span><span class="lab">${name} ${ev.clock}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] }),
        zIndexOffset: 250000, interactive: false
      }).addTo(map));
    });
  }

  // 主要クライム区間をルート線上に強調（白フチ＋紫）。番号ラベル付き。
  let climbLayers = [];
  function drawClimbs(points, climbs) {
    climbLayers.forEach(l => l.remove()); climbLayers = [];
    (climbs || []).forEach((c, idx) => {
      const seg = points.filter(p => p.dist >= c.startKm && p.dist <= c.endKm);
      const ll = seg.map(p => [p.lat, p.lng]);
      if (ll.length < 2) return;
      // 白フチ（下地）→ 紫（上）で地図・オレンジ線と区別
      climbLayers.push(L.polyline(ll, { color: '#ffffff', weight: 10, opacity: 0.9 }).addTo(map));
      climbLayers.push(L.polyline(ll, { className: 'climb-line', weight: 6, opacity: 1 }).addTo(map));
      // 番号ラベル
      const mid = seg[Math.floor(seg.length / 2)];
      climbLayers.push(L.marker([mid.lat, mid.lng], {
        icon: L.divIcon({ className: 'climb-badge', html: String(idx + 1), iconSize: [18, 18], iconAnchor: [9, 9] })
      }).addTo(map));
    });
  }

  // 滞在ポイントを地図上に POI 表示（ラベル付き）
  let stopLayers = [];
  function drawStops(points, stops) {
    stopLayers.forEach(l => l.remove()); stopLayers = [];
    (stops || []).forEach((s, idx) => {
      if (!isFinite(s.distKm)) return;
      let pt = points[0];
      for (const p of points) { if (p.dist >= s.distKm) { pt = p; break; } }
      const label = (s.label && s.label.trim()) || `P${idx + 1}`;
      const timing = s.clock ? `<b>${s.clock}</b><i>${s.elapsedStr || ''}</i>` : '';
      stopLayers.push(L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({ className: 'stop-poi', html: `<span class="dot"></span><span class="lab"><em>${label}</em>${timing}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] }),
        zIndexOffset: 300000
      }).addTo(map));
    });
  }

  // 標高グラフのクリック地点を地図で拡大表示
  function focus(pt) {
    if (!pt || !map) return;
    map.setView([pt.lat, pt.lng], Math.max(map.getZoom(), 15), { animate: true });
    showCursor(pt);
  }

  // 経過時間マーカー（○分おき）を地図に表示（経過＋時刻ラベル）
  let tmLayers = [];
  function drawTimeMarkers(markers) {
    tmLayers.forEach(l => l.remove()); tmLayers = [];
    (markers || []).forEach(m => {
      const head = m.name ? `<em>${m.name}</em>` : '';
      tmLayers.push(L.marker([m.lat, m.lng], {
        icon: L.divIcon({
          className: 'time-marker tm-' + (m.kind || 'time'),
          html: `<span class="dot"></span><span class="lab">${head}<b>${m.clock}</b>${m.elapsedStr}</span>`,
          iconSize: [0, 0], iconAnchor: [0, 0]
        }), interactive: false, zIndexOffset: m.kind === 'time' ? 100000 : 200000
      }).addTo(map));
    });
  }

  // 標高プロファイルのホバー位置を地図に表示
  function showCursor(pt) {
    if (!pt) { if (cursor) { cursor.remove(); cursor = null; } return; }
    if (!cursor) cursor = L.circleMarker([pt.lat, pt.lng],
      { radius: 6, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
    else cursor.setLatLng([pt.lat, pt.lng]);
  }

  return { init, draw, sunEvents, drawSun, drawClimbs, drawStops, drawTimeMarkers, drawSignals, showCursor, focus, invalidate: () => map && map.invalidateSize() };
})();
