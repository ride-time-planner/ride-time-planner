/* models.js — 速度モデル(簡易/パワー) と VAM 等の指標計算 */
const Models = (() => {
  const G = 9.80665;

  // --- モデルA: 勾配-速度テーブル（簡易） ---
  // p.factors があれば Strava 校正値を優先、無ければ既定係数。
  // 10段階（import.js の BUCKETS と境界を一致させること）
  const DEFAULT_FACTORS = { d5: 1.25, d4: 1.45, d3: 1.40, d2: 1.20, flat: 1.00, u1: 0.83, u2: 0.66, u3: 0.52, u4: 0.42, u5: 0.32 };
  function bucketKey(g) {
    if (g < -0.09) return 'd5';
    if (g < -0.06) return 'd4';
    if (g < -0.035) return 'd3';
    if (g < -0.015) return 'd2';
    if (g < 0.015) return 'flat';
    if (g < 0.035) return 'u1';
    if (g < 0.055) return 'u2';
    if (g < 0.08) return 'u3';
    if (g < 0.11) return 'u4';
    return 'u5';
  }
  function speedSimple(grade, p) {
    const table = (p.factors && Object.keys(p.factors).length) ? p.factors : DEFAULT_FACTORS;
    const f = table[bucketKey(grade)] ?? DEFAULT_FACTORS[bucketKey(grade)];
    return Math.max(4, p.flatSpeed * f); // km/h（最低4km/h）
  }

  // --- モデルB: パワー物理モデル ---
  // 一定パワーP(W)で勾配gradeを走る時の速度(m/s)を二分法で解く
  // hw: 向かい風成分(m/s, +=向かい風/-=追い風)。空気抵抗は対気速度(v+hw)で計算。
  function speedPower(grade, p, hw = 0, powerW = null) {
    const P = powerW != null ? powerW : p.ftp * p.intensity;
    const m = p.riderWeight + p.bikeWeight + (p.gearWeight || 0);
    const theta = Math.atan(grade);
    const rollGrav = m * G * (p.crr * Math.cos(theta) + Math.sin(theta));
    // P = v*(rollGrav + 0.5*rho*CdA*(v+hw)*|v+hw|)  → f(v)=0 を解く
    const f = v => { const air = v + hw; return v * (rollGrav + 0.5 * p.rho * p.cda * air * Math.abs(air)) - P; };
    let lo = 0.1, hi = 30; // m/s
    // 下り等で rollGrav<0 のときは f(lo) が負になり得る→広めに探索
    if (f(lo) > 0) return Math.max(1.1, lo * 3.6); // 登坂しきれない極端ケース
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) hi = mid; else lo = mid;
    }
    let vms = (lo + hi) / 2;
    vms = Math.min(vms, 22); // 下りの上限 ~80km/h
    return Math.max(1.1, vms * 3.6); // km/h
  }

  // 統合モデル: Strava校正(実速度)と Zwift/FTP(物理) を等しく使う。
  // 両方あれば 50/50 ブレンド、片方だけならそれ、どちらも無ければ既定テーブル。
  function unifiedSpeed(grade, p, hw = 0, powerW = null) {
    const hasCal = p.factors && Object.keys(p.factors).length;
    const hasFtp = p.ftp > 0;
    const vs = speedSimple(grade, p);              // 校正 or 既定テーブル
    const vp = speedPower(grade, p, hw, powerW);   // 物理(FTP or 上書きパワー)
    // 検証(train/test)より、校正がある場合は実速度テーブル寄り(0.7/0.3)が最良
    if (hasCal && hasFtp) return 0.7 * vs + 0.3 * vp;
    if (hasCal) return vs;
    if (hasFtp) return vp;
    return vs;
  }

  // Critical Power モデル: ピークパワー(継続時間別)から CP と W' を回帰。
  // P(t) = CP + W'/t （3分以上を使用）。peaks: {'3m':W, '5m':W, ...}
  const PEAK_SEC = { '5s': 5, '15s': 15, '30s': 30, '1m': 60, '3m': 180, '5m': 300, '10m': 600, '12m': 720, '15m': 900, '20m': 1200, '30m': 1800, '40m': 2400 };
  function estimateCP(peaks) {
    if (!peaks) return null;
    const pts = [];
    for (const k in PEAK_SEC) { const w = peaks[k]; if (PEAK_SEC[k] >= 180 && w > 0) pts.push([PEAK_SEC[k], w]); }
    if (pts.length < 2) return null;
    const xs = pts.map(p => 1 / p[0]), ys = pts.map(p => p[1]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const wprime = den ? num / den : 0, cp = my - wprime * mx;
    if (!(cp > 0)) return null;
    return { cp: Math.round(cp), wprime: Math.round(wprime), n: pts.length };
  }
  // 継続時間 t(秒) に持続可能なパワー（CPモデル）
  function powerForDuration(cpw, t) { return cpw ? cpw.cp + cpw.wprime / Math.max(t, 1) : null; }

  // 校正済みの登坂速度から持続パワー(≈FTP目安)を逆算
  function estimateFtp(p) {
    if (!(p.factors && Object.keys(p.factors).length)) return null;
    const g = 0.065;
    const v = (p.flatSpeed * (p.factors.u3 || DEFAULT_FACTORS.u3)) / 3.6; // m/s
    const m = p.riderWeight + p.bikeWeight + (p.gearWeight || 0);
    const th = Math.atan(g);
    const P = v * (m * G * (p.crr * Math.cos(th) + Math.sin(th)) + 0.5 * p.rho * p.cda * v * v);
    return Math.round(P);
  }

  // 3点の外接円半径(m)からカーブ半径を求める（局所曲率）
  function toXY(p, ref) { return [(p.lng - ref.lng) * 111320 * Math.cos(ref.lat * Math.PI / 180), (p.lat - ref.lat) * 110540]; }
  function cornerCaps(points, aLat) {
    // 各区間(i: points[i-1]→points[i]) のコーナリング上限速度(km/h)。直線はInfinity。
    const n = points.length, cap = new Array(n).fill(Infinity);
    for (let i = 1; i < n - 1; i++) {
      const A = toXY(points[i - 1], points[i]), B = [0, 0], C = toXY(points[i + 1], points[i]);
      const a = Math.hypot(B[0] - C[0], B[1] - C[1]), b = Math.hypot(A[0] - C[0], A[1] - C[1]), c = Math.hypot(A[0] - B[0], A[1] - B[1]);
      const area = Math.abs((A[0] - B[0]) * (C[1] - B[1]) - (C[0] - B[0]) * (A[1] - B[1])) / 2;
      if (area < 1e-3) continue; // ほぼ直線
      const R = (a * b * c) / (4 * area);
      cap[i] = Math.sqrt(aLat * R) * 3.6; // km/h
    }
    // 区間の上限 = その区間に接する点の最小cap（＝一番きついカーブ）
    const segCap = new Array(n).fill(Infinity);
    for (let i = 1; i < n; i++) segCap[i] = Math.min(cap[i - 1] || Infinity, cap[i] || Infinity);
    return segCap; // index = 区間 i
  }
  function fatFactor(hours, rate, thr) { if (!rate || hours <= thr) return 1; return Math.max(0.85, 1 - rate * (hours - thr)); }

  // 区間ごとの所要秒を計算 → {segTimes[], movingSec, avgSpeed, vam, avgPower}
  //   opts: { cornerG(横加速度g), fatigue(疲労 割合/時, 2h以降) }
  function compute(points, profile, opts = {}) {
    const segs = Route.segments(points);
    const wind = (profile.wind && profile.wind.speed) ? profile.wind : null;
    const windMs = wind ? wind.speed / 3.6 : 0;
    const usePower = profile.ftp > 0;
    const cornerG = opts.cornerG != null ? opts.cornerG : 0.40;
    const fatigue = opts.fatigue != null ? opts.fatigue : 0;
    const segCap = cornerG > 0 ? cornerCaps(points, cornerG * 9.80665) : null;
    const hwOf = s => {
      if (!wind) return 0;
      const diff = (((s.bearing - wind.dir + 540) % 360) - 180) * Math.PI / 180;
      return windMs * Math.cos(diff);
    };
    // パス1: 基本パワーで速度・区間秒
    const seg1 = segs.map(s => { const hw = hwOf(s); const v = unifiedSpeed(s.grade, profile, hw); return { s, hw, v, sec: s.distM / (v / 3.6) }; });

    // 登坂の継続時間に応じたパワー（Critical Power: CP+W'/t）で上書き
    const powerOv = new Array(segs.length).fill(null);
    const cpw = estimateCP(profile.peaks);
    if (cpw) {
      const climbs = detectClimbs(points, seg1.map(x => ({ sec: x.sec })),
        { minGain: profile.climbMinGain || 160, startGrade: profile.climbStartGrade ?? 0.06 });
      const flatP = profile.ftp * profile.intensity;
      const eff = 0.5; // 登坂は閾値〜継続時間別最大の中間で走ると仮定
      for (const c of climbs) {
        let dur = 0; const idxs = [];
        for (let i = 0; i < segs.length; i++) {
          if (segs[i].fromDistKm >= c.startKm - 1e-6 && segs[i].toDistKm <= c.endKm + 1e-6) { idxs.push(i); dur += seg1[i].sec; }
        }
        if (dur <= 0) continue;
        const maxP = cpw.cp + cpw.wprime / dur;      // その継続時間の最大
        const Pc = Math.max(flatP, cpw.cp + (maxP - cpw.cp) * eff);
        idxs.forEach(i => powerOv[i] = Pc);
      }
    }

    // パス2: 上書き＋コーナリング上限＋疲労減衰を適用
    let movingSec = 0, climbSec = 0, climbGain = 0;
    const segTimes = segs.map((s, i) => {
      let v = powerOv[i] != null ? unifiedSpeed(s.grade, profile, seg1[i].hw, powerOv[i]) : seg1[i].v;
      if (segCap) { const cc = segCap[i + 1]; if (cc && cc < v) v = Math.max(6, cc); } // カーブ上限(最低6km/h)
      if (fatigue) v *= fatFactor(movingSec / 3600, fatigue, 2);                        // 2h以降 疲労減衰
      const sec = s.distM / (v / 3.6);
      movingSec += sec;
      if (s.dh > 0) { climbSec += sec; climbGain += s.dh; }
      return { ...s, vKmh: v, sec };
    });
    const distKm = points.length ? points[points.length - 1].dist : 0;
    const avgSpeed = movingSec > 0 ? distKm / (movingSec / 3600) : 0;
    const vam = climbSec > 0 ? climbGain / (climbSec / 3600) : 0; // m/h
    const avgPower = usePower ? profile.ftp * profile.intensity : null;
    const wkg = avgPower ? avgPower / profile.riderWeight : null;
    return { segTimes, movingSec, avgSpeed, vam, avgPower, wkg };
  }

  // 主要クライムの自動検出＋区間VAM（プロミネンス/ブリッジ方式）
  // 谷→頂を1本の登りとみなし、途中の小さな下り(<=bridge)はまたいで継続。
  // 平均勾配の下限は設けず「獲得標高」で主要度を判定 → 緩やかな長い登りも拾える。
  //   minGain: 主要とみなす最小獲得(m), minKm: 最小距離, bridge: 途中の下り許容(m)
  function detectClimbs(points, segTimes, opt = {}) {
    const minGain = opt.minGain ?? 160, minKm = opt.minKm ?? 2, bridge = opt.bridge ?? 25;
    const climbs = []; const n = points.length; let i = 0;
    while (i < n - 1) {
      if (points[i + 1].ele <= points[i].ele) { i++; continue; } // 上り始点(谷)を探す
      let k = i, peakEle = points[i].ele, peakIdx = i;
      while (k < n - 1) {
        if (points[k + 1].ele >= points[k].ele) {
          k++;
          if (points[k].ele > peakEle) { peakEle = points[k].ele; peakIdx = k; }
        } else if (peakEle - points[k + 1].ele <= bridge) {
          k++; // 小さな下りは同一クライムとしてまたぐ
        } else break; // ピークから bridge を超えて下がったら終了
      }
      // 前方の緩斜面をトリム: 実際に登り始める地点(先の win m で startGrade 以上)まで開始を進める
      const win = opt.startWin ?? 300, startGrade = opt.startGrade ?? 0.06;
      let start = i;
      while (start < peakIdx) {
        let w = start;
        while (w < peakIdx && (points[w].dist - points[start].dist) * 1000 < win) w++;
        const segM = (points[w].dist - points[start].dist) * 1000;
        const lg = segM > 0 ? (points[w].ele - points[start].ele) / segM : 0;
        if (lg >= startGrade) break;
        start++;
      }
      const gain = points[peakIdx].ele - points[start].ele;
      const lenKm = points[peakIdx].dist - points[start].dist;
      if (gain >= minGain && lenKm >= minKm) {
        let sec = 0; for (let m = start; m < peakIdx; m++) sec += segTimes[m].sec;
        climbs.push({
          startKm: points[start].dist, endKm: points[peakIdx].dist, lenKm, gain,
          avgGrade: gain / (lenKm * 1000), sec, vam: sec > 0 ? gain / (sec / 3600) : 0
        });
      }
      i = Math.max(k, i + 1);
    }
    return climbs.sort((a, b) => a.startKm - b.startKm);
  }

  return { compute, unifiedSpeed, estimateFtp, estimateCP, powerForDuration, detectClimbs };
})();
