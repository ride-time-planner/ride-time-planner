/* fit.js — Garmin/Wahoo/Zwift 等の .FIT バイナリを解析（record メッセージのみ抽出） */
const FitParser = (() => {
  const SC = 180 / Math.pow(2, 31);      // semicircles → 度
  const FIT_EPOCH = 631065600;           // 1989-12-31 と 1970-01-01 の差(秒)
  const SIGNED = new Set([1, 3, 5, 14]); // base type: sint8/16/32/64

  function readInt(dv, off, size, signed, le) {
    if (size === 4) return signed ? dv.getInt32(off, le) : dv.getUint32(off, le);
    if (size === 2) return signed ? dv.getInt16(off, le) : dv.getUint16(off, le);
    if (size === 1) return signed ? dv.getInt8(off) : dv.getUint8(off);
    return null; // 配列/文字列などは対象外
  }

  // 1つのデータメッセージを読み、フィールド番号→整数値 のマップを返す
  function readData(dv, pos, d) {
    const vals = {};
    for (const f of d.fields) {
      if (f.fn >= 0) vals[f.fn] = readInt(dv, pos, f.sz, SIGNED.has(f.bt & 0x1F), d.le);
      pos += f.sz;
    }
    return { pos, vals };
  }

  function pushRec(points, v) {
    const lat = v[0], lng = v[1];
    if (lat == null || lng == null) return;
    if (lat === 0x7FFFFFFF || lng === 0x7FFFFFFF) return; // invalid
    const p = { lat: lat * SC, lng: lng * SC };
    const ealt = v[78], alt = v[2];
    if (ealt != null && ealt !== 0xFFFFFFFF) p.ele = ealt / 5 - 500;
    else if (alt != null && alt !== 0xFFFF) p.ele = alt / 5 - 500;
    else p.ele = NaN;
    p.t = v[253] != null ? (v[253] + FIT_EPOCH) * 1000 : NaN; // ms epoch
    // デバイス積算距離(field5, cm単位ではなく 1/100 m)。GPS距離の膨張回避に使用。
    const dd = v[5];
    if (dd != null && dd !== 0xFFFFFFFF) p.dev = dd / 100; // m
    // パワー(field7, W) / 速度(field6, 1/1000 m/s) ← CdA/CP 自動推定に使用
    if (v[7] != null && v[7] !== 0xFFFF) p.pw = v[7];
    if (v[6] != null && v[6] !== 0xFFFF) p.spd = v[6] / 1000;
    points.push(p);
  }

  // bytes: Uint8Array → 点列[{lat,lng,ele,t}]
  function parse(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hsize = dv.getUint8(0);
    const dsize = dv.getUint32(4, true);
    if (String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== '.FIT')
      throw new Error('FIT署名がありません');
    let pos = hsize; const end = Math.min(hsize + dsize, bytes.length);
    const defs = {}; const points = [];
    while (pos < end) {
      const h = dv.getUint8(pos); pos++;
      if (h & 0x80) { // 圧縮タイムスタンプヘッダ
        const d = defs[(h >> 5) & 0x3]; if (!d) break;
        const r = readData(dv, pos, d); pos = r.pos;
        if (d.gnum === 20) pushRec(points, r.vals);
      } else if (h & 0x40) { // 定義メッセージ
        const lmt = h & 0x0F;
        pos++; // reserved
        const arch = dv.getUint8(pos); pos++;
        const le = arch === 0;
        const gnum = dv.getUint16(pos, le); pos += 2;
        const nf = dv.getUint8(pos); pos++;
        const fields = [];
        for (let i = 0; i < nf; i++) { fields.push({ fn: dv.getUint8(pos), sz: dv.getUint8(pos + 1), bt: dv.getUint8(pos + 2) }); pos += 3; }
        if (h & 0x20) { const ndf = dv.getUint8(pos); pos++; for (let i = 0; i < ndf; i++) { fields.push({ fn: -1, sz: dv.getUint8(pos + 1), bt: 0 }); pos += 3; } }
        defs[lmt] = { le, gnum, fields };
      } else { // データメッセージ
        const d = defs[h & 0x0F]; if (!d) break;
        const r = readData(dv, pos, d); pos = r.pos;
        if (d.gnum === 20) pushRec(points, r.vals);
      }
    }
    return points;
  }

  return { parse };
})();
