// Odds Desk quant engine: technical strategies, per-coin walk-forward backtest,
// entry/exit levels and the "could run hard" flag. Pure functions, no DOM.
(function (root) {
  'use strict';
  const H = 7;                 // forecast horizon in days (matches the 7-day odds)
  const WARMUP = 55;           // days needed before every indicator is valid
  const BASE_FUNDING = 0.0000125; // Hyperliquid's neutral hourly funding rate
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pct = x => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

  function ema(a, n) {
    const k = 2 / (n + 1), out = new Array(a.length);
    let e = a[0];
    for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function rsi(c, n = 14) {
    const out = new Array(c.length).fill(50);
    let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
      if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function meanStd(c, from, to) { // inclusive range
    let s = 0, s2 = 0, n = to - from + 1;
    for (let j = from; j <= to; j++) { s += c[j]; s2 += c[j] * c[j]; }
    const m = s / n;
    return [m, Math.sqrt(Math.max(0, s2 / n - m * m))];
  }
  function rangeMinMax(c, from, to) {
    let lo = Infinity, hi = -Infinity;
    for (let j = from; j <= to; j++) { if (c[j] < lo) lo = c[j]; if (c[j] > hi) hi = c[j]; }
    return [lo, hi];
  }

  // Each strategy returns [vote in -1..1, plain-English reading] using only data up to day i.
  const STRATS = [
    { key: 'trend', name: 'Trend vs 50-day average', style: 'trend',
      fn: (c, i, X) => { const x = c[i] / X.e50[i] - 1; return [clamp(x / 0.10, -1, 1), pct(x) + ' vs 50-day avg']; } },
    { key: 'cross', name: '20/50-day average cross', style: 'trend',
      fn: (c, i, X) => { const x = X.e20[i] / X.e50[i] - 1; return [clamp(x / 0.05, -1, 1), (x >= 0 ? '20-day above 50-day (' : '20-day below 50-day (') + pct(x) + ')']; } },
    { key: 'mom30', name: '30-day momentum', style: 'trend',
      fn: (c, i) => { const r = c[i] / c[i - 30] - 1; return [clamp(r / 0.20, -1, 1), pct(r) + ' in 30 days']; } },
    { key: 'mom7', name: '7-day momentum', style: 'trend',
      fn: (c, i) => { const r = c[i] / c[i - 7] - 1; return [clamp(r / 0.10, -1, 1), pct(r) + ' in 7 days']; } },
    { key: 'macd', name: 'MACD (12/26/9)', style: 'trend',
      fn: (c, i, X) => { const h = X.hist[i], hp = X.hist[i - 1]; const v = clamp(h / (c[i] * 0.01), -1, 1) * 0.7 + (h > hp ? 0.3 : -0.3); return [clamp(v, -1, 1), (h >= 0 ? 'above' : 'below') + ' signal line, ' + (h > hp ? 'rising' : 'falling')]; } },
    { key: 'donch', name: '20-day breakout (Donchian)', style: 'trend',
      fn: (c, i) => { const [lo, hi] = rangeMinMax(c, i - 19, i); const p = hi > lo ? (c[i] - lo) / (hi - lo) : 0.5; return [2 * p - 1, Math.round(p * 100) + '% of 20-day range']; } },
    { key: 'rsi', name: 'RSI(14) mean reversion', style: 'reversion',
      fn: (c, i, X) => { const r = X.rsi[i]; const v = Math.abs(r - 50) < 15 ? 0 : clamp((50 - r) / 25, -1, 1); return [v, 'RSI ' + r.toFixed(0) + (r >= 70 ? ' (overbought)' : r <= 30 ? ' (oversold)' : '')]; } },
    { key: 'boll', name: 'Bollinger band reversion', style: 'reversion',
      fn: (c, i) => { const [m, s] = meanStd(c, i - 19, i); const b = s > 0 ? (c[i] - (m - 2 * s)) / (4 * s) : 0.5; const v = b > 0.85 ? -clamp((b - 0.85) / 0.3, 0, 1) : b < 0.15 ? clamp((0.15 - b) / 0.3, 0, 1) : 0; return [v, '%B ' + b.toFixed(2)]; } },
    { key: 'rs', name: 'Strength vs bitcoin (14-day)', style: 'trend',
      fn: (c, i, X) => {
        if (!X.btcMap) return [0, 'n/a (this is bitcoin)'];
        const b0 = X.btcMap.get(X.days[i - 14]), b1 = X.btcMap.get(X.days[i]);
        if (!b0 || !b1) return [0, 'no bitcoin data'];
        const r = (c[i] / c[i - 14]) - (b1 / b0);
        return [clamp(r / 0.10, -1, 1), pct(r) + ' vs BTC'];
      } }
  ];

  function analyze(days, c, vols, btcMap) {
    const n = c.length;
    if (n < WARMUP + H + 60) return null;
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const macd = c.map((_, i) => e12[i] - e26[i]), sig = ema(macd, 9);
    const X = { e20: ema(c, 20), e50: ema(c, 50), rsi: rsi(c), hist: macd.map((m, i) => m - sig[i]), days, btcMap };
    const votes = STRATS.map(() => new Float64Array(n));
    for (let i = WARMUP; i < n; i++) for (let k = 0; k < STRATS.length; k++) votes[k][i] = STRATS[k].fn(c, i, X)[0];

    // Walk-forward: learn weights on older data, then test on the most recent ~90 days.
    const testStart = Math.max(WARMUP + 60, n - H - 90);
    const hitRate = (k, a, b) => { // days a..b-1 whose 7-day outcome is known
      let hit = 0, cnt = 0;
      for (let i = a; i < b; i++) { const v = votes[k][i]; if (Math.abs(v) < 0.15) continue; cnt++; if ((v > 0) === (c[i + H] > c[i])) hit++; }
      return { hit: cnt ? hit / cnt : 0.5, cnt };
    };
    const train = STRATS.map((_, k) => hitRate(k, WARMUP, testStart - H));
    const weightsFrom = st => st.map(t => (t.cnt >= 20 ? Math.max(0, t.hit - 0.5) : 0));
    const wTrain = weightsFrom(train);
    const composite = (i, w) => { let num = 0, den = 0; for (let k = 0; k < w.length; k++) { num += w[k] * votes[k][i]; den += w[k]; } return den ? num / den : 0; };
    let oHit = 0, oCnt = 0;
    for (let i = testStart; i < n - H; i++) { const s = composite(i, wTrain); if (Math.abs(s) < 0.1) continue; oCnt++; if ((s > 0) === (c[i + H] > c[i])) oHit++; }

    // Live weights use all known history (same rule), applied to today's readings.
    const full = STRATS.map((_, k) => hitRate(k, WARMUP, n - H));
    const w = weightsFrom(full);
    const now = n - 1;
    const S = composite(now, w);
    const readings = STRATS.map((s, k) => { const [v, label] = s.fn(c, now, X); return { key: s.key, name: s.name, style: s.style, vote: v, label, weight: w[k], hit: full[k].hit, cnt: full[k].cnt }; });
    let aNum = 0, aDen = 0;
    readings.forEach(r => { aNum += r.weight * r.vote; aDen += r.weight * Math.abs(r.vote); });
    const agreement = aDen ? Math.abs(aNum) / aDen : 0;

    // Volatility and a close-to-close ATR proxy (average absolute daily move, last 14 days).
    const rets = []; for (let i = n - 30; i < n; i++) rets.push(Math.log(c[i] / c[i - 1]));
    const mr = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mr) ** 2, 0) / (rets.length - 1)) * Math.sqrt(365);
    let atr = 0; for (let i = n - 14; i < n; i++) atr += Math.abs(c[i] - c[i - 1]); atr /= 14;
    const [low20, high20] = rangeMinMax(c, n - 20, n - 1);

    // Volatility squeeze: today's 20-day band width vs the last 180 days.
    const bw = i => { const [m, s] = meanStd(c, i - 19, i); return m ? 4 * s / m : 0; };
    const bwNow = bw(now); let below = 0, tot = 0;
    for (let i = Math.max(19, n - 180); i < n; i++) { tot++; if (bw(i) <= bwNow) below++; }
    const bwPctile = tot ? below / tot : 0.5;

    // Volume surge: last 3 days vs the 30 days before that.
    let volRatio = null;
    if (vols && vols.length === n && n > 34) {
      const avg = (a, b) => { let s = 0; for (let j = a; j <= b; j++) s += vols[j]; return s / (b - a + 1); };
      const base = avg(n - 33, n - 4);
      volRatio = base > 0 ? avg(n - 3, n - 1) / base : null;
    }
    const [plo, phi] = rangeMinMax(c, n - 21, n - 2); // prior 20 days, excluding today

    const oos = oCnt ? oHit / oCnt : 0.5;
    const edge = oCnt >= 15 ? clamp((oos - 0.5) / 0.10, 0, 1) : 0;
    const volPenalty = clamp(1 - (vol - 0.6) / 1.5, 0.5, 1);
    const prob = Math.round(50 + 25 * clamp(S, -1, 1) * Math.max(edge, 0.2));
    const conf = Math.round(100 * agreement * edge * volPenalty);
    return {
      n, price: c[now], S, prob, conf, oos, oosN: oCnt, agreement, edge, vol, volPenalty, atr, low20, high20,
      bwPctile, volRatio, ret3: c[now] / c[now - 3] - 1, ret7: c[now] / c[now - 7] - 1,
      breakoutUp: c[now] > phi, breakoutDown: c[now] < plo, readings
    };
  }

  // Blend the AI odds with the quant read. Returns {bullProb, conf, parts}.
  function blend(ai, q, fundingHourly) {
    let qProb = q.prob, fundNote = null;
    if (fundingHourly != null) {
      if (fundingHourly > 4 * BASE_FUNDING) { qProb -= 3; fundNote = 'Longs are paying a lot to stay in (crowded long), small bearish tilt.'; }
      else if (fundingHourly < 0) { qProb += 3; fundNote = 'Shorts are paying longs (crowded short), small bullish tilt.'; }
    }
    qProb = clamp(qProb, 20, 80);
    if (!ai) return { bullProb: qProb, conf: q.conf, parts: { qProb, qConf: q.conf, fundNote, bonus: 0 } };
    const bullProb = Math.round(0.5 * ai.bull.prob + 0.5 * qProb);
    const aiDir = Math.sign(ai.bull.prob - 50), qDir = Math.sign(qProb - 50);
    const bonus = aiDir && qDir ? (aiDir === qDir ? 8 : -12) : 0;
    const conf = clamp(Math.round(0.5 * ai.conf + 0.5 * q.conf + bonus), 0, 100);
    return { bullProb, conf, parts: { aiProb: ai.bull.prob, aiConf: ai.conf, qProb, qConf: q.conf, fundNote, bonus } };
  }

  // Entry zone, stop and two take-profits from price structure and recent volatility.
  function levels(price, q, long) {
    const atr = q.atr;
    if (!(price > 0) || !(atr > 0)) return null;
    const dir = long ? 1 : -1;
    const entry = price - dir * 0.25 * atr;
    const zone = long ? [price - 0.5 * atr, price] : [price, price + 0.5 * atr];
    let stop = entry - dir * 1.5 * atr, stopRule = '1.5× the average daily move beyond entry';
    const swing = long ? q.low20 - 0.2 * atr : q.high20 + 0.2 * atr;
    const swingDist = dir * (entry - swing);
    if (swingDist >= 1.0 * atr && swingDist <= 2.5 * atr) { stop = swing; stopRule = 'just past the 20-day ' + (long ? 'low' : 'high'); }
    const risk = dir * (entry - stop);
    let tp1 = entry + dir * 1.5 * risk, tp2 = entry + dir * 3 * risk;
    if (!long && tp2 <= 0) tp2 = entry * 0.05;
    if (!long && tp1 <= 0) tp1 = entry * 0.1;
    const riskPct = risk / entry;
    const out = { long, entry, zone, stop, tp1, tp2, risk, riskPct, atr, stopRule,
      tp1Pct: dir * (tp1 / entry - 1), tp2Pct: dir * (tp2 / entry - 1),
      maxLev: Math.max(1, Math.floor(0.8 / riskPct)) };
    out.valid = check(out);
    return out;
  }
  function check(L) {
    const ok = [L.entry, L.stop, L.tp1, L.tp2, L.zone[0], L.zone[1]].every(x => Number.isFinite(x) && x > 0);
    if (!ok) return false;
    return L.long ? (L.stop < L.zone[0] && L.zone[0] <= L.entry && L.entry <= L.zone[1] && L.zone[1] < L.tp1 && L.tp1 < L.tp2)
                  : (L.stop > L.zone[1] && L.zone[1] >= L.entry && L.entry >= L.zone[0] && L.zone[0] > L.tp1 && L.tp1 > L.tp2);
  }

  // "Could run hard": momentum of buying/selling, squeezes, crowding and dated catalysts.
  function runHard(q, fundingHourly, catalysts, todayMs) {
    const up = [], down = [], both = [];
    if (q) {
      if (q.volRatio != null && q.volRatio >= 1.8 && q.ret3 > 0.03) up.push(`Buying surge: volume ${q.volRatio.toFixed(1)}× normal while price rose ${pct(q.ret3)} in 3 days.`);
      if (q.volRatio != null && q.volRatio >= 1.8 && q.ret3 < -0.03) down.push(`Selling surge: volume ${q.volRatio.toFixed(1)}× normal while price fell ${pct(q.ret3)} in 3 days.`);
      if (q.breakoutUp && (q.volRatio == null || q.volRatio >= 1.3)) up.push('Breaking above its 20-day high' + (q.volRatio != null ? ` on ${q.volRatio.toFixed(1)}× volume.` : '.'));
      if (q.breakoutDown && (q.volRatio == null || q.volRatio >= 1.3)) down.push('Breaking below its 20-day low' + (q.volRatio != null ? ` on ${q.volRatio.toFixed(1)}× volume.` : '.'));
      if (q.bwPctile <= 0.10) both.push(`Coiled: price swings are the tightest in ${Math.round(q.bwPctile * 100) <= 5 ? 'about 6 months' : 'months'}, which often comes before a big move.`);
      if (fundingHourly != null && fundingHourly < 0 && q.ret7 > 0) up.push('Short squeeze setup: price is rising while most bets are on a drop.');
      if (fundingHourly != null && fundingHourly > 4 * BASE_FUNDING && q.ret7 < 0) down.push('Long squeeze risk: price is falling while bets on a rise are crowded.');
    }
    const soon = (catalysts || []).filter(e => { const t = Date.parse(e.date); return t && t >= todayMs - 864e5 && t <= todayMs + 14 * 864e5; });
    soon.forEach(e => (e.effect === 'bear' ? down : up).push(`${e.date}: ${e.text}`));
    const score = up.length - down.length;
    let dir = null;
    if (up.length >= 2 || (up.length && !down.length && soon.some(e => e.effect === 'bull'))) dir = 'up';
    if (down.length >= 2 || (down.length && !up.length && soon.some(e => e.effect === 'bear'))) dir = dir === 'up' ? 'both' : 'down';
    if (!dir && both.length) dir = 'both';
    if (!dir && Math.abs(score) >= 1 && (up.length + down.length) >= 1 && (q && q.volRatio != null && q.volRatio >= 2.5)) dir = score > 0 ? 'up' : 'down';
    return { dir, up, down, both, catalysts: soon };
  }

  root.Quant = { analyze, blend, levels, runHard, check, STRATS, H };

  // ===== 10-minute scalp engine (1-minute bars) =====
  // bars: [{o,h,l,c,v}] oldest->newest. Simulates the actual trade: enter at the bar close,
  // take profit or stop on later bars' highs/lows (stop wins ties), otherwise exit at the 10th bar's close.
  const SH = 10, SWARM = 35;
  const SSTRATS = [
    { key: 'ema', name: 'Fast trend (EMA 9 vs 21)', fn: (c, i, X) => { const x = X.e9[i] / X.e21[i] - 1; return [clamp(x / (2 * X.sd1[i] + 1e-12), -1, 1), (x >= 0 ? 'EMA9 above EMA21' : 'EMA9 below EMA21')]; } },
    { key: 'm5', name: '5-minute momentum', fn: (c, i, X) => { const r = c[i] / c[i - 5] - 1; return [clamp(r / (2.2 * X.sd1[i] * Math.sqrt(5) + 1e-12), -1, 1), pct(r) + ' in 5 min']; } },
    { key: 'm15', name: '15-minute momentum', fn: (c, i, X) => { const r = c[i] / c[i - 15] - 1; return [clamp(r / (2.2 * X.sd1[i] * Math.sqrt(15) + 1e-12), -1, 1), pct(r) + ' in 15 min']; } },
    { key: 'rsi', name: 'RSI(14) snap-back', fn: (c, i, X) => { const r = X.rsi[i]; return [Math.abs(r - 50) < 18 ? 0 : clamp((50 - r) / 25, -1, 1), 'RSI ' + r.toFixed(0)]; } },
    { key: 'boll', name: 'Bollinger snap-back', fn: (c, i) => { const [m, s] = meanStd(c, i - 19, i); const b = s > 0 ? (c[i] - (m - 2 * s)) / (4 * s) : 0.5; return [b > 0.9 ? -clamp((b - 0.9) / 0.3, 0, 1) : b < 0.1 ? clamp((0.1 - b) / 0.3, 0, 1) : 0, '%B ' + b.toFixed(2)]; } },
    { key: 'vwap', name: 'VWAP stretch (2 h)', fn: (c, i, X) => { const z = X.vz[i]; return [Math.abs(z) < 1.5 ? 0 : clamp(-z / 3, -1, 1), (z >= 0 ? '+' : '') + z.toFixed(1) + 'σ from VWAP']; } },
    { key: 'flow', name: 'Buy/sell volume pressure (10 min)', fn: (c, i, X) => { const f = X.flow[i]; return [clamp(f / 0.5, -1, 1), Math.round(f * 100) + '% net ' + (f >= 0 ? 'buying' : 'selling')]; } },
    { key: 'brk', name: '30-minute breakout', fn: (c, i) => { const [lo, hi] = rangeMinMax(c, i - 30, i - 1); return [c[i] > hi ? 1 : c[i] < lo ? -1 : 0, c[i] > hi ? 'above 30-min high' : c[i] < lo ? 'below 30-min low' : 'inside 30-min range']; } }
  ];
  function scalpLevelsAt(price, sigma10, cost, long) {
    const risk = Math.max(1.0 * sigma10, 3 * cost) * price;   // stop at least 3x round-trip costs away
    const dir = long ? 1 : -1;
    const L = { long, entry: price, stop: price - dir * risk, tp1: price + dir * 1.0 * risk, tp2: price + dir * 1.5 * risk, risk, riskPct: risk / price };
    L.tp1Pct = dir * (L.tp1 / price - 1); L.tp2Pct = dir * (L.tp2 / price - 1);
    L.maxLev = Math.max(1, Math.floor(0.8 / L.riskPct));
    L.zone = [price, price];
    L.valid = [L.entry, L.stop, L.tp1, L.tp2].every(x => Number.isFinite(x) && x > 0) &&
      (long ? L.stop < L.entry && L.entry < L.tp1 && L.tp1 < L.tp2 : L.stop > L.entry && L.entry > L.tp1 && L.tp1 > L.tp2);
    return L;
  }
  function scalp(bars, opts) {
    opts = opts || {};
    const fee = opts.fee != null ? opts.fee : 0.00045;   // taker fee per side
    const n = bars.length;
    if (n < 200) return null;
    const c = bars.map(b => b.c), hi = bars.map(b => b.h), lo = bars.map(b => b.l), v = bars.map(b => b.v);
    const lr = c.map((x, i) => i ? Math.log(x / c[i - 1]) : 0);
    const sd1 = new Float64Array(n); // rolling 60-bar std of 1-minute returns
    for (let i = 1; i < n; i++) { const a = Math.max(1, i - 59); let s = 0, s2 = 0, m = i - a + 1; for (let j = a; j <= i; j++) { s += lr[j]; s2 += lr[j] * lr[j]; } const mu = s / m; sd1[i] = Math.sqrt(Math.max(1e-12, s2 / m - mu * mu)); }
    const vz = new Float64Array(n), flow = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 119); let pv = 0, vv = 0;
      for (let j = a; j <= i; j++) { const tp = (hi[j] + lo[j] + c[j]) / 3; pv += tp * v[j]; vv += v[j]; }
      const vw = vv ? pv / vv : c[i];
      vz[i] = (c[i] / vw - 1) / (sd1[i] * Math.sqrt(30) + 1e-12);
      const b0 = Math.max(0, i - 9); let up = 0, dn = 0;
      for (let j = b0; j <= i; j++) { const rng = hi[j] - lo[j]; const w = rng > 0 ? (c[j] - lo[j]) / rng : 0.5; up += v[j] * w; dn += v[j] * (1 - w); }
      flow[i] = up + dn ? (up - dn) / (up + dn) : 0;
    }
    const X = { e9: ema(c, 9), e21: ema(c, 21), rsi: rsi(c), sd1, vz, flow };
    const votes = SSTRATS.map(() => new Float64Array(n));
    for (let i = SWARM; i < n; i++) for (let k = 0; k < SSTRATS.length; k++) votes[k][i] = SSTRATS[k].fn(c, i, X)[0];
    const dirHit = (k, a, b) => { let h = 0, m = 0; for (let i = a; i < b; i++) { const x = votes[k][i]; if (Math.abs(x) < 0.2) continue; m++; if ((x > 0) === (c[i + SH] > c[i])) h++; } return { hit: m ? h / m : 0.5, cnt: m }; };
    const testStart = Math.floor(SWARM + (n - SWARM - SH) * 0.6);
    const wOf = st => st.map(t => (t.cnt >= 30 ? Math.max(0, t.hit - 0.5) : 0));
    const wTrain = wOf(SSTRATS.map((_, k) => dirHit(k, SWARM, testStart - SH)));
    const comp = (i, w) => { let a = 0, d = 0; for (let k = 0; k < w.length; k++) { a += w[k] * votes[k][i]; d += w[k]; } return d ? a / d : 0; };
    const sigma10At = i => sd1[i] * Math.sqrt(SH);
    const cost = 2 * fee;
    // Simulate the real trade on out-of-sample bars (one trade at a time).
    let trades = 0, wins = 0, sumR = 0, sumPct = 0, tpHits = 0, slHits = 0, timeExits = 0;
    for (let i = testStart; i < n - SH; i++) {
      const s = comp(i, wTrain); if (Math.abs(s) < 0.25) continue;
      const L = scalpLevelsAt(c[i], sigma10At(i), cost, s > 0); if (!L.valid) continue;
      let exit = c[i + SH], how = 'time';
      for (let j = i + 1; j <= i + SH; j++) {
        const hitSL = L.long ? lo[j] <= L.stop : hi[j] >= L.stop;
        const hitTP = L.long ? hi[j] >= L.tp1 : lo[j] <= L.tp1;
        if (hitSL) { exit = L.stop; how = 'sl'; break; }
        if (hitTP) { exit = L.tp1; how = 'tp'; break; }
      }
      const gross = (L.long ? 1 : -1) * (exit / c[i] - 1), net = gross - cost;
      trades++; sumPct += net; sumR += net / L.riskPct; if (net > 0) wins++;
      if (how === 'tp') tpHits++; else if (how === 'sl') slHits++; else timeExits++;
      i += SH - 1; // no overlapping trades
    }
    const full = SSTRATS.map((_, k) => dirHit(k, SWARM, n - SH));
    const w = wOf(full);
    const now = n - 1, S = comp(now, w);
    const readings = SSTRATS.map((st, k) => { const [vote, label] = st.fn(c, now, X); return { key: st.key, name: st.name, vote, label, weight: w[k], hit: full[k].hit, cnt: full[k].cnt }; });
    let aN = 0, aD = 0; readings.forEach(r => { aN += r.weight * r.vote; aD += r.weight * Math.abs(r.vote); });
    const agreement = aD ? Math.abs(aN) / aD : 0;
    let sumMove = 0, mm = 0; for (let i = Math.max(SWARM, n - 300); i < n - SH; i++) { sumMove += Math.abs(c[i + SH] / c[i] - 1); mm++; }
    const avgMove10 = mm ? sumMove / mm : 0;
    const expR = trades ? sumR / trades : 0;
    return { n, price: c[now], S, readings, agreement, sigma10: sigma10At(now), avgMove10, cost, fee,
      sim: { trades, wins, winRate: trades ? wins / trades : 0, expR, expPct: trades ? sumPct / trades : 0, tpHits, slHits, timeExits },
      levelsLong: scalpLevelsAt(c[now], sigma10At(now), cost, true), levelsShort: scalpLevelsAt(c[now], sigma10At(now), cost, false) };
  }
  // Live order book + trade tape -> tilt and agreement. book: {bids:[[px,sz]], asks:[[px,sz]]}, tape: [{buy:bool, sz}]
  function micro(book, tape) {
    let imb = null, spread = null, tapeFlow = null;
    if (book && book.bids.length && book.asks.length) {
      const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
      spread = (book.asks[0][0] - book.bids[0][0]) / mid;
      const inBand = (lvls, side) => lvls.filter(([px]) => Math.abs(px / mid - 1) <= 0.0025).reduce((a, [px, sz]) => a + px * sz, 0);
      const b = inBand(book.bids), a = inBand(book.asks);
      imb = b + a ? (b - a) / (b + a) : 0;
    }
    if (tape && tape.length >= 10) { let bu = 0, se = 0; tape.forEach(t => { if (t.buy) bu += t.sz; else se += t.sz; }); tapeFlow = bu + se ? (bu - se) / (bu + se) : 0; }
    return { imb, spread, tapeFlow };
  }
  function scalpOdds(R, M) {
    if (!R) return null;
    const sim = R.sim;
    const edge = clamp(sim.expR / 0.25, 0, 1);             // +0.25R per trade after fees = full edge
    const sample = clamp(sim.trades / 25, 0, 1);
    const moveVsCost = R.avgMove10 / R.cost;                // typical 10-min move vs round-trip fees
    const costFactor = clamp((moveVsCost - 1.5) / 3, 0, 1);
    let prob = 50 + 20 * clamp(R.S, -1, 1) * Math.max(edge, 0.25);
    let liveAgree = 0, notes = [];
    if (M) {
      const live = [M.imb, M.tapeFlow].filter(x => x != null);
      if (live.length) {
        const avg = live.reduce((a, b) => a + b, 0) / live.length;
        prob += clamp(avg, -1, 1) * 5;
        if (Math.abs(R.S) >= 0.1 && Math.abs(avg) >= 0.15) liveAgree = Math.sign(avg) === Math.sign(R.S) ? 1 : -1;
      }
      if (M.spread != null && M.spread > R.cost) notes.push('Spread is wider than the fees, which eats into a 10-minute trade.');
    }
    prob = Math.round(clamp(prob, 30, 70));
    let conf = 100 * R.agreement * edge * sample * costFactor;
    conf += liveAgree * 10;
    conf = Math.round(clamp(conf, 0, 100));
    if (sim.expR <= 0) notes.push('In the backtest this setup lost money after fees on this coin.');
    if (moveVsCost < 2) notes.push('This coin barely moves in 10 minutes compared with trading fees.');
    return { prob, conf, edge, sample, costFactor, moveVsCost, liveAgree, notes };
  }
  root.Quant.scalp = scalp; root.Quant.micro = micro; root.Quant.scalpOdds = scalpOdds; root.Quant.scalpLevelsAt = scalpLevelsAt; root.Quant.SSTRATS = SSTRATS;
  if (typeof module !== 'undefined') module.exports = root.Quant;
})(typeof window !== 'undefined' ? window : globalThis);
