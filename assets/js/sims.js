// Game sims: every game tonight played out 10,000 times (data/sims.json: app/pipeline/sims_live.py, tested in
// app/backtest/gamesim.py). Score, win chance, total, overtime and blowout odds per game; each player's median and
// 10th-90th percentile range; the Your-style combos the sims rate highest.
import { html, useState, useEffect } from '../vendor/preact-htm.mjs';
import * as F from './fmt.js';

let S = {};
export const init = (shared) => { S = shared; };

let cache = null;
function useSims(stamp) {
  const [st, setSt] = useState(cache);
  useEffect(() => {
    let alive = true;
    fetch(`data/sims.json?m=${encodeURIComponent(stamp || Date.now())}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) { cache = j; setSt(j); } })
      .catch(() => { if (alive && !cache) setSt({ games: [], error: true }); });
    return () => { alive = false; };
  }, [stamp]);
  return st;
}

const r0 = (x) => Math.round(x);
const COLS = [['min', 'MIN'], ['pts', 'PTS'], ['reb', 'REB'], ['ast', 'AST'], ['fg3m', '3PM'], ['pra', 'PRA'], ['stl', 'STL'], ['blk', 'BLK']];

// the margin distribution: how often each final margin happened in the sims (home team's view)
function MarginBars({ g, away, home }) {
  const h = g.margin_hist;
  if (!h) return null;
  const W = 300, H = 70, n = h.p.length, bw = W / n, top = Math.max(...h.p);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H + 14}" role="img" aria-label="Final margin in the sims">
    ${h.p.map((p, i) => { const mid = (h.edges[i] + h.edges[i + 1]) / 2; return html`<rect x=${i * bw + 1} y=${H - (p / top) * H} width=${bw - 2} height=${(p / top) * H} rx="2"
      fill=${mid > 0 ? F.teamColor(home) : F.teamColor(away)} opacity=${Math.abs(mid) >= 15 ? 0.45 : 0.9}><title>${mid > 0 ? `${home} by ${h.edges[i]}–${h.edges[i + 1]}` : `${away} by ${-h.edges[i + 1]}–${-h.edges[i]}`}: ${F.pct(p, 1)} of sims</title></rect>`; })}
    <text x="0" y=${H + 12}>${away} by 40</text><text x=${W / 2} y=${H + 12} text-anchor="middle">even</text><text x=${W} y=${H + 12} text-anchor="end">${home} by 40</text>
  </svg>`;
}

function GameCard({ d, g }) {
  const away = d.tri(g.away), home = d.tri(g.home);
  const gm = d.gameById?.[g.game_id] || {};
  const hw = g.home_win;
  return html`<article class="card pad click simcard" onClick=${() => { location.hash = `#/sims/${g.game_id}`; }}>
    <div class="row wrap" style="gap:8px"><b>${away} @ ${home}</b>${gm.started ? html`<span class="gstat live"><i class="pulse"></i>${gm.status === 3 ? 'Final' : gm.status_text || 'In play'}${gm.score ? ` · ${gm.score[0]}–${gm.score[1]}` : ''}</span>` : html`<span class="small muted">${F.timeET(gm.tip)}</span>`}<span class="spacer"></span><span class="small ink2">${g.n.toLocaleString()} sims</span></div>
    ${gm.started && html`<div class="tiny muted">Simulated before tip (${F.timeET(gm.frozen_at)}); not updated in-game</div>`}
    <div class="simscore"><span><${S.TeamChip} tri=${away}/> <b>${r0(g.away_pts[1])}</b></span><span class="muted">–</span><span><b>${r0(g.home_pts[1])}</b> <${S.TeamChip} tri=${home}/></span></div>
    <div class="winbar" title=${`${away} win ${F.pct(1 - hw)} · ${home} win ${F.pct(hw)}`}><i style=${`width:${100 * (1 - hw)}%;background:${F.teamColor(away)}`}></i><i style=${`width:${100 * hw}%;background:${F.teamColor(home)}`}></i></div>
    <div class="row small ink2" style="justify-content:space-between"><span>${away} ${F.pct(1 - hw)}</span><span>${home} ${F.pct(hw)}</span></div>
    <${MarginBars} g=${g} away=${away} home=${home}/>
    <div class="row wrap small ink2" style="gap:12px"><span>Total <b>${r0(g.total[1])}</b> <span class="muted">(${r0(g.total[0])}–${r0(g.total[2])})</span></span>
      <span>Overtime <b>${F.pct(g.ot)}</b></span><span>Blowout (15+) <b>${F.pct(g.blowout)}</b></span></div>
  </article>`;
}

function Cell({ q }) {
  if (!q) return html`<td class="r muted">—</td>`;
  return html`<td class="r" title=${`10th–90th percentile: ${q[0]}–${q[2]}`}><b>${r0(q[1])}</b><div class="tiny muted">${r0(q[0])}–${r0(q[2])}</div></td>`;
}

function BoxScore({ d, g }) {
  const teams = [[g.away, false], [g.home, true]];
  return html`${teams.map(([tid, home]) => html`<div class="card" style="margin-top:12px"><div class="pad" style="padding-bottom:0"><b>${d.tri(tid)}</b> <span class="small muted">median of the sims, 10th–90th percentile under it</span></div>
    <div class="tablewrap flowt" style="box-shadow:none"><table class="t"><thead><tr><th>Player</th>${COLS.map(([, l]) => html`<th class="r">${l}</th>`)}</tr></thead>
      <tbody>${g.players.filter((p) => p.home === home).map((p) => html`<tr class="click" onClick=${() => S.goPlayer(g.game_id, p.pid)}>
        <td style="white-space:normal"><b>${p.name}</b>${p.p_play < 0.9 ? html` <span class="chip warn tiny" title="Chance he plays">${F.pct(p.p_play)} to play</span>` : ''}</td>
        ${COLS.map(([k]) => html`<${Cell} q=${p[k]}/>`)}</tr>`)}</tbody></table></div></div>`)}`;
}

function Tested({ bt }) {
  if (!bt) return html`<div class="note">The simulation backtest hasn't finished yet.</div>`;
  const all = (t) => bt.by?.find((r) => r.tier === t && r.k === 'all');
  const m = all('main'), s = all('safer');
  const L = bt.legs || {};
  const ci = bt.ll_ci_hyb_vs_corr || [];
  return html`<${S.Info} title="How the sims were tested">
    <div class="small ink2" style="margin-top:6px">Fit on 2023-25, judged on ${bt.test_dates} slates of 2025-26 it never saw (${bt.n_test?.toLocaleString()} Your-style combos), against how the site prices combos now.
      ${m && s ? html` Actual hit rates: <b>${F.pct(s.hit, 1)}</b> for 2–4 legs and <b>${F.pct(m.hit, 1)}</b> for 5–7. Today's method said ${F.pct(s.p_corr_f, 1)} and ${F.pct(m.p_corr_f, 1)}; the sims said ${F.pct(s.p_hyb_f, 1)} and ${F.pct(m.p_hyb_f, 1)}.` : ''}
      ${ci.length ? html` Scored over every combo, the sims were ${bt.ll.p_hyb < bt.ll.p_corr ? 'slightly better' : 'slightly worse'} (log loss ${bt.ll.p_hyb.toFixed(4)} vs ${bt.ll.p_corr.toFixed(4)}; difference range ${ci[0].toFixed(4)} to ${ci[1].toFixed(4)}). ${bt.adopt_hyb ? 'That cleared the bar set before the test, so combo chances now come from the sims.' : 'That didn\'t clear the bar set before the test (a clearly better score and within 10% for both sizes), so combo chances keep today\'s method and the sims are a second opinion.'}` : ''}
      ${L.n ? html` Single lines straight from the raw sims looked a hair better at first (log loss ${L.ll_sim.toFixed(4)} vs ${L.ll_model.toFixed(4)}, n=${L.n.toLocaleString()}), but those test lines were picked by the model's own chance.${bt.legs_robust ? ` Re-checked on every line (n=${bt.legs_robust.n.toLocaleString()}) the gain vanished (range ${bt.legs_robust.ci[0].toFixed(4)} to +${bt.legs_robust.ci[1].toFixed(4)}), and it turned slightly worse on lines the sims themselves liked.` : ''} So every chance on this page is still the model's; the sims only decide what happens together. One lead: Pts+Reb+Ast built from the simulated parts beat the separate PRA model, worth its own test.` : ''}</div>
    <div class="small muted" style="margin-top:6px">Each draw: both team scores around the game model's projection, the margin (blowouts cut starters' minutes, a near-tie goes to overtime), each player's minutes with his role's real ups and downs (foul trouble, early exits), team minutes adding up to 240, then each stat from his minutes and both scores, threes inside points. ${bt.n_sims?.toLocaleString()} draws per game in the test, 10,000 live.</div>
  </${S.Info}>`;
}

function Verdict({ bt }) {
  if (!bt) return null;
  return html`<div class="note"><b>Tested on ${bt.n_test?.toLocaleString()} past combos it never saw:</b> ${bt.adopt_hyb
    ? 'the sims priced combos better than the site’s old method, so combo chances now come from them.'
    : 'about as accurate as how the site already prices combos, not better. So they’re here as a second look at each game, not used for picks.'} Details at the bottom.</div>`;
}

function TopCombos({ d }) {
  const [pl, setPl] = useState(null);
  useEffect(() => {
    fetch(`data/parlays.json?m=${encodeURIComponent(d.parlays?.computed_at || Date.now())}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then(setPl).catch(() => setPl(null));
  }, [d.parlays?.computed_at]);
  const rows = (pl?.list || []).filter((c) => F.isNum(c.p_sim)).map((c) => ({ ...c, ev_sim: c.p_sim * c.payout - 1 }))
    .sort((a, b) => b.ev_sim - a.ev_sim).slice(0, 8);
  if (!rows.length) return html`<div class="small muted">No Your-style combos with a simulated chance right now.</div>`;
  return html`<div class="tablewrap flowt"><table class="t"><thead><tr><th>Combo</th><th class="r">Pays</th><th class="r">Sims</th><th class="r">Site chance</th><th class="r">Value at sims</th></tr></thead>
    <tbody>${rows.map((c) => html`<tr><td style="white-space:normal">${c.k} legs · ${c.games.length} game${c.games.length > 1 ? 's' : ''}
      <div class="tiny muted">${c.legs.map((k) => pl.legs[k]).filter(Boolean).map((lg) => `${lg.name} ${lg.side === 'under' ? 'U' : 'O'} ${lg.thr - 0.5} ${lg.stat}`).join(' · ')}</div></td>
      <td class="r">${F.x1(c.payout)}</td><td class="r"><b>${F.pct(c.p_sim, 1)}</b></td><td class="r">${F.pct(c.p_bt, 1)}</td>
      <td class=${`r ${c.ev_sim >= 0 ? 'good' : 'bad'}`}>${F.signedPct(c.ev_sim, 0)}</td></tr>`)}</tbody></table></div>
    <div class="small muted" style="margin-top:6px">The Your-style combos ranked by expected return at the sims' chance. Load them from the <a href="#/combos">Your style</a> page.</div>`;
}

