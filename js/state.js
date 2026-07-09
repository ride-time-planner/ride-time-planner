/* state.js — localStorage への保存/復元を一元管理 */
const State = (() => {
  const KEYS = { route: 'rts.route', plan: 'rts.plan', profile: 'rts.profile', settings: 'rts.settings', routeData: 'rts.routeData' };

  const defaults = {
    // plan = 現在ルートの作業用（ルート単位でrouteDataに保存/復元）
    plan: { startTime: '07:00', stops: [], signalRate: 19 },
    profile: {
      flatSpeed: 25,
      height: 170, ftp: 250, intensity: 0.75, riderWeight: 68, bikeWeight: 9, gearWeight: 2,
      cda: 0.32, crr: 0.005, rho: 1.225,
      // Zwift 指標（手動入力・参考値）
      zmap: null, vo2max: null,
      // ピークパワー(W)。キー=継続時間。現状は参考情報として保存のみ。
      peaks: { '5s': null, '15s': null, '30s': null, '1m': null, '3m': null, '5m': null, '10m': null, '12m': null, '15m': null, '20m': null, '30m': null, '40m': null },
      // 向かい風（パワーモデル用）: speed km/h, dir=吹いてくる方位°
      wind: { speed: 0, dir: 0 },
      // 主要クライム判定: 最小獲得(m) と 開始勾配しきい値(比率)
      climbMinGain: 160,
      climbStartGrade: 0.06,
      // Strava 校正結果（勾配バケット別係数）。未校正なら空。
      factors: {}, calibration: null
    },
    // settings = システム設定（ルートで変わらない。保存データ削除以外ではリセットされない）
    settings: {
      // 初期の並び順と開閉（あなたの情報/Zwift/Stravaは閉じた状態）
      panelOrder: ['climbs', 'signal', 'stops', 'rider', 'zwift', 'strava'],
      collapsed: { rider: true, zwift: true, strava: true },
      layout: { sideW: 320, profileH: 230 },
      hideProfile: false, hideSide: false,
      timeMarkerMin: 30, // 経過時間マーカーの間隔(分, 0=非表示)
      cornerG: 0.40,     // 下りのコーナリング上限（横加速度, g）
      fatigue: 3.0,      // 疲労減衰（%/時, 2時間以降。検証で長距離の誤差を大幅改善）
      importFilter: { minKm: 15, excludeKeyword: '通勤', maxDays: 730 }
    },
    routeData: {}, // ルート単位の {startTime, stops, signalRate} を key で保持
    route: null
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(KEYS[key]);
      return raw ? JSON.parse(raw) : structuredClone(fallback);
    } catch (e) { return structuredClone(fallback); }
  }
  function write(key, value) {
    try { localStorage.setItem(KEYS[key], JSON.stringify(value)); }
    catch (e) { console.warn('保存失敗', key, e); }
  }

  // メモリ上の現在状態
  const data = {
    route: read('route', defaults.route),
    plan: read('plan', defaults.plan),
    profile: read('profile', defaults.profile),
    settings: read('settings', defaults.settings),
    routeData: read('routeData', defaults.routeData)
  };

  return {
    data,
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; write(k, v); },
    save() { for (const k of Object.keys(KEYS)) write(k, data[k]); },
    reset() { for (const k of Object.keys(KEYS)) localStorage.removeItem(KEYS[k]); }
  };
})();
