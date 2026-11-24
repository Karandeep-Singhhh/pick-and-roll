// Combo pricing in the browser - the same method as the server (app/picks/combos.py):
// one latent normal per player (correlated within a game), each leg wins when the player's latent clears the
// threshold implied by the leg's fair chance. Over legs win above it, Under legs below it.

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acklam's inverse normal CDF
export function invNorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  p = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function rhoBetween(a, b, corr) {
  if (a.g !== b.g) return 0;
  if (a.pid === b.pid) return 1;
  const cat = corr?.cat || {};
  if (a.team === b.team) {
    const lo = Math.min(a.pid, b.pid), hi = Math.max(a.pid, b.pid);
    const hit = (corr?.pairs || []).find((p) => p[0] === lo && p[1] === hi);
    if (hit) return hit[2];
    const sm = corr?.starter_min ?? 28;
    const ra = a.min >= sm ? 'S' : 'B', rb = b.min >= sm ? 'S' : 'B';
    return cat[`team_${ra === rb ? ra + rb : 'SB'}`] ?? 0;
  }
  return cat.opp ?? 0;
}

function cholesky(R) {
  const n = R.length;
  for (let shrink = 1; shrink > 0.05; shrink *= 0.85) {
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = i === j ? 1 : R[i][j] * shrink;
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 1e-10) { ok = false; break; } L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
      }
    }
    if (ok) return L;
  }
  return R.map((_, i) => R.map((__, j) => (i === j ? 1 : 0)));
}

/** legs: [{p, side, g, pid, team, min}] -> {p, se, naive} (chance all legs win, conditional on everyone playing) */
export function comboProb(legs, corr, draws = 60000, seed = 7) {
  if (!legs.length) return { p: 0, se: 0, naive: 0 };
  const players = [];
  const idx = legs.map((lg) => {
    let i = players.findIndex((p) => p.pid === lg.pid && p.g === lg.g);
    if (i < 0) { players.push(lg); i = players.length - 1; }
    return i;
  });
  const n = players.length;
  const R = players.map((a) => players.map((b) => (a === b ? 1 : rhoBetween(a, b, corr))));
  const L = cholesky(R);
  const thr = legs.map((lg) => (lg.side === 'over' ? invNorm(1 - lg.p) : invNorm(lg.p)));
  const rnd = mulberry32(seed);
  const e = new Float64Array(n), z = new Float64Array(n);
  let hits = 0;
  for (let t = 0; t < draws; t++) {
    for (let i = 0; i < n; i += 2) {
      const u1 = rnd() || 1e-12, u2 = rnd();
      const r = Math.sqrt(-2 * Math.log(u1));
      e[i] = r * Math.cos(2 * Math.PI * u2);
      if (i + 1 < n) e[i + 1] = r * Math.sin(2 * Math.PI * u2);
    }
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k <= i; k++) s += L[i][k] * e[k]; z[i] = s; }
    let all = true;
    for (let j = 0; j < legs.length && all; j++) {
      const v = z[idx[j]];
      all = legs[j].side === 'over' ? v > thr[j] : v <= thr[j];
    }
    if (all) hits++;
  }
  const p = hits / draws;
  return { p, se: Math.sqrt((p * (1 - p)) / draws), naive: legs.reduce((a, lg) => a * lg.p, 1) };
}

export const comboFee = (price, theta = 0.0695, extra = 0.06) => price * (theta * (1 - price) + extra * (1 - price) ** 4);

// ---------------------------------------------------------------------------------------------------------------
// Joint model (same as app/pricing/joint.py): one latent normal per variable of a game - a player's stat, a team's
// score, the total or the home margin - correlated by category; a leg wins when its variable's latent lands in the
// leg's interval (F(lo), F(hi)] on the uniform scale, so each leg keeps its own fair chance exactly.
const STARTER = 28;

export function rhoJoint(a, b, J) {
  if (!J || a.g !== b.g) return 0;
  const S = Object.fromEntries((J.stats || []).map((s, i) => [s, i]));
  const G = Object.fromEntries((J.game_vars || []).map((v, i) => [v, i]));
  if (a.kind === 'game' && b.kind === 'game') return J.game_block?.[G[a.v]]?.[G[b.v]] ?? 0;
  if (a.kind === 'game' || b.kind === 'game') {
    const pl = a.kind === 'player' ? a : b, gv = a.kind === 'player' ? b : a;
    const base = gv.v.replace('h1_', '').replace('_reg', '');
    let tv = 'total', sign = 1;
    if (base === 'home') tv = pl.home ? 'own' : 'opp';
    else if (base === 'away') tv = pl.home ? 'opp' : 'own';
    else if (base === 'margin') { tv = 'margin'; sign = pl.home ? 1 : -1; }
    const m = J[`player_game_${(pl.min ?? 0) >= STARTER ? 'S' : 'B'}`];
    if (!m) return 0;
    let r = sign * (m[S[pl.stat]]?.[(J.team_vars || []).indexOf(tv)] ?? 0);
    if (gv.v.startsWith('h1_')) r *= J.game_block?.[G[gv.v]]?.[G[gv.v.replace('h1_', '')]] ?? 0;
    return r;
  }
  if (a.pid === b.pid) return J.same_player?.[S[a.stat]]?.[S[b.stat]] ?? 0;
  let cat = 'opp';
  if (a.team === b.team) {
    const ra = (a.min ?? 0) >= STARTER ? 'S' : 'B', rb = (b.min ?? 0) >= STARTER ? 'S' : 'B';
    cat = `team_${ra === rb ? ra + rb : 'SB'}`;
  }
  return J[cat]?.[S[a.stat]]?.[S[b.stat]] ?? 0;
}

/** legs: [{key, kind, g, v|stat, pid, team, home, min, flo, fhi}] -> {p, se, naive} */
export function jointProb(legs, J, draws = 40000, seed = 7) {
  if (!legs.length) return { p: 0, se: 0, naive: 0 };
  const vars = [];
  const idx = legs.map((lg) => {
    let i = vars.findIndex((v) => v.key === lg.key);
    if (i < 0) { vars.push(lg); i = vars.length - 1; }
    return i;
  });
  const R = vars.map((a, i) => vars.map((b, j) => (i === j ? 1 : rhoJoint(a, b, J))));
  const L = cholesky(R);
  const lo = legs.map((lg) => (lg.flo <= 0 ? -Infinity : invNorm(lg.flo)));
  const hi = legs.map((lg) => (lg.fhi >= 1 ? Infinity : invNorm(lg.fhi)));
  const n = vars.length, rnd = mulberry32(seed);
  const e = new Float64Array(n), z = new Float64Array(n);
  let hits = 0;
  for (let t = 0; t < draws; t++) {
    for (let i = 0; i < n; i += 2) {
      const u1 = rnd() || 1e-12, u2 = rnd();
      const r = Math.sqrt(-2 * Math.log(u1));
      e[i] = r * Math.cos(2 * Math.PI * u2);
      if (i + 1 < n) e[i + 1] = r * Math.sin(2 * Math.PI * u2);
    }
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k <= i; k++) s += L[i][k] * e[k]; z[i] = s; }
    let all = true;
    for (let j = 0; j < legs.length && all; j++) { const v = z[idx[j]]; all = v > lo[j] && v <= hi[j]; }
    if (all) hits++;
  }
  const p = hits / draws;
  return { p, se: Math.sqrt((p * (1 - p)) / draws), naive: legs.reduce((a, lg) => a * (lg.fhi - lg.flo), 1) };
}
