/* map.js — Leaflet 地図とルートライン、カーソル連動マーカー */
const MapView = (() => {
  let map, line, cursor, bases, baseIdx = 0;
  const BASE_DEFS = [
    { name: '標準', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opt: { maxZoom: 19, attribution: '&copy; OpenStreetMap' } },
    { name: '地形', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opt: { maxZoom: 17, attribution: '&copy; OpenTopoMap' } },
    { name: '航空写真', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19, attribution: '&copy; Esri' } }
  ];

  function init() {
    map = L.map('map', { zoomControl: true }).setView([35.68, 139.76], 11);
    bases = BASE_DEFS.map(b => L.tileLayer(b.url, b.opt));
    bases[0].addTo(map);
    addControls();
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
    const latlngs = points.map(p => [p.lat, p.lng]);
    if (line) line.remove();
    line = L.polyline(latlngs, { className: 'route-line', weight: 4 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [20, 20] });
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
      climbLayers.push(L.polyline(ll, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(map));
      climbLayers.push(L.polyline(ll, { className: 'climb-line', weight: 5, opacity: 1 }).addTo(map));
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
      stopLayers.push(L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({ className: 'stop-poi', html: `<span class="dot"></span><span class="lab">${label}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] })
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
        }), interactive: false, zIndexOffset: m.kind === 'time' ? 0 : 1000
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

  return { init, draw, drawClimbs, drawStops, drawTimeMarkers, showCursor, focus, invalidate: () => map && map.invalidateSize() };
})();
