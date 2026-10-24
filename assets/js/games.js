// Game boards: every game line and every player-prop ladder for one game, both venues side by side (data/games/{id}.json),
// plus the game cards on Tonight. Shared components come from app.js through init() (no circular imports).
import { html, useState, useEffect, useMemo } from '../vendor/preact-htm.mjs';
import * as F from './fmt.js';
import { jointProb, comboFee } from './combo.js';

const { isNum } = F;
let S = {};
export const init = (shared) => { S = shared; };

const VS = { us: 'PM US', k: 'Kalshi', kalshi: 'Kalshi' };
const PROP_ORDER = ['player.pts', 'player.reb', 'player.ast', 'player.fg3m', 'player.pra', 'player.stl', 'player.blk'];
const PROP_UNIT = { 'player.pts': 'pts', 'player.reb': 'reb', 'player.ast': 'ast', 'player.fg3m': '3PM', 'player.pra': 'PRA', 'player.stl': 'stl', 'player.blk': 'blk' };
const boards = {};

export function useBoard(gid, hash) {
  const key = `${gid}:${hash}`;
  const [st, setSt] = useState(boards[key] ? { board: boards[key] } : { board: null });
  useEffect(() => {
    if (!gid || boards[key]) { setSt({ board: boards[key] || null }); return undefined; }
    let alive = true;
    fetch(`data/games/${gid}.json?h=${hash || Date.now()}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((b) => { boards[key] = b; if (alive) setSt({ board: b }); })
      .catch((e) => alive && setSt({ board: null, error: String(e) }));
    return () => { alive = false; };
  }, [key]);
  return st;
}

// ------------------------------------------------------------------------ combo slip (any legs, any game)
const SLIP_KEY = 'pr_slip_v1';
let slip = (() => { try { return JSON.parse(localStorage.getItem(SLIP_KEY) || '[]'); } catch { return []; } })();
const listeners = new Set();
const saveSlip = (x) => { slip = x; try { localStorage.setItem(SLIP_KEY, JSON.stringify(x)); } catch { /* private mode */ } listeners.forEach((f) => f(x)); };
const toggleLeg = (leg) => saveSlip(slip.some((l) => l.id === leg.id) ? slip.filter((l) => l.id !== leg.id) : [...slip, leg]);
function useSlip() {
  const [x, setX] = useState(slip);
  useEffect(() => { listeners.add(setX); return () => listeners.delete(setX); }, []);
  return x;
}
const GAME_VAR = { 'game.ml': 'margin', 'game.spread': 'margin', 'game.ot': 'margin_reg', 'game.total': 'total', 'h1.spread': 'h1_margin', 'h1.winner': 'h1_margin', 'h1.total': 'h1_total' };
function gameVar(f, team, homeTri) {
  if (f === 'game.teamtotal') return team ? (team === homeTri ? 'home' : 'away') : null;
  if (f === 'h1.teamtotal') return team ? (team === homeTri ? 'h1_home' : 'h1_away') : null;
  return GAME_VAR[f] || null;
}
// a leg = one side of a one-sided interval on a variable; bands and ties aren't combinable here
function lineLeg(b, homeTri, m, side) {
  const v = gameVar(m.f, m.team, homeTri);
  if (!v || !isNum(m.fair) || m.lo == null || m.hi != null) return null;
  const yes = side === 'yes';
  const q = (x, cb) => (x ? { px: yes ? x.a : (isNum(x.b) ? 1 - x.b : null), combo: !!(yes ? x.cby : x.cbn) && cb } : null);
  return { id: `${b.id}|${m.f}|${m.lo}|${m.team || ''}|${side}`, key: `${b.id}:${v}`, kind: 'game', g: b.id, v, fam: m.f, side,
    line: m.lo, label: yes ? m.ys : m.ns, p: yes ? m.fair : 1 - m.fair, flo: yes ? 1 - m.fair : 0, fhi: yes ? 1 : 1 - m.fair,
    us: q(m.v.us, true), k: q(m.v.k, yes) };
}
function propLeg(b, f, pl, r, side) {
  if (!isNum(r.fair)) return null;
  const over = side === 'over';
  const stat = f.split('.')[1];
  return { id: `${b.id}|${f}|${pl.pid}|${r.l}|${side}`, key: `${b.id}:${pl.pid}:${stat}`, kind: 'player', g: b.id, stat, fam: f,
    pid: pl.pid, team: pl.team, home: pl.team === b.home, min: pl.min, side, line: r.l,
    label: `${pl.name} ${over ? 'Over' : 'Under'} ${r.l} ${PROP_UNIT[f]}`,
    p: over ? r.fair : 1 - r.fair, flo: over ? 1 - r.fair : 0, fhi: over ? 1 : 1 - r.fair,
    us: r.us && over ? { px: r.us.a, combo: true } : null,                                   // Polymarket US props: Over (Yes) only
    k: r.k ? { px: over ? r.k.a : (isNum(r.k.b) ? 1 - r.k.b : null), combo: over } : null };  // Kalshi combos: props as Yes only
}

// one side of a contract as a sportsbook cell: label, all-in price at the best venue that sells it, fair chance
const PX = (p) => (F.oddsMode() === 'both' ? html`${F.pct(p)} <span class="mc-odds">${F.american(p)}</span>`
  : F.oddsMode() === 'us' ? F.american(p) : F.pct(p));

// green ("value") only in families that passed their backtest gate; Testing families show the fair chance plainly
function Cell({ label, cost, venue, fair, model = null, thin, compact = false, live = false, leg = null }) {
  const edge = isNum(fair) && isNum(cost) ? fair - cost : null;
  const s = useSlip();
  const inSlip = leg && s.some((l) => l.id === leg.id);
  const tip = isNum(cost) ? `${label}: ${F.pct(cost, 1)} (${F.american(cost)}) all-in on ${VS[venue] || '—'}${isNum(fair) ? ` · fair chance ${F.pct(fair, 1)} (${F.american(fair)})` : ''}${isNum(edge) ? ` · edge ${F.signedPct(edge)}` : ''}` : `${label}: no venue sells this side right now`;
  return html`<div class=${`mcell${live && isNum(edge) && edge >= 0 ? ' value' : ''}${!isNum(cost) ? ' off' : ''}${thin ? ' thin' : ''}${compact ? ' compact' : ''}${leg ? ' pickable' : ''}${inSlip ? ' inslip' : ''}`}
    title=${leg ? `${tip} · tap to ${inSlip ? 'remove from' : 'add to'} your combo slip` : tip} onClick=${leg ? (e) => { e.stopPropagation(); toggleLeg(leg); } : undefined}>
    <div class="mc-label">${label}</div>
    <div class="mc-price">${isNum(cost) ? PX(cost) : html`<span class="muted">—</span>`}</div>
    ${!compact && html`<div class="mc-meta">${venue ? html`<span class=${`vtag v-${venue}`}>${VS[venue]}</span>` : html`<span class="muted">not listed</span>`}${isNum(fair) ? html`<span>fair ${F.oddsMode() === 'us' ? F.american(fair) : F.pct(fair)}</span>` : isNum(model) ? html`<span class="mc-model" title="No real book on this line yet, so there's no fair chance: this is the model alone, before any market blending">model ${F.oddsMode() === 'us' ? F.american(model) : F.pct(model)}</span>` : ''}</div>`}
  </div>`;
}
const isLive = (m) => S.liveFams?.has(m.f);
const yesCell = (m, label, compact, leg) => html`<${Cell} label=${label ?? m.ys} cost=${m.cy} venue=${m.vy} fair=${m.fair} model=${m.model} thin=${m.thin} compact=${compact} live=${isLive(m)} leg=${leg}/>`;
const noCell = (m, label, compact, leg) => html`<${Cell} label=${label ?? m.ns} cost=${m.cn} venue=${m.vn} fair=${isNum(m.fair) ? 1 - m.fair : null} model=${isNum(m.model) ? 1 - m.model : null} thin=${m.thin} compact=${compact} live=${isLive(m)} leg=${leg}/>`;

// ------------------------------------------------------------------------ Tonight: game cards
const setLive = (d) => { S.liveFams = new Set(Object.entries(d.families || {}).filter(([, v]) => v.status === 'live').map(([k]) => k)); };

export function GameCards({ d }) {
  setLive(d);
  const games = (d.games || []).filter((g) => d.boards?.[g.id]);
  if (!games.length) return null;
  return html`<div class="grid g3 gamecards">${games.map((g) => {
    const b = d.boards[g.id] || {};
    const mn = b.main || {};
    const away = d.tri(g.away), home = d.tri(g.home);
    const pj = b.proj;
    return html`<a class="card click gcard" href=${`#/game/${g.id}`}>
      <div class="gc-top"><${S.TeamChip} tri=${away}/><span class="muted">@</span><${S.TeamChip} tri=${home}/><span class="spacer"></span>
        <span class="small muted">${F.timeET(g.tip)}</span></div>
      ${pj && html`<div class="gc-proj small ink2">Model: ${away} ${Math.round(pj.away)} – ${home} ${Math.round(pj.home)} · ${home} win ${F.pct(pj.win_home)}</div>`}
      <div class="gc-lines">
        ${mn['game.ml'] && html`<div class="gc-row"><span class="gc-k">Moneyline</span>${noCell({ ...mn['game.ml'], f: 'game.ml' }, away, true)}${yesCell({ ...mn['game.ml'], f: 'game.ml' }, home, true)}</div>`}
        ${mn['game.spread'] && html`<div class="gc-row"><span class="gc-k">Spread</span>${noCell({ ...mn['game.spread'], f: 'game.spread' }, null, true)}${yesCell({ ...mn['game.spread'], f: 'game.spread' }, null, true)}</div>`}
        ${mn['game.total'] && html`<div class="gc-row"><span class="gc-k">Total</span>${yesCell({ ...mn['game.total'], f: 'game.total' }, null, true)}${noCell({ ...mn['game.total'], f: 'game.total' }, null, true)}</div>`}
      </div>
      <div class="gc-foot small muted">${b.n_lines || 0} game lines · ${b.n_props || 0} prop lines${(b.families || []).length ? ` · ${(b.families || []).length} stat${(b.families || []).length === 1 ? '' : 's'}` : ''}<span class="spacer"></span>All markets →</div>
    </a>`;
  })}</div>`;
}

// ------------------------------------------------------------------------ Tonight: other families' picks
export function FamilyPicks({ d }) {
  const rows = (d.fam_picks || []).filter((p) => p.tier === 'pick');
  if (!rows.length) return null;
  const by = {};
  for (const p of rows) (by[p.fam] ||= []).push(p);
  const label = (f) => d.families?.[f]?.label || (d.fam_labels || {})[f] || f;
  return html`<${S.Info} title=${`Picks in other markets: rebounds, assists, game lines… (${rows.length}, all Testing until their backtests pass)`}>
    <div class="small ink2" style="margin-bottom:8px">Same bar as the points picks (fair chance beats the all-in price, tight fresh book, priced 25–80%). These families haven't passed their pre-registered backtest yet, so they're shown for information and tracked separately.</div>
    ${Object.entries(by).map(([f, ps]) => html`<div class="fp-group"><div class="fp-head"><b>${label(f)}</b> <${S.FamilyBadge} st=${ps[0].st}/></div>
      <table class="t"><tbody>${ps.sort((a, b) => (b.edge || 0) - (a.edge || 0)).map((p) => html`<tr class="click" onClick=${() => { location.hash = `#/game/${p.g}/${f.startsWith('player.') ? `props/${f}` : 'lines'}`; }}>
        <td>${p.name ? html`<b>${p.name}</b> ` : ''}<span class=${p.side === 'over' || p.side === 'yes' ? 'over' : 'under'}>${p.label || `${F.sideWord(p.side)} ${p.line}`}</span></td>
        <td class="r">fair ${F.pct(p.p)}</td><td class="r">${F.odds(p.cost)} all-in</td><td>${S.VenueChip ? html`<${S.VenueChip} v=${p.venue}/>` : p.venue}</td></tr>`)}</tbody></table></div>`)}
  </${S.Info}>`;
}

// ------------------------------------------------------------------------ game page
export function GamePage({ d, gid, tab = 'lines', fam }) {
  setLive(d);
  const g = d.gameById[gid];
  const { board, error } = useBoard(gid, d.board_files?.[gid]);
  if (board) S.labels = { ...(S.labels || {}), ...(board.labels || {}) };
  if (!g) return html`<main class="page"><${S.Empty} title="That game isn't on tonight's board">It may have finished. <a href="#/">Back to tonight</a>.</${S.Empty}></main>`;
  const away = d.tri(g.away), home = d.tri(g.home);
  const pj = d.boards?.[gid]?.proj;
  const setTab = (t, f) => { location.hash = `#/game/${gid}/${t}${f ? `/${f}` : ''}`; };
  return html`<main class="page">
    <div class="game-head">
      <div class="gh-teams"><${S.TeamChip} tri=${away}/><span class="gh-at">@</span><${S.TeamChip} tri=${home}/>
        <h1>${d.teams?.[g.away]?.name || away} at ${d.teams?.[g.home]?.name || home}</h1></div>
      <div class="small ink2">${F.dayET(g.tip)} · tip ${F.timeET(g.tip)} · picks lock ${F.timeET(g.lock)}${pj ? ` · model projection ${away} ${pj.away.toFixed(0)} – ${home} ${pj.home.toFixed(0)}, ${home} win ${F.pct(pj.win_home)}` : ''}</div>
    </div>
    <${S.Tabs} tabs=${[['lines', 'Game lines'], ['props', 'Player props']]} value=${tab === 'props' ? 'props' : 'lines'} onChange=${(t) => setTab(t)}/>
    ${!board ? (error ? html`<${S.Empty} title="Couldn't load this game's markets">${error}</${S.Empty}>` : html`<div class="card pad muted">Loading markets…</div>`)
      : tab === 'props' ? html`<${Props} d=${d} b=${board} fam=${fam} onFam=${(f) => setTab('props', f)}/>` : html`<${Lines} d=${d} b=${board} away=${away} home=${home}/>`}
    <div class="small muted" style="margin-top:14px">Prices are all-in (ask + that venue's taker fee) at the cheapest venue that sells the side; Polymarket US player props only sell the Over. Fair chance blends the market price with the model (mostly the market: these books are sharp). Game lines are information only: the game model hasn't beaten its pre-registered accuracy target yet.</div>
  </main>`;
}

function Lines({ d, b, away, home }) {
  const Y = (m, label) => yesCell(m, label, false, lineLeg(b, home, m, 'yes'));
  const N = (m, label) => noCell(m, label, false, lineLeg(b, home, m, 'no'));
  const by = {};
  for (const m of b.lines) (by[m.f] ||= []).push(m);
  const main = (f, team) => (by[f] || []).find((m) => m.main && (!team || m.team === team));
  const ml = main('game.ml'), sp = main('game.spread'), tot = main('game.total');
  const h1w = (by['h1.winner'] || []);
  const h1home = h1w.find((m) => m.lo === 0.5 && m.hi == null), h1tie = h1w.find((m) => m.lo === -0.5 && m.hi === 0.5),
    h1away = h1w.find((m) => m.lo === -0.5 && m.hi == null);
  const h1s = main('h1.spread'), h1t = main('h1.total');
  const tt = [away, home].map((t) => main('game.teamtotal', t)).filter(Boolean);
  const h1tt = [away, home].map((t) => main('h1.teamtotal', t)).filter(Boolean);
  const label = (f) => b.labels?.[f] || f;
  return html`
    <section class="section"><div class="section-head"><h2>Full game</h2><span class="lede">Main lines · overtime counts</span></div>
      <div class="board card">
        <div class="brow bhead"><div></div><div>${away}</div><div>${home}</div></div>
        ${ml && html`<div class="brow"><div class="bk">Moneyline</div>${N(ml, `${away} win`)}${Y(ml, `${home} win`)}</div>`}
        ${sp && html`<div class="brow"><div class="bk">Spread</div>${N(sp)}${Y(sp)}</div>`}
        ${tot && html`<div class="brow"><div class="bk">Total</div>${Y(tot)}${N(tot)}</div>`}
        ${tt.map((m) => html`<div class="brow"><div class="bk">${m.team} team total</div>${Y(m)}${N(m)}</div>`)}
      </div></section>
    ${(h1home || h1s || h1t) && html`<section class="section"><div class="section-head"><h2>1st half</h2><span class="lede">Ties possible: the 1st-half winner is a three-way market</span></div>
      <div class="board card">
        ${(h1home || h1away) && html`<div class="brow b3"><div class="bk">Winner</div>${h1away ? N(h1away, `${away} win`) : html`<div></div>`}${h1tie ? yesCell(h1tie, 'Tie') : html`<div></div>`}${h1home ? Y(h1home, `${home} win`) : html`<div></div>`}</div>`}
        ${h1s && html`<div class="brow"><div class="bk">Spread</div>${N(h1s)}${Y(h1s)}</div>`}
        ${h1t && html`<div class="brow"><div class="bk">Total</div>${Y(h1t)}${N(h1t)}</div>`}
        ${h1tt.map((m) => html`<div class="brow"><div class="bk">${m.team} team total</div>${Y(m)}${N(m)}</div>`)}
      </div></section>`}
    <section class="section"><div class="section-head"><h2>Every line</h2><span class="lede">Alternate spreads and totals, winning margins, overtime</span></div>
      ${Object.entries(by).map(([f, ms]) => html`<${S.Info} title=${`${label(f)} (${ms.length})`}>
        <div class="lines-list">${ms.map((m) => html`<div class=${`lrow${m.main ? ' main' : ''}`}>${Y(m)}${N(m)}${isNum(m.model) ? html`<div class="lr-model small muted" title="The game model alone, before blending with the market">model ${F.pct(m.model)}</div>` : html`<div class="lr-model small muted">price only</div>`}</div>`)}</div>
      </${S.Info}>`)}
    </section>`;
}

function Props({ d, b, fam, onFam }) {
  const fams = PROP_ORDER.filter((f) => (b.props || {})[f]?.length);
  const [open, setOpen] = useState(null);
  if (!fams.length) return html`<${S.Empty} title="No player props listed yet">Polymarket US and Kalshi list player props during the day before tip; this page fills in as they open.</${S.Empty}>`;
  const f = fams.includes(fam) ? fam : fams[0];
  const st = d.families?.[f]?.status || 'testing';
  const unit = PROP_UNIT[f];
  const tri = (id) => d.tri(id);
  const players = b.props[f];
  return html`
    <div class="row wrap" style="gap:10px;margin:12px 0"><${S.Seg} value=${f} options=${fams.map((x) => [x, b.labels?.[x] || x])} onChange=${onFam}/>
      <span class="spacer"></span><${S.FamilyBadge} st=${st}/></div>
    ${st !== 'live' && html`<div class="small ink2" style="margin-bottom:10px">${b.labels?.[f] || f}: ${f === 'player.pts' ? 'picks are in Testing at this lock time (see the note on Tonight).' : 'shown with fair prices now; picks count only after this market passes the same pre-registered backtest as points (real Kalshi prices, fees included).'}</div>`}
    <div class="card props">
      <div class="prow2 phead2"><div>Player</div><div class="r">Projection</div><div>Main line</div><div>Over</div><div>Under</div></div>
      ${players.map((p) => {
        const main = p.rungs.find((r) => r.main) || p.rungs[Math.floor(p.rungs.length / 2)];
        const key = `${f}:${p.pid}`;
        const isOpen = open === key;
        return html`<div class=${`prow2${isOpen ? ' open' : ''}`} onClick=${() => setOpen(isOpen ? null : key)}>
          <div><b>${p.name}</b> <span class="muted small">${tri(p.team)}</span></div>
          <div class="r">${isNum(p.mu) ? p.mu.toFixed(1) : '—'} <span class="muted small">${p.q?.length ? `${p.q[0]}–${p.q[4]}` : ''}</span></div>
          <div>${main ? `${main.l}` : '—'} <span class="muted small">${p.rungs.length > 1 ? `· ${p.rungs.length} lines` : ''}</span></div>
          <div>${main && html`<${Cell} label=${`Over ${main.l}`} cost=${main.co} venue=${main.ov === 'kalshi' ? 'k' : main.ov} fair=${main.fair} model=${main.model} thin=${main.thin} live=${st === 'live'} leg=${propLeg(b, f, p, main, 'over')}/>`}</div>
          <div>${main && html`<${Cell} label=${`Under ${main.l}`} cost=${main.cu} venue=${main.uv === 'kalshi' ? 'k' : main.uv} fair=${isNum(main.fair) ? 1 - main.fair : null} model=${isNum(main.model) ? 1 - main.model : null} thin=${main.thin} live=${st === 'live'} leg=${propLeg(b, f, p, main, 'under')}/>`}</div>
        </div>
        ${isOpen && html`<div class="ladder"><table class="t"><thead><tr><th>Line</th><th class="r">Fair (over)</th><th class="r">Model</th><th>Over: best</th><th>Under: best</th><th class="r">PM US bid/ask</th><th class="r">Kalshi bid/ask</th></tr></thead>
          <tbody>${p.rungs.map((r) => html`<tr class=${r.main ? 'main' : ''}><td>${r.l} ${unit} <${AddBtn} leg=${propLeg(b, f, p, r, 'over')} t="+O"/> <${AddBtn} leg=${propLeg(b, f, p, r, 'under')} t="+U"/></td><td class="r">${F.pct(r.fair, 1)}</td><td class="r muted">${F.pct(r.model, 1)}</td>
            <td>${isNum(r.co) ? html`${F.odds(r.co, 1)} <span class="muted small">${VS[r.ov] || ''}</span>${isNum(r.fair) && r.fair - r.co >= 0 ? html` <span class="good small">${F.edge(r.fair - r.co, r.fair)}</span>` : ''}` : html`<span class="muted">—</span>`}</td>
            <td>${isNum(r.cu) ? html`${F.odds(r.cu, 1)} <span class="muted small">${VS[r.uv] || ''}</span>${isNum(r.fair) && 1 - r.fair - r.cu >= 0 ? html` <span class="good small">${F.edge(1 - r.fair - r.cu, 1 - r.fair)}</span>` : ''}` : html`<span class="muted small">not sold</span>`}</td>
            <td class="r small">${r.us ? `${F.odds(r.us.b)} / ${F.odds(r.us.a)}` : '—'}</td><td class="r small">${r.k ? `${F.odds(r.k.b)} / ${F.odds(r.k.a)}` : '—'}</td></tr>`)}</tbody></table>
          <div class="tiny muted" style="margin-top:6px">Projection range is the model's 10th–90th percentile. Polymarket US player props only sell the Over; Unders route to Kalshi when it lists the line.</div></div>`}`;
      })}
    </div>`;
}

function AddBtn({ leg, t }) {
  const s = useSlip();
  if (!leg) return null;
  const on = s.some((l) => l.id === leg.id);
  return html`<button class=${`addbtn${on ? ' on' : ''}`} title=${`${on ? 'Remove' : 'Add'} ${leg.label} ${on ? 'from' : 'to'} your combo slip`} onClick=${(e) => { e.stopPropagation(); toggleLeg(leg); }}>${on ? '\u2713' : t}</button>`;
}

// which venue would take this combo, and why not
function venues(legs) {
  const why = { us: [], k: [] };
  for (const l of legs) {
    if (!l.us) why.us.push(`${l.label}: not on Polymarket US${l.kind === 'player' && l.side === 'under' ? ' (props sell only the Over)' : ''}`);
    else if (!l.us.combo) why.us.push(`${l.label}: not combo-eligible there`);
    if (!l.k) why.k.push(`${l.label}: not listed on Kalshi`);
    else if (!l.k.combo) why.k.push(`${l.label}: Kalshi combos take ${l.kind === 'player' ? 'props only as Yes (Over)' : 'this side only as a single'}`);
  }
  const seen = {};
  for (const l of legs.filter((x) => x.kind === 'game')) {
    const k = `${l.g}:${l.fam}`;
    if (seen[k]) why.k.push(`${l.label}: Kalshi allows one leg per game-line market`);
    seen[k] = 1;
  }
  const keys = new Set(legs.filter((l) => l.kind === 'player').map((l) => `${l.g}:${l.pid}:${l.stat}`));
  for (const l of legs.filter((x) => x.stat === 'pra')) {
    if (['pts', 'reb', 'ast'].some((st) => keys.has(`${l.g}:${l.pid}:${st}`))) {
      why.us.push('PRA with its own points/rebounds/assists is a redundant leg');
      why.k.push('PRA with its own points/rebounds/assists is a redundant leg');
    }
  }
  const px = (v) => (legs.every((l) => l[v] && isNum(l[v].px)) ? legs.reduce((a, l) => a * l[v].px, 1) : null);
  return { us: { ok: !why.us.length, why: why.us, price: px('us') }, k: { ok: !why.k.length, why: why.k, price: px('k') } };
}

export function Slip({ d }) {
  const legs = useSlip();
  const [open, setOpen] = useState(false);
  const res = useMemo(() => (legs.length >= 2 && d.joint ? jointProb(legs, d.joint) : null),
    [legs.map((l) => l.id).join(','), !!d.joint]);
  if (!legs.length) return null;
  const v = venues(legs);
  const live = new Set(Object.entries(d.families || {}).filter(([, x]) => x.status === 'live').map(([k]) => k));
  const testing = legs.some((l) => !live.has(l.fam));
  const usCost = isNum(v.us.price) ? v.us.price + comboFee(v.us.price, d.settings?.theta, d.settings?.combo_extra) : null;
  return html`<div class=${`slip${open ? ' open' : ''}`}>
    <button class="slip-tab" onClick=${() => setOpen(!open)}>Combo slip \u00b7 ${legs.length} leg${legs.length === 1 ? '' : 's'}${res ? ` \u00b7 ${F.pct(res.p, 1)} to hit` : ''}</button>
    ${open && html`<div class="slip-body">
      ${legs.map((l) => html`<div class="slip-leg"><div><div>${l.label}</div><div class="tiny muted">fair ${F.pct(l.p)} \u00b7 ${S.labels?.[l.fam] || l.fam}</div></div>
        <button class="sidebtn" onClick=${() => toggleLeg(l)} title="Remove">\u2715</button></div>`)}
      ${legs.length < 2 ? html`<div class="small muted">Add another leg: tap any price on a game page.</div>`
        : !res ? html`<div class="small muted">Correlations aren't available yet.</div>` : html`
        <div class="combo-stats" style="margin-top:8px">
          <div class="bigstat"><div class="k">Chance all hit</div><div class="v">${F.pct(res.p, 1)}</div></div>
          <div class="bigstat"><div class="k">If independent</div><div class="v">${F.pct(res.naive, 1)}</div></div></div>
        ${res.p === 0 && html`<div class="note warn" style="margin-top:6px">These legs can't all win together.</div>`}
        <div class="slip-venues">
          <div><b>Polymarket US</b> ${v.us.ok ? html`<span class="good">takes it</span>${isNum(usCost) ? html` \u00b7 est. ${F.odds(usCost, 1)} incl. combo fee \u2192 <b class=${res.p >= usCost ? 'good' : 'bad'}>${F.signedPct(res.p / usCost - 1, 0)}</b> if the fair chances are right` : ''}`
            : html`<span class="bad">won't take it</span><div class="tiny muted">${v.us.why.slice(0, 3).join(' \u00b7 ')}</div>`}</div>
          <div><b>Kalshi</b> ${v.k.ok ? html`<span class="good">takes it</span>${isNum(v.k.price) ? ` \u00b7 legs multiply to ${F.odds(v.k.price, 1)} before Kalshi's fee` : ''}`
            : html`<span class="bad">won't take it</span><div class="tiny muted">${v.k.why.slice(0, 3).join(' \u00b7 ')}</div>`}</div>
        </div>
        <div class="tiny muted" style="margin-top:6px">Both venues quote combos on request, so the real price can differ (Kalshi parlays have run about 3% per leg above the product of their legs). Assumes everyone plays; \u00b1${F.pct(res.se, 1)} simulation error.${testing ? ' Includes Testing markets: information only.' : ''}</div>`}
      <div class="row" style="margin-top:8px"><button class="btn ghost" onClick=${() => saveSlip([])}>Clear slip</button></div>
    </div>`}
  </div>`;
}

// ------------------------------------------------------------------------ markets browser (#/markets/{family})
function useBoards(d) {
  const ids = (d.games || []).map((g) => g.id).filter((id) => d.board_files?.[id]);
  const [st, setSt] = useState({});
  useEffect(() => {
    let alive = true;
    for (const id of ids) {
      const key = `${id}:${d.board_files[id]}`;
      if (boards[key]) { setSt((s) => ({ ...s, [id]: boards[key] })); continue; }
      fetch(`data/games/${id}.json?h=${d.board_files[id]}`).then((r) => r.json())
        .then((b) => { boards[key] = b; if (alive) setSt((s) => ({ ...s, [id]: b })); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [ids.join(',')]);
  return st;
}

const CATS = [['lines', 'Game lines'], ...PROP_ORDER.map((f) => [f, null])];
export function Markets({ d, cat }) {
  setLive(d);
  const bs = useBoards(d);
  const loaded = Object.values(bs);
  for (const b of loaded) S.labels = { ...(S.labels || {}), ...(b.labels || {}) };
  const have = new Set(loaded.flatMap((b) => Object.keys(b.props || {})));
  const cats = CATS.filter(([f]) => f === 'lines' || have.has(f)).map(([f, l]) => [f, l || S.labels?.[f] || f]);
  const c = cats.some(([f]) => f === cat) ? cat : 'lines';
  const games = (d.games || []).filter((g) => bs[g.id]);
  return html`<main class="page">
    <${S.Hero} d=${d} kicker="Every market" title="Markets" sub="Every line tonight, both venues side by side, by category. Tap a price to add it to your combo slip."/>
    <div class="row wrap" style="gap:10px;margin:6px 0 14px"><${S.Seg} value=${c} options=${cats} onChange=${(f) => { location.hash = `#/markets/${f}`; }}/>
      <span class="spacer"></span><${S.FamilyBadge} st=${c === 'lines' ? 'testing' : (d.families?.[c]?.status || 'testing')}/></div>
    ${!games.length ? html`<div class="card pad muted">Loading markets…</div>` : games.map((g) => {
      const b = bs[g.id];
      const away = d.tri(g.away), home = d.tri(g.home);
      if (c === 'lines') {
        const mains = (f) => (b.lines || []).find((m) => m.f === f && m.main);
        const ml = mains('game.ml'), sp = mains('game.spread'), tot = mains('game.total');
        const Y = (m, l) => yesCell(m, l, false, lineLeg(b, home, m, 'yes'));
        const N = (m, l) => noCell(m, l, false, lineLeg(b, home, m, 'no'));
        return html`<div class="card board mk-game"><div class="mk-head"><${S.TeamChip} tri=${away}/><span class="muted">@</span><${S.TeamChip} tri=${home}/>
            <span class="small muted">${F.timeET(g.tip)}</span><span class="spacer"></span><a class="small" href=${`#/game/${g.id}`}>All ${b.lines.length} lines →</a></div>
          ${ml && html`<div class="brow"><div class="bk">Moneyline</div>${N(ml, `${away} win`)}${Y(ml, `${home} win`)}</div>`}
          ${sp && html`<div class="brow"><div class="bk">Spread</div>${N(sp)}${Y(sp)}</div>`}
          ${tot && html`<div class="brow"><div class="bk">Total</div>${Y(tot)}${N(tot)}</div>`}</div>`;
      }
      const players = (b.props || {})[c] || [];
      if (!players.length) return null;
      const st = d.families?.[c]?.status || 'testing';
      return html`<div class="card props mk-game"><div class="mk-head"><${S.TeamChip} tri=${away}/><span class="muted">@</span><${S.TeamChip} tri=${home}/>
          <span class="small muted">${F.timeET(g.tip)}</span><span class="spacer"></span><a class="small" href=${`#/game/${g.id}/props/${c}`}>Full ladders →</a></div>
        ${players.map((p) => { const m = p.rungs.find((r) => r.main) || p.rungs[0]; return html`<div class="prow2">
          <div><b>${p.name}</b> <span class="muted small">${d.tri(p.team)}</span></div>
          <div class="r">${isNum(p.mu) ? p.mu.toFixed(1) : '—'}</div><div>${m.l}</div>
          <div><${Cell} label=${`Over ${m.l}`} cost=${m.co} venue=${m.ov === 'kalshi' ? 'k' : m.ov} fair=${m.fair} model=${m.model} thin=${m.thin} live=${st === 'live'} leg=${propLeg(b, c, p, m, 'over')}/></div>
          <div><${Cell} label=${`Under ${m.l}`} cost=${m.cu} venue=${m.uv === 'kalshi' ? 'k' : m.uv} fair=${isNum(m.fair) ? 1 - m.fair : null} model=${isNum(m.model) ? 1 - m.model : null} thin=${m.thin} live=${st === 'live'} leg=${propLeg(b, c, p, m, 'under')}/></div></div>`; })}
      </div>`;
    })}
  </main>`;
}