export function Sims({ d, gid }) {
  const data = useSims(d.sims?.computed_at || d.generated_at);
  // games to come first, by tip; started ones (sims frozen at tip) after them
  const games = (data?.games || []).slice().sort((a, b) => (a.started ? 1 : 0) - (b.started ? 1 : 0)
    || String(d.gameById?.[a.game_id]?.tip).localeCompare(String(d.gameById?.[b.game_id]?.tip)));
  const g = gid && games.find((x) => x.game_id === gid);
  if (gid) {
    return html`<main class="page">
      <a class="back" href="#/sims" onClick=${(e) => { if (history.length > 1) { e.preventDefault(); history.back(); } }}>← All games</a>
      ${!data ? html`<div class="small muted">Loading…</div>` : !g ? html`<${S.Empty} title="No sims for this game">It may have tipped off already.</${S.Empty}>`
        : html`<div style="margin-top:8px"><${GameCard} d=${d} g=${g}/></div><${BoxScore} d=${d} g=${g}/>
          <div class="small muted" style="margin-top:8px">Medians and ranges are each player's own; they don't add up to the team score exactly (the median of a sum isn't the sum of medians). Every number assumes he plays.</div>`}
    </main>`;
  }
  return html`<main class="page">
    <${S.Hero} d=${d} kicker="10,000 times each" title="Game sims" sub="Every game tonight played out 10,000 times: the score, the margin, minutes and every player's stat line come from the same draws, so blowouts and overtime carry through to everyone."/>
    <section class="section" style="margin-top:4px"><${Verdict} bt=${data?.backtest}/></section>
    <section class="section"><div class="section-head"><h2>Tonight's games</h2><span class="lede">Median score, win chance and the spread of margins · tap a game for every player's simulated line${data?.computed_at ? ` · run ${F.ago(data.computed_at)}` : ''}</span></div>
      ${!data ? html`<div class="small muted">Loading…</div>` : games.length
        ? html`<div class="grid g3">${games.map((x) => html`<${GameCard} key=${x.game_id} d=${d} g=${x}/>`)}</div>`
        : html`<${S.Empty} title="No sims yet">They run with the Your-style combos every few minutes once tonight's projections are in.</${S.Empty}>`}
    </section>
    <section class="section"><div class="section-head"><h2>Combos the sims like</h2><span class="lede">Tonight's Your-style combos, by expected return at the simulated chance</span></div>
      <${TopCombos} d=${d}/></section>
    <section class="section"><${Tested} bt=${data?.backtest}/></section>
  </main>`;
}
