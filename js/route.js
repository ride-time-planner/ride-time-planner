/* route.js — GPX の取り込みと距離・勾配の前処理 */
const Route = (() => {

  // ハバーサインで2点間距離(km)
  function haversineKm(a, b) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // GPXテキスト → 点列[{lat,lng,ele,dist}]
  function parseGpx(text) {
    text = String(text).replace(/^[﻿\s]+/, ''); // 先頭のBOM/空白を除去
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('GPXの解析に失敗しました');
    let pts = [...xml.querySelectorAll('trkpt')];
    if (pts.length === 0) pts = [...xml.querySelectorAll('rtept')];
    if (pts.length === 0) throw new Error('trkpt/rtept が見つかりません');

    const raw = pts.map(p => ({
      lat: parseFloat(p.getAttribute('lat')),
      lng: parseFloat(p.getAttribute('lon')),
      ele: parseFloat(p.querySelector('ele')?.textContent ?? 'NaN')
    }));
    fillElevation(raw);

    let dist = 0;
    const points = raw.map((p, i) => {
      if (i > 0) dist += haversineKm(raw[i - 1], p);
      return { lat: p.lat, lng: p.lng, ele: p.ele, dist };
    });
    smoothElevation(points);
    const name = xml.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim()
      || 'GPXルート';
    return { name, source: 'gpx', points };
  }

  // 標高の移動平均（距離ウィンドウ, 既定±120m）でGPSノイズを低減
  function smoothElevation(points, winM = 120) {
    if (points.length < 3) return points;
    const raw = points.map(p => p.ele);
    for (let i = 0; i < points.length; i++) {
      let sum = 0, n = 0, j = i;
      // 後方
      while (j >= 0 && (points[i].dist - points[j].dist) * 1000 <= winM) { sum += raw[j]; n++; j--; }
      // 前方
      j = i + 1;
      while (j < points.length && (points[j].dist - points[i].dist) * 1000 <= winM) { sum += raw[j]; n++; j++; }
      points[i].ele = sum / n;
    }
    return points;
  }

  // 2点間の進行方位（度, 0=北, 時計回り）— 向かい風計算用
  function bearing(a, b) {
    const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // 標高欠損の簡易補完（前値保持）
  function fillElevation(raw) {
    let last = 0;
    for (const p of raw) { if (Number.isFinite(p.ele)) last = p.ele; else p.ele = last; }
  }

  // 区間ごとの距離・標高差・勾配を返す（models/scheduleが利用）
  function segments(points) {
    const segs = [];
    for (let i = 1; i < points.length; i++) {
      const d = (points[i].dist - points[i - 1].dist) * 1000; // m
      const dh = points[i].ele - points[i - 1].ele;           // m
      const grade = d > 0 ? dh / d : 0;
      const brg = d > 0 ? bearing(points[i - 1], points[i]) : 0;
      segs.push({ i, distM: d, dh, grade, bearing: brg, fromDistKm: points[i - 1].dist, toDistKm: points[i].dist });
    }
    return segs;
  }

  // 総距離・獲得標高・勾配統計
  function stats(points) {
    let gain = 0, maxGrade = 0;
    const segs = segments(points);
    for (const s of segs) {
      if (s.dh > 0) gain += s.dh;
      maxGrade = Math.max(maxGrade, s.grade);
    }
    const distKm = points.length ? points[points.length - 1].dist : 0;
    const avgGrade = distKm > 0 ? gain / (distKm * 1000) : 0;
    return { distKm, gain, avgGrade, maxGrade };
  }

  return { parseGpx, segments, stats, haversineKm, smoothElevation, bearing };
})();
