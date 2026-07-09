/* app.js — 画面初期化・イベント配線・全体オーケストレーション */
(() => {
  const $ = id => document.getElementById(id);

  function boot() {
    MapView.init();
    Chart.init(pt => MapView.showCursor(pt), pt => MapView.focus(pt));
    setupTheme();
    setupPanels();
    setupResizers();
    applyPaneVisibility();
    if (State.get('route')) applyRoutePlan();
    hydrateInputs();
    wireEvents();
    if (State.get('route')) { MapView.draw(State.get('route').points); }
    Chart.resize(); // レイアウト(保存済みパネル高さ)適用後にキャンバスを再計測
    setTimeout(() => { MapView.invalidate(); Chart.resize(); Chart.render(); }, 200);
    // 画面リサイズ/回転で地図とグラフを追従
    let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { MapView.invalidate(); Chart.resize(); Chart.render(); }, 200); });
    recompute();
  }

  // 開閉パネル: h3クリックで折りたたみ、状態をlocalStorageに記憶
  let dragCard = null;
  function setupPanels() {
    const side = document.getElementById('side');
    applyPanelOrder(side);
    const collapsed = State.get('settings').collapsed || {};
    side.querySelectorAll('.card[data-panel]').forEach(card => {
      const key = card.dataset.panel;
      if (collapsed[key]) card.classList.add('collapsed');
      const h3 = card.querySelector('h3');
      // 折りたたみ（ハンドル/ボタン以外のクリック）
      h3.addEventListener('click', e => {
        if (e.target.closest('button') || e.target.closest('.drag-handle')) return;
        const isCol = card.classList.toggle('collapsed');
        const c = State.get('settings').collapsed || {};
        c[key] = isCol; State.get('settings').collapsed = c; State.save();
      });
      // ドラッグハンドルを見出しに追加
      if (!h3.querySelector('.drag-handle')) {
        const handle = document.createElement('span');
        handle.className = 'drag-handle'; handle.textContent = '⠿';
        handle.title = 'ドラッグで並べ替え'; handle.setAttribute('draggable', 'true');
        h3.insertBefore(handle, h3.firstChild);
        handle.addEventListener('dragstart', e => {
          dragCard = card; card.classList.add('dragging-card');
          e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key);
        });
        handle.addEventListener('dragend', () => { card.classList.remove('dragging-card'); savePanelOrder(side); });
      }
      card.addEventListener('dragover', e => {
        if (!dragCard || dragCard === card) return;
        e.preventDefault();
        const after = (e.clientY - card.getBoundingClientRect().top) > card.offsetHeight / 2;
        if (after) card.after(dragCard); else card.before(dragCard);
      });
    });
  }
  // テーマ切替（light / cyber）。localStorageに保存。
  function setupTheme() {
    const saved = localStorage.getItem('rts.theme') || 'light';
    applyTheme(saved);
    document.querySelectorAll('#themeSeg button').forEach(b =>
      b.addEventListener('click', () => applyTheme(b.dataset.themeVal)));
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('rts.theme', t);
    document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.themeVal === t));
    // キャンバス(標高)とルート線の色を再反映
    if (typeof Chart !== 'undefined' && Chart.render) Chart.render();
    recompute();
  }

  // 標高グラフ・右ペインの表示/非表示
  function applyPaneVisibility() {
    const s = State.get('settings'), layout = $('layout');
    layout.classList.toggle('no-profile', !!s.hideProfile);
    layout.classList.toggle('no-side', !!s.hideSide);
    $('toggleProfile').classList.toggle('active', !s.hideProfile);
    $('toggleSide').classList.toggle('active', !s.hideSide);
  }
  function togglePane(key) {
    const s = State.get('settings'); s[key] = !s[key]; State.save();
    applyPaneVisibility();
    setTimeout(() => { MapView.invalidate(); Chart.resize(); Chart.render(); }, 60);
  }

  function applyPanelOrder(side) {
    const order = State.get('settings').panelOrder;
    if (!Array.isArray(order)) return;
    order.forEach(key => { const c = side.querySelector(`.card[data-panel="${key}"]`); if (c) side.appendChild(c); });
  }
  function savePanelOrder(side) {
    const order = [...side.querySelectorAll('.card[data-panel]')].map(c => c.dataset.panel);
    State.get('settings').panelOrder = order; State.save();
  }

  // ペインのリサイズ（右ペイン幅・グラフ高さ）。状態はlocalStorageに保存。
  function setupResizers() {
    const layout = $('layout');
    const st = State.get('settings').layout || { sideW: 320, profileH: 220 };
    const applyW = w => layout.style.setProperty('--side-w', Math.round(w) + 'px');
    const applyH = h => layout.style.setProperty('--profile-h', Math.round(h) + 'px');
    applyW(st.sideW); applyH(st.profileH);

    function drag(handle, onMove) {
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        handle.classList.add('dragging'); document.body.classList.add('resizing');
        const move = ev => { onMove(ev); MapView.invalidate(); Chart.resize(); Chart.render(); };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
          handle.classList.remove('dragging'); document.body.classList.remove('resizing');
          const s = State.get('settings');
          s.layout = {
            sideW: parseInt(getComputedStyle(layout).getPropertyValue('--side-w')) || 320,
            profileH: parseInt(getComputedStyle(layout).getPropertyValue('--profile-h')) || 220
          };
          State.save(); MapView.invalidate(); Chart.resize(); Chart.render();
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
    }
    drag($('vhandle'), ev => {
      const w = layout.getBoundingClientRect().right - ev.clientX - 3;
      applyW(Math.max(220, Math.min(640, w)));
    });
    drag($('hhandle'), ev => {
      const h = layout.getBoundingClientRect().bottom - ev.clientY - 3;
      applyH(Math.max(120, Math.min(560, h)));
    });
  }

  // 保存値をフォームへ反映
  function hydrateInputs() {
    const pf = State.get('profile'), plan = State.get('plan'), st = State.get('settings');
    $('startTime').value = plan.startTime;
    $('height').value = pf.height ?? 170;
    $('ftp').value = pf.ftp; $('intensity').value = Math.round(pf.intensity * 100);
    $('riderWeight').value = pf.riderWeight; $('bikeWeight').value = pf.bikeWeight;
    $('gearWeight').value = pf.gearWeight ?? 2;
    $('cda').value = pf.cda; $('crr').value = pf.crr; $('rho').value = pf.rho;
    $('windSpeed').value = pf.wind?.speed ?? 0; $('windDir').value = pf.wind?.dir ?? 0;
    $('zftp').value = pf.ftp || '';
    $('zmap').value = pf.zmap ?? '';
    $('vo2max').value = pf.vo2max ?? '';
    document.querySelectorAll('input[data-peak]').forEach(inp => {
      inp.value = pf.peaks?.[inp.dataset.peak] ?? '';
    });
    // クライム検出条件（設定ダイアログ）
    $('climbMinGain').value = pf.climbMinGain ?? 120;
    $('climbStartGrade').value = Math.round((pf.climbStartGrade ?? 0.04) * 1000) / 10;
    // Strava取り込み条件（設定ダイアログ・システム設定）
    const f = st.importFilter || {};
    $('minKm').value = f.minKm ?? 15;
    $('excludeKw').value = f.excludeKeyword ?? '通勤';
    $('maxDays').value = f.maxDays ?? 0;
    $('timeMarkerMin').value = st.timeMarkerMin ?? 30;
    $('cornerG').value = st.cornerG ?? 0.40;
    $('fatigue').value = st.fatigue ?? 0;
    // 信号停止（ルート単位）
    $('signalRate').value = plan.signalRate ?? 19;
    if (State.get('route')) $('routeName').textContent = State.get('route').name;
    renderStops();
    renderCalib();
    updateTargetW(); updateDerived();
  }

  // Strava校正結果の表示
  function renderCalib() {
    const pf = State.get('profile');
    const box = $('calibResult');
    if (!pf.calibration) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const c = pf.calibration;
    const rows = Importer.BUCKETS.map(b => {
      const sp = (pf.flatSpeed * (pf.factors[b.key] ?? 1)).toFixed(1);
      return `<tr><td>${b.label}</td><td>${sp} km/h</td><td class="muted">n=${c.counts[b.key] || 0}</td></tr>`;
    }).join('');
    box.classList.remove('hidden');
    box.innerHTML =
      `<div>校正済 (${c.usableTracks}走行 / 標本${c.sampleN}) 平地=${pf.flatSpeed}km/h</div>
       <table>${rows}</table>`;
  }

  // プロファイル入力を読み取り State に格納
  function readProfile() {
    const pf = State.get('profile');
    pf.height = +$('height').value || pf.height;
    pf.ftp = +$('ftp').value; pf.intensity = (+$('intensity').value) / 100;
    pf.riderWeight = +$('riderWeight').value; pf.bikeWeight = +$('bikeWeight').value;
    pf.gearWeight = +$('gearWeight').value || 0;
    pf.cda = +$('cda').value; pf.crr = +$('crr').value; pf.rho = +$('rho').value;
    pf.wind = { speed: +$('windSpeed').value || 0, dir: +$('windDir').value || 0 };
    State.save();
    updateTargetW(); updateDerived();
  }

  // 目標パワー(W) = FTP × 目標強度 を表示
  function updateTargetW() {
    const pf = State.get('profile');
    const w = Math.round((pf.ftp || 0) * (pf.intensity || 0));
    $('targetW').textContent = `目標パワー: ${w} W（${pf.ftp || 0}W × ${Math.round((pf.intensity || 0) * 100)}%）`;
  }

  // 推定値: 合計重量 / パワーウェイト / 推定VAM(8%) / 推定FTP(登坂実績)
  function updateDerived() {
    const pf = State.get('profile');
    const total = (pf.riderWeight || 0) + (pf.bikeWeight || 0) + (pf.gearWeight || 0);
    $('dTotalW').textContent = total.toFixed(1) + ' kg';
    $('dWkg').textContent = (pf.ftp && pf.riderWeight) ? (pf.ftp / pf.riderWeight).toFixed(2) + ' W/kg' : '–';
    const v = Models.unifiedSpeed(0.08, pf);
    $('myVam').textContent = Math.round(v * Math.sin(Math.atan(0.08)) * 1000) + ' m/h';
    const cpw = Models.estimateCP(pf.peaks);
    if (cpw) {
      $('dEstFtp').textContent = `${cpw.cp} W (CP)`;
      $('dEstFtp').title = `Critical Power=${cpw.cp}W / W'=${(cpw.wprime / 1000).toFixed(1)}kJ（ピークパワーから推定）`;
    } else {
      const est = Models.estimateFtp(pf);
      $('dEstFtp').textContent = est ? est + ' W' : '– (ピーク or Strava校正)';
      $('dEstFtp').title = '登坂実績 or ピークパワーから推定';
    }
  }

  // 滞在ポイントUI
  function renderStops() {
    const list = $('stopList');
    const stops = State.get('plan').stops;
    list.innerHTML = '';
    stops.forEach((s, idx) => {
      const row = document.createElement('div'); row.className = 'stop-row';
      row.innerHTML =
        `<input type="text" placeholder="ラベル(例:補給)" value="${(s.label || '').replace(/"/g, '&quot;')}">
         <input type="number" step="0.1" placeholder="km" value="${s.distKm ?? ''}">
         <input type="number" step="1" placeholder="分" value="${s.durationMin ?? ''}">
         <button title="削除">✕</button>`;
      const [lEl, dEl, mEl, del] = row.children;
      lEl.oninput = () => { s.label = lEl.value; persistRoutePlan(); recompute(); };
      dEl.oninput = () => { s.distKm = parseFloat(dEl.value); persistRoutePlan(); recompute(); };
      mEl.oninput = () => { s.durationMin = parseFloat(mEl.value); persistRoutePlan(); recompute(); };
      del.onclick = () => { stops.splice(idx, 1); persistRoutePlan(); renderStops(); recompute(); };
      list.appendChild(row);
    });
  }

  // 全再計算 → サマリ・チャート更新
  function recompute() {
    const route = State.get('route');
    if (!route || !route.points || route.points.length < 2) { Chart.setData(null); return; }
    const pf = State.get('profile'), plan = State.get('plan'), sset = State.get('settings');
    const st = Route.stats(route.points);
    const res = Models.compute(route.points, pf, { cornerG: sset.cornerG ?? 0.40, fatigue: (sset.fatigue ?? 0) / 100 });
    const rate = plan.signalRate ?? 19;
    const sched = Schedule.build(route.points, res.segTimes, plan.stops, rate);
    const totalSec = res.movingSec + sched.stopSec + sched.signalSec;
    const startSec = Schedule.parseTime(plan.startTime);

    $('sDist').textContent = st.distKm.toFixed(1) + ' km';
    $('sGain').textContent = Math.round(st.gain) + ' m';
    $('sTotal').textContent = Schedule.fmtDur(totalSec);
    $('sArrive').textContent = Schedule.fmtClock(startSec, totalSec);
    $('sSignal').textContent = Schedule.fmtDur(sched.signalSec);
    $('sStop').textContent = Schedule.fmtDur(sched.stopSec);

    const minGain = pf.climbMinGain || 120;
    const startGrade = pf.climbStartGrade ?? 0.04;
    const climbs = Models.detectClimbs(route.points, res.segTimes, { minGain, startGrade });
    renderClimbs(climbs, route.points, sched, startSec, minGain);
    const markers = buildTimeMarkers(route.points, sched.arrive, startSec, State.get('settings').timeMarkerMin);
    MapView.drawClimbs(route.points, climbs);
    MapView.drawStops(route.points, plan.stops);
    MapView.drawTimeMarkers(markers);
    Chart.setData({ points: route.points, arrive: sched.arrive, startSec, stops: plan.stops, climbs, markers });
  }

  // 経過時間マーカー。スタート/ゴール＋interval分おき。到達経過(arrive)を反転して位置を求める。
  function buildTimeMarkers(points, arrive, startSec, intervalMin) {
    if (!points.length || !arrive.length) return [];
    const total = arrive[arrive.length - 1] || 0;
    const mk = (e, kind, name) => {
      let idx = 1; while (idx < arrive.length && arrive[idx] < e) idx++;
      const i = Math.min(idx, points.length - 1);
      const a0 = arrive[i - 1], a1 = arrive[i], r = a1 > a0 ? (e - a0) / (a1 - a0) : 0;
      const p0 = points[i - 1] || points[0], p1 = points[i];
      return {
        distKm: p0.dist + r * (p1.dist - p0.dist),
        lat: p0.lat + r * (p1.lat - p0.lat),
        lng: p0.lng + r * (p1.lng - p0.lng),
        ele: p0.ele + r * (p1.ele - p0.ele),
        elapsed: e, clock: Schedule.fmtClock(startSec, e), elapsedStr: Schedule.fmtDur(e), kind, name
      };
    };
    const out = [];
    out.push({ distKm: points[0].dist, lat: points[0].lat, lng: points[0].lng, ele: points[0].ele, elapsed: 0, clock: Schedule.fmtClock(startSec, 0), elapsedStr: '0分', kind: 'start', name: 'スタート' });
    const T = (intervalMin > 0 ? intervalMin : 0) * 60;
    if (T) for (let e = T; e < total - 30 && out.length < 300; e += T) out.push(mk(e, 'time'));
    const last = points[points.length - 1];
    out.push({ distKm: last.dist, lat: last.lat, lng: last.lng, ele: last.ele, elapsed: total, clock: Schedule.fmtClock(startSec, total), elapsedStr: Schedule.fmtDur(total), kind: 'goal', name: 'ゴール' });
    return out;
  }

  // 主要クライムの一覧（距離/獲得/平均勾配/VAM/通過時刻）
  function renderClimbs(allClimbs, points, sched, startSec) {
    const box = $('climbs');
    const climbs = allClimbs.slice(0, 12);
    if (!climbs.length) { box.innerHTML = '<div class="sub">検出条件に該当するクライムなし（⚙設定で調整可）</div>'; return; }
    box.innerHTML = climbs.map((c, idx) => {
      const t0 = Schedule.fmtClock(startSec, Schedule.timeAtDist(points, sched.arrive, c.startKm));
      return `<div class="climb">
        <b>${idx + 1}. ${c.startKm.toFixed(1)}–${c.endKm.toFixed(1)}km</b>
        ${c.lenKm.toFixed(1)}km / +${Math.round(c.gain)}m / ${(c.avgGrade * 100).toFixed(1)}%
        <div class="sub">VAM ${Math.round(c.vam)} m/h ・ ${Schedule.fmtDur(c.sec)} ・ 取付 ${t0}</div>
      </div>`;
    }).join('');
  }

  // ルート単位の識別キー（同じGPX/URLを再読込しても一致）
  function routeKey(route) {
    if (!route || !route.points || !route.points.length) return null;
    const last = route.points[route.points.length - 1];
    return `${route.source}|${route.name}|${last.dist.toFixed(1)}|${route.points.length}`;
  }
  // 現在ルートに紐づく plan(開始時刻/滞在/信号レート) を復元。無ければ既定。
  function applyRoutePlan() {
    const key = routeKey(State.get('route'));
    const rd = State.get('routeData') || {};
    const p = State.get('plan');
    if (key && rd[key]) {
      const s = rd[key];
      p.startTime = s.startTime || '07:00';
      p.stops = Array.isArray(s.stops) ? s.stops : [];
      p.signalRate = s.signalRate ?? 19;
    } else {
      p.startTime = '07:00'; p.stops = []; p.signalRate = 19;
    }
    State.save();
  }
  // 現在ルートの plan を routeData に保存（ルート単位）
  function persistRoutePlan() {
    const key = routeKey(State.get('route'));
    if (key) {
      const rd = State.get('routeData'); const p = State.get('plan');
      rd[key] = { startTime: p.startTime, stops: p.stops, signalRate: p.signalRate };
    }
    State.save();
  }

  // ルート読込後の共通処理
  function onRouteLoaded(route) {
    State.set('route', route);
    $('routeName').textContent = route.name;
    applyRoutePlan();
    $('startTime').value = State.get('plan').startTime;
    $('signalRate').value = State.get('plan').signalRate ?? 19;
    renderStops();
    MapView.draw(route.points);
    setTimeout(() => MapView.invalidate(), 100);
    recompute();
  }

  function wireEvents() {
    // GPX
    $('gpxInput').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      try { onRouteLoaded(Route.parseGpx(await file.text())); }
      catch (err) { alert('GPX読込エラー: ' + err.message); }
      e.target.value = '';
    });

    // 開始時刻
    $('startTime').addEventListener('input', () => { State.get('plan').startTime = $('startTime').value; persistRoutePlan(); recompute(); });

    // 信号停止レート（ルート単位）
    $('signalRate').addEventListener('input', () => {
      State.get('plan').signalRate = +$('signalRate').value || 0; persistRoutePlan(); recompute();
    });

    // 経過時間マーカー間隔（設定ダイアログ）
    $('timeMarkerMin').addEventListener('input', () => { State.get('settings').timeMarkerMin = +$('timeMarkerMin').value || 0; State.save(); recompute(); });
    // 下りコーナリング上限・疲労減衰
    $('cornerG').addEventListener('input', () => { State.get('settings').cornerG = +$('cornerG').value || 0; State.save(); recompute(); });
    $('fatigue').addEventListener('input', () => { State.get('settings').fatigue = +$('fatigue').value || 0; State.save(); recompute(); });

    // 主要クライム検出条件（設定ダイアログ・ユーザー単位）
    $('climbMinGain').addEventListener('change', () => { State.get('profile').climbMinGain = +$('climbMinGain').value || 120; State.save(); recompute(); });
    $('climbStartGrade').addEventListener('change', () => { State.get('profile').climbStartGrade = (+$('climbStartGrade').value || 0) / 100; State.save(); recompute(); });

    // Strava取り込み条件（設定ダイアログ・システム設定を保存）
    ['minKm', 'excludeKw', 'maxDays'].forEach(id => $(id).addEventListener('input', () => {
      const s = State.get('settings'); s.importFilter = s.importFilter || {};
      s.importFilter.minKm = +$('minKm').value || 0;
      s.importFilter.excludeKeyword = $('excludeKw').value.trim();
      s.importFilter.maxDays = +$('maxDays').value || 0;
      State.save();
    }));

    // パラメータ変更
    ['height', 'ftp', 'intensity', 'riderWeight', 'bikeWeight', 'gearWeight', 'cda', 'crr', 'rho', 'windSpeed', 'windDir']
      .forEach(id => $(id).addEventListener('input', () => { readProfile(); recompute(); }));

    // Zwift 指標
    $('zftp').addEventListener('input', () => {
      const v = +$('zftp').value; const pf = State.get('profile');
      if (v) { pf.ftp = v; $('ftp').value = v; } State.save(); updateTargetW(); updateDerived(); recompute();
    });
    $('zmap').addEventListener('input', () => { State.get('profile').zmap = +$('zmap').value || null; State.save(); });
    $('vo2max').addEventListener('input', () => { State.get('profile').vo2max = +$('vo2max').value || null; State.save(); });
    document.querySelectorAll('input[data-peak]').forEach(inp => {
      inp.addEventListener('input', () => {
        const pf = State.get('profile'); pf.peaks = pf.peaks || {};
        pf.peaks[inp.dataset.peak] = +inp.value || null; State.save();
      });
    });

    // Strava 校正
    $('stravaInput').addEventListener('change', async e => {
      const files = [...e.target.files]; if (!files.length) return;
      const f = State.get('settings').importFilter || {};
      const pf0 = State.get('profile');
      const mass = (pf0.riderWeight || 68) + (pf0.bikeWeight || 9) + (pf0.gearWeight || 2);
      const minKm = f.minKm ?? 15, excludeKeyword = f.excludeKeyword ?? '', maxDays = f.maxDays ?? 0;
      const box = $('calibResult');
      box.classList.remove('hidden');
      box.innerHTML = `取り込み中… 0 / ${files.length}`;
      try {
        const cal = await Importer.calibrateFiles(files, { minKm, excludeKeyword, maxDays, mass },
          (done, total, usable) => { box.innerHTML = `解析中… ${done} / ${total}（有効 ${usable} 本）`; });
        if (!cal.usableTracks) throw new Error('時刻付きの実走データがありません（GPX/TCXに時刻が必要）');
        const pf = State.get('profile');
        pf.flatSpeed = cal.flatSpeed; pf.factors = cal.factors;
        pf.calibration = { usableTracks: cal.usableTracks, sampleN: cal.sampleN, counts: cal.counts, skipped: cal.skipped };
        // パワーFITがあれば CP(ピーク) / CdA / Crr を自動適用
        let pmsg = '';
        if (cal.power && cal.power.hasPower) {
          pf.peaks = pf.peaks || {};
          for (const k in cal.power.peaks) pf.peaks[k] = cal.power.peaks[k];
          document.querySelectorAll('input[data-peak]').forEach(inp => { if (pf.peaks[inp.dataset.peak] != null) inp.value = pf.peaks[inp.dataset.peak]; });
          const parts = ['ピーク更新'];
          if (cal.power.cda) { pf.cda = cal.power.cda; $('cda').value = cal.power.cda; parts.push('CdA=' + cal.power.cda); }
          if (cal.power.crr) { pf.crr = cal.power.crr; $('crr').value = cal.power.crr; parts.push('Crr=' + cal.power.crr); }
          const cpw = Models.estimateCP(pf.peaks);
          if (cpw) parts.push('CP=' + cpw.cp + 'W');
          pmsg = `<div class="muted">パワー自動推定: ${parts.join(' / ')}（標本${cal.power.samplesN}）</div>`;
        }
        State.save(); renderCalib(); updateDerived(); recompute();
        if (pmsg) box.insertAdjacentHTML('beforeend', pmsg);
      } catch (err) {
        box.innerHTML = 'エラー: ' + err.message;
      }
      e.target.value = '';
    });
    $('clearCalib').addEventListener('click', () => {
      const pf = State.get('profile'); pf.factors = {}; pf.calibration = null;
      State.save(); renderCalib(); updateDerived(); recompute();
    });

    // 滞在追加
    $('addStop').addEventListener('click', () => {
      State.get('plan').stops.push({ distKm: 0, durationMin: 10, label: '' });
      persistRoutePlan(); renderStops(); recompute();
    });

    // ペイン表示切替
    $('toggleProfile').addEventListener('click', () => togglePane('hideProfile'));
    $('toggleSide').addEventListener('click', () => togglePane('hideSide'));

    // ヘルプモーダル
    $('helpBtn').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
    $('closeHelp').addEventListener('click', () => $('helpModal').classList.add('hidden'));
    $('helpModal').addEventListener('click', e => { if (e.target.id === 'helpModal') $('helpModal').classList.add('hidden'); });

    // 設定モーダル
    $('settingsBtn').addEventListener('click', () => $('settingsModal').classList.remove('hidden'));
    $('closeSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
    $('resetBtn').addEventListener('click', () => {
      if (confirm('保存データを削除して初期化しますか？')) { State.reset(); location.reload(); }
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
