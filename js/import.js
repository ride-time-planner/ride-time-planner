/* import.js — Strava 実走データの取り込みとスクリーニング＋簡易モデル校正 */
const Importer = (() => {

  // 勾配バケット（10段階・models.js の簡易モデルと対応）
  const BUCKETS = [
    { key: 'd5', label: '下り<-9%',    test: g => g < -0.09 },
    { key: 'd4', label: '-9〜-6%',     test: g => g < -0.06 },
    { key: 'd3', label: '-6〜-3.5%',   test: g => g < -0.035 },
    { key: 'd2', label: '-3.5〜-1.5%', test: g => g < -0.015 },
    { key: 'flat', label: '-1.5〜1.5%', test: g => g < 0.015 },
    { key: 'u1', label: '1.5〜3.5%',   test: g => g < 0.035 },
    { key: 'u2', label: '3.5〜5.5%',   test: g => g < 0.055 },
    { key: 'u3', label: '5.5〜8%',     test: g => g < 0.08 },
    { key: 'u4', label: '8〜11%',      test: g => g < 0.11 },
    { key: 'u5', label: '>11%',        test: () => true }
  ];
  // 既定係数（実走傾向: 下りは-6〜-9%が最速、-9%超は技術/ブレーキで低下する山型）
  const DEFAULT_FACTORS = { d5: 1.25, d4: 1.45, d3: 1.40, d2: 1.20, flat: 1.0, u1: 0.83, u2: 0.66, u3: 0.52, u4: 0.42, u5: 0.32 };
  function bucketOf(g) { return BUCKETS.find(b => b.test(g)).key; }

  // --- 1トラックのパース（GPX / TCX） ---
  // 返り値: {points:[{lat,lng,ele,t}], hasTime}
  function parseTrack(text) {
    // 先頭のBOM/空白を除去（XML宣言前に空白があると解析エラーになるファイル対策）
    text = String(text).replace(/^[﻿\s]+/, '');
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('XML解析失敗');
    let nodes = [...xml.querySelectorAll('trkpt')];         // GPX
    let mode = 'gpx';
    if (nodes.length === 0) { nodes = [...xml.querySelectorAll('Trackpoint')]; mode = 'tcx'; } // TCX
    const points = [];
    for (const n of nodes) {
      let lat, lng, ele, t;
      if (mode === 'gpx') {
        lat = parseFloat(n.getAttribute('lat')); lng = parseFloat(n.getAttribute('lon'));
        ele = parseFloat(n.querySelector('ele')?.textContent ?? 'NaN');
        t = n.querySelector('time')?.textContent;
      } else {
        lat = parseFloat(n.querySelector('LatitudeDegrees')?.textContent ?? 'NaN');
        lng = parseFloat(n.querySelector('LongitudeDegrees')?.textContent ?? 'NaN');
        ele = parseFloat(n.querySelector('AltitudeMeters')?.textContent ?? 'NaN');
        t = n.querySelector('Time')?.textContent;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      points.push({ lat, lng, ele, t: t ? Date.parse(t) : NaN });
    }
    return finalize(points);
  }

  // FIT バイナリ(Uint8Array) → トラック
  function parseFit(u8) {
    return finalize(FitParser.parse(u8));
  }

  // 共通後処理: 累積距離付与＋標高平滑化＋時刻有無
  // FITのデバイス積算距離(p.dev)があればそれを採用（GPS距離の膨張を回避）。
  function finalize(points) {
    const devKm = points.length > 1 && Number.isFinite(points[points.length - 1].dev) ? points[points.length - 1].dev / 1000 : 0;
    // デバイス距離は 0<d<2000km かつ 単調増加のときのみ採用（異常値ガード）
    const monotonic = devKm > 0 && (points[0].dev == null || points[0].dev <= points[points.length - 1].dev);
    const useDev = devKm > 0.5 && devKm < 2000 && monotonic;
    let dist = 0;
    for (let i = 0; i < points.length; i++) {
      if (useDev) {
        points[i].dist = (Number.isFinite(points[i].dev) ? points[i].dev : dist * 1000) / 1000;
        dist = points[i].dist;
      } else {
        if (i > 0) dist += Route.haversineKm(points[i - 1], points[i]);
        points[i].dist = dist;
      }
    }
    if (points.length >= 3) Route.smoothElevation(points);
    return { points, hasTime: points.some(p => Number.isFinite(p.t)) };
  }

  // --- 1トラックから 勾配バケット別の速度サンプルを収集 ---
  // ~約100mウィンドウで集計しGPSノイズを低減。停止・異常値は除外。
  function sampleSpeeds(points, win = 100) {
    const out = {}; BUCKETS.forEach(b => out[b.key] = []);
    if (points.length < 2) return out;
    let accD = 0, accH = 0, accT = 0, prev = points[0];
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const d = (p.dist - prev.dist) * 1000;       // m（finalizeで付与済み・FITはデバイス距離）
      const dt = (p.t - prev.t) / 1000;            // s
      prev = p;
      if (!Number.isFinite(d) || d <= 0) continue;
      accD += d;
      accH += (Number.isFinite(p.ele) && Number.isFinite(points[i - 1].ele)) ? (p.ele - points[i - 1].ele) : 0;
      accT += Number.isFinite(dt) ? dt : 0;
      if (accD >= win) {
        if (accT > 0) {
          const v = (accD / accT) * 3.6;   // km/h
          const g = accH / accD;           // 勾配
          if (v >= 3 && v <= 80) out[bucketOf(g)].push(v);
        }
        accD = 0; accH = 0; accT = 0;
      }
    }
    return out;
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // --- 複数トラックのサンプルを統合して校正結果を返す ---
  // 返り値: {flatSpeed, factors:{bucket:factor}, counts:{bucket:n}, sampleN}
  function calibrate(tracks) {
    const merged = {}; BUCKETS.forEach(b => merged[b.key] = []);
    let usable = 0;
    for (const tr of tracks) {
      if (!tr.hasTime) continue; // 時刻の無いGPXは速度算出不可
      usable++;
      const s = sampleSpeeds(tr.points);
      for (const b of BUCKETS) merged[b.key].push(...s[b.key]);
    }
    const med = {}, counts = {};
    for (const b of BUCKETS) { med[b.key] = median(merged[b.key]); counts[b.key] = merged[b.key].length; }
    // 平地速度: flat が無ければ up/down の近傍から推定
    const flatSpeed = med.flat || med.d2 || med.u1 || 25;
    const factors = {};
    for (const b of BUCKETS) {
      factors[b.key] = (med[b.key] && flatSpeed) ? +(med[b.key] / flatSpeed).toFixed(3) : DEFAULT_FACTORS[b.key];
    }
    factors.flat = 1.0;
    const sampleN = Object.values(counts).reduce((a, n) => a + n, 0);
    return { flatSpeed: +flatSpeed.toFixed(1), factors, counts, sampleN, usableTracks: usable };
  }

  // --- ファイル群を取り込み（GPX/TCX/ZIP）。screening: {minKm} ---
  // 返り値: {tracks, skipped}
  async function loadFiles(fileList, screening = {}) {
    const tracks = []; let skipped = 0;
    for (const f of fileList) {
      const name = f.name.toLowerCase();
      try {
        if (name.endsWith('.zip')) {
          const zipTracks = await loadZip(f, screening);
          tracks.push(...zipTracks);
        } else if (name.endsWith('.gpx') || name.endsWith('.tcx')) {
          const tr = parseTrack(await f.text());
          if (passScreen(tr, screening)) tracks.push(tr); else skipped++;
        } else if (name.endsWith('.gpx.gz') || name.endsWith('.tcx.gz')) {
          const tr = parseTrack(await gunzipText(await f.arrayBuffer()));
          if (passScreen(tr, screening)) tracks.push(tr); else skipped++;
        } else if (name.endsWith('.fit.gz')) {
          const tr = parseFit(await gunzipBytes(await f.arrayBuffer()));
          if (passScreen(tr, screening)) tracks.push(tr); else skipped++;
        } else if (name.endsWith('.fit')) {
          const tr = parseFit(new Uint8Array(await f.arrayBuffer()));
          if (passScreen(tr, screening)) tracks.push(tr); else skipped++;
        }
      } catch (e) { console.warn('取り込み失敗', f.name, e); skipped++; }
    }
    return { tracks, skipped };
  }

  function trackDistanceKm(points) {
    if (!points.length) return 0;
    // finalize済みなら確定距離(FITはデバイス距離)を使用。なければハバーサイン。
    const last = points[points.length - 1];
    if (Number.isFinite(last.dist) && last.dist > 0) return last.dist;
    let d = 0; for (let i = 1; i < points.length; i++) d += Route.haversineKm(points[i - 1], points[i]);
    return d;
  }
  function trackFirstTime(points) {
    for (const p of points) if (Number.isFinite(p.t)) return p.t;
    return null;
  }
  function passScreen(tr, s) {
    if (!tr || tr.points.length < 2) return false;
    if (s.minKm && trackDistanceKm(tr.points) < s.minKm) return false; // 通勤など短距離を除外
    if (s.maxDays) { // N日以内のみ（走行日時で判定）
      const t = trackFirstTime(tr.points);
      if (t && (Date.now() - t) > s.maxDays * 86400000) return false;
    }
    return true;
  }

  // --- ZIP（Strava一括エクスポート）対応。JSZip をCDNから遅延ロード ---
  async function ensureJSZip() {
    if (window.JSZip) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = res; s.onerror = () => rej(new Error('JSZip の読み込みに失敗'));
      document.head.appendChild(s);
    });
  }
  // gzip 解凍（ブラウザ標準 DecompressionStream）
  async function gunzipBytes(buf) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function gunzipText(buf) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }

  const basename = p => p.split('/').pop();

  // 最小 CSV パーサ（ダブルクォート対応）
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c === '\r') { /* skip */ }
        else cell += c;
      }
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // activities.csv → {basename: {type, name}}
  function parseActivitiesCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return null;
    const head = rows[0].map(h => h.trim().toLowerCase());
    const iType = head.findIndex(h => h.includes('activity type'));
    const iName = head.findIndex(h => h.includes('activity name'));
    const iFile = head.findIndex(h => h.includes('filename'));
    if (iFile < 0) return null;
    const map = {};
    for (let r = 1; r < rows.length; r++) {
      const f = rows[r][iFile]; if (!f) continue;
      map[basename(f)] = { type: (rows[r][iType] || '').trim(), name: (rows[r][iName] || '').trim() };
    }
    return map;
  }

  // Strava 一括エクスポート ZIP に対応（.gz 解凍・activities.csv スクリーニング）
  async function loadZip(file, screening) {
    await ensureJSZip();
    const zip = await window.JSZip.loadAsync(file);
    const files = Object.values(zip.files).filter(e => !e.dir);

    // メタ情報（あれば）
    let meta = null;
    const csvEntry = files.find(e => /(^|\/)activities\.csv$/i.test(e.name));
    if (csvEntry) { try { meta = parseActivitiesCsv(await csvEntry.async('text')); } catch (_) { } }

    const excludeKw = (screening.excludeKeyword || '').trim();
    const rideOnly = screening.rideOnly !== false; // 既定でライド系のみ
    const trackEntries = files.filter(e => /\.(gpx|tcx|fit)(\.gz)?$/i.test(e.name));

    const tracks = []; let processed = 0;
    const MAX = screening.maxFiles || 80; // 校正は代表サンプルで十分（大容量対策）
    for (const e of trackEntries) {
      if (processed >= MAX) break;
      // CSV があればタイプ/キーワードで事前スクリーニング
      if (meta) {
        const m = meta[basename(e.name)];
        if (m) {
          // ライド系のみ、かつ屋内(Virtual)は実地形の校正に使えないので除外
          if (rideOnly && (!/ride|ライド|cycling/i.test(m.type) || /virtual|バーチャル|indoor/i.test(m.type))) continue;
          if (excludeKw && m.name && m.name.includes(excludeKw)) continue;
        }
      }
      try {
        const isFit = /\.fit(\.gz)?$/i.test(e.name);
        const isGz = /\.gz$/i.test(e.name);
        let tr;
        if (isFit) {
          const bytes = isGz ? await gunzipBytes(await e.async('uint8array')) : await e.async('uint8array');
          tr = parseFit(bytes);
        } else {
          const text = isGz ? await gunzipText(await e.async('uint8array')) : await e.async('text');
          tr = parseTrack(text);
        }
        if (passScreen(tr, screening)) { tracks.push(tr); processed++; }
      } catch (_) { /* 破損等はスキップ */ }
    }
    return tracks;
  }

  // 1ファイル→トラック配列（ZIPは複数）。拡張子で振り分け。
  async function loadOne(f, screening) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.zip')) return await loadZip(f, screening);
    if (name.endsWith('.fit.gz')) return [parseFit(await gunzipBytes(await f.arrayBuffer()))];
    if (name.endsWith('.fit')) return [parseFit(new Uint8Array(await f.arrayBuffer()))];
    if (name.endsWith('.gpx.gz') || name.endsWith('.tcx.gz')) return [parseTrack(await gunzipText(await f.arrayBuffer()))];
    if (name.endsWith('.gpx') || name.endsWith('.tcx')) return [parseTrack(await f.text())];
    return [];
  }

  // パワー付きトラックから CP(ピーク) と CdA/Crr(物理回帰) の材料を蓄積
  const POW_DUR = { 180: '3m', 300: '5m', 600: '10m', 1200: '20m' };
  function accumulatePower(acc, points) {
    const pw = []; for (const p of points) if (Number.isFinite(p.pw)) pw.push(p.pw);
    if (pw.length < 60) return; // パワー無し/短すぎ
    acc.hasPower = true;
    // 継続時間別ベスト平均パワー（≈1Hz前提, 累積和でO(n)）
    const cs = [0]; for (const x of pw) cs.push(cs[cs.length - 1] + x);
    for (const d in POW_DUR) {
      const w = +d; if (w > pw.length) continue;
      let m = 0; for (let i = 0; i + w <= pw.length; i++) { const s = (cs[i + w] - cs[i]) / w; if (s > m) m = s; }
      if (m > (acc.best[d] || 0)) acc.best[d] = m;
    }
    // CdA/Crr 回帰用サンプル（10秒窓, 推進局面のみ）
    const n = points.length; let i = 0;
    while (i < n - 1) {
      const t0 = points[i].t; let j = i;
      while (j < n - 1 && points[j].t - t0 < 10000) j++;
      const dt = (points[j].t - points[i].t) / 1000, dd = (points[j].dist - points[i].dist) * 1000;
      let ps = 0, pc = 0; for (let k = i; k <= j; k++) if (Number.isFinite(points[k].pw)) { ps += points[k].pw; pc++; }
      if (dt >= 8 && dt <= 15 && dd > 20 && pc) {
        const v = dd / dt, P = ps / pc, grade = (points[j].ele - points[i].ele) / dd;
        if (v >= 3 && v <= 18 && P >= 60 && grade >= -0.005 && grade <= 0.15) {
          const th = Math.atan(grade), F = P * 0.976 / v, Y = F - acc.mass * 9.80665 * Math.sin(th);
          const x1 = acc.mass * 9.80665 * Math.cos(th), x2 = 0.5 * 1.225 * v * v;
          acc.X11 += x1 * x1; acc.X12 += x1 * x2; acc.X22 += x2 * x2; acc.Y1 += x1 * Y; acc.Y2 += x2 * Y; acc.n++;
        }
      }
      i = j;
    }
  }
  function finalizePower(acc) {
    const peaks = {}; for (const d in acc.best) if (POW_DUR[d]) peaks[POW_DUR[d]] = Math.round(acc.best[d]);
    let cda = null, crr = null;
    const det = acc.X11 * acc.X22 - acc.X12 * acc.X12;
    if (acc.n > 200 && det) {
      crr = (acc.Y1 * acc.X22 - acc.Y2 * acc.X12) / det;
      cda = (acc.X11 * acc.Y2 - acc.X12 * acc.Y1) / det;
    }
    return {
      hasPower: acc.hasPower, peaks, samplesN: acc.n,
      cda: (cda > 0.15 && cda < 0.6) ? +cda.toFixed(3) : null,
      crr: (crr > 0.002 && crr < 0.015) ? +crr.toFixed(4) : null
    };
  }

  // 大量ファイルを逐次処理してストリーミング校正（メモリ上限・UI非ブロッキング・進捗）。
  // onProgress(done, total, usable) を随時呼ぶ。全トラックを保持しないので大量投入に強い。
  async function calibrateFiles(fileList, screening = {}, onProgress) {
    const CAP = 6000; // バケットごとの標本上限（中央値には十分・メモリ保護）
    const merged = {}; BUCKETS.forEach(b => merged[b.key] = []);
    const powAcc = { hasPower: false, best: {}, X11: 0, X12: 0, X22: 0, Y1: 0, Y2: 0, n: 0, mass: screening.mass || 79 };
    let usable = 0, skipped = 0;
    const files = [...fileList];
    for (let i = 0; i < files.length; i++) {
      let trs = [];
      try { trs = await loadOne(files[i], screening); } catch (e) { trs = []; }
      for (const tr of trs) {
        if (!tr || !tr.hasTime || !passScreen(tr, screening)) { skipped++; continue; }
        usable++;
        const s = sampleSpeeds(tr.points);
        for (const b of BUCKETS) {
          const arr = merged[b.key], src = s[b.key];
          for (let j = 0; j < src.length; j++) { if (arr.length < CAP) arr.push(src[j]); }
        }
        try { accumulatePower(powAcc, tr.points); } catch (_) { }
      }
      if (onProgress && (i % 3 === 0 || i === files.length - 1)) onProgress(i + 1, files.length, usable);
      if (i % 8 === 7) await new Promise(r => setTimeout(r)); // UIへ制御を返す（フリーズ防止）
    }
    const med = {}, counts = {};
    for (const b of BUCKETS) { med[b.key] = median(merged[b.key]); counts[b.key] = merged[b.key].length; }
    const flatSpeed = med.flat || med.d2 || med.u1 || 25;
    const factors = {};
    for (const b of BUCKETS) factors[b.key] = (med[b.key] && flatSpeed) ? +(med[b.key] / flatSpeed).toFixed(3) : DEFAULT_FACTORS[b.key];
    factors.flat = 1.0;
    const sampleN = Object.values(counts).reduce((a, n) => a + n, 0);
    return { flatSpeed: +flatSpeed.toFixed(1), factors, counts, sampleN, usableTracks: usable, skipped, power: finalizePower(powAcc) };
  }

  return { parseTrack, parseFit, sampleSpeeds, calibrate, calibrateFiles, loadFiles, loadOne, BUCKETS };
})();
