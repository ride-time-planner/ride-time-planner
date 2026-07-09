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
  function speedPower(grade, p, hw = 0) {
    const P = p.ftp * p.intensity;
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
  function unifiedSpeed(grade, p, hw = 0) {
    const hasCal = p.factors && Object.keys(p.factors).length;
    const hasFtp = p.ftp > 0;
    const vs = speedSimple(grade, p);        // 校正 or 既定テーブル
    const vp = speedPower(grade, p, hw);     // 物理(FTP)
    if (hasCal && hasFtp) return 0.5 * vs + 0.5 * vp;
    if (hasCal) return vs;
    if (hasFtp) return vp;
    return vs;
  }

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

  // 区間ごとの所要秒を計算 → {segTimes[], movingSec, avgSpeed, vam, avgPower}
  function compute(points, profile) {
    const segs = Route.segments(points);
    const wind = (profile.wind && profile.wind.speed) ? profile.wind : null;
    const windMs = wind ? wind.speed / 3.6 : 0;
    const usePower = profile.ftp > 0;
    let movingSec = 0, climbSec = 0, climbGain = 0;
    const segTimes = segs.map(s => {
      let hw = 0;
      if (wind) {
        const diff = (((s.bearing - wind.dir + 540) % 360) - 180) * Math.PI / 180; // 進行方位 vs 風の吹いてくる方位
        hw = windMs * Math.cos(diff); // + = 向かい風
      }
      const vKmh = unifiedSpeed(s.grade, profile, hw);
      const sec = s.distM / (vKmh / 3.6);
      movingSec += sec;
      if (s.dh > 0) { climbSec += sec; climbGain += s.dh; }
      return { ...s, vKmh, sec };
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

  return { compute, unifiedSpeed, estimateFtp, detectClimbs };
})();
