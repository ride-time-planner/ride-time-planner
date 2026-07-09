/* schedule.js — 開始時刻+滞在時間から各点の到達時刻(経過秒)を計算 */
const Schedule = (() => {

  // "HH:MM" → 当日0時からの秒
  function parseTime(hhmm) {
    const [h, m] = (hhmm || '07:00').split(':').map(Number);
    return (h * 3600 + m * 60);
  }
  // 秒(経過含む) → "H:MM"（24h超は繰り越し表記）
  function fmtClock(startSec, elapsedSec) {
    const total = startSec + elapsedSec;
    const day = Math.floor(total / 86400);
    const t = total % 86400;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    const base = `${h}:${String(m).padStart(2, '0')}`;
    return day > 0 ? `+${day}日 ${base}` : base;
  }
  function fmtDur(sec) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h}時間${m}分` : `${m}分`;
  }

  // 勾配による信号停止の減衰係数。平地〜登りは1.0、下りは信号が少ないので低減。
  //   grade >= -1%: 1.0 / -1%〜-4%: 1→0 に線形 / -4%以下: 0
  function signalFactor(grade) {
    if (grade == null) return 1;
    if (grade >= -0.01) return 1;
    if (grade <= -0.04) return 0;
    return (grade + 0.04) / 0.03;
  }

  // 各点の累積経過秒（走行+滞在）を算出。
  // stops: [{distKm, durationMin}] — その距離を通過した直後に滞在を加算
  // signalSecPerKm: エリア別の信号停止(秒/km)。各区間で距離×レートを加算。
  function build(points, segTimes, stops, signalSecPerKm = 0) {
    const arrive = new Array(points.length).fill(0); // 各点への到達経過秒
    const sortedStops = [...(stops || [])]
      .filter(s => s && isFinite(s.distKm) && isFinite(s.durationMin))
      .sort((a, b) => a.distKm - b.distKm);
    let si = 0, elapsed = 0, signalSec = 0;
    for (let i = 1; i < points.length; i++) {
      elapsed += segTimes[i - 1].sec;
      // 信号停止（区間距離に比例）。下りは信号が少ないため勾配で減衰。
      const segKm = points[i].dist - points[i - 1].dist;
      const sig = segKm * signalSecPerKm * signalFactor(segTimes[i - 1].grade);
      elapsed += sig; signalSec += sig;
      // この区間を終えた地点(points[i].dist)までに含まれる滞在を加算
      while (si < sortedStops.length && sortedStops[si].distKm <= points[i].dist) {
        elapsed += sortedStops[si].durationMin * 60;
        si++;
      }
      arrive[i] = elapsed;
    }
    let extraStop = 0;
    while (si < sortedStops.length) { extraStop += sortedStops[si].durationMin * 60; si++; }
    return { arrive, stopSec: sortedStops.reduce((a, s) => a + s.durationMin * 60, 0), signalSec, extraStop };
  }

  // 距離(km)に対応する到達経過秒を線形補間
  function timeAtDist(points, arrive, distKm) {
    if (!points.length) return 0;
    if (distKm <= points[0].dist) return arrive[0];
    for (let i = 1; i < points.length; i++) {
      if (points[i].dist >= distKm) {
        const d0 = points[i - 1].dist, d1 = points[i].dist;
        const r = d1 > d0 ? (distKm - d0) / (d1 - d0) : 0;
        return arrive[i - 1] + r * (arrive[i] - arrive[i - 1]);
      }
    }
    return arrive[arrive.length - 1];
  }

  return { parseTime, fmtClock, fmtDur, build, timeAtDist };
})();
