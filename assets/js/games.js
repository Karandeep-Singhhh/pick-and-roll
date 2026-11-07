// Game boards: every game line and every player-prop ladder for one game, both venues side by side (data/games/{id}.json),
// plus the game cards on Tonight. Shared components come from app.js through init() (no circular imports).
import { html, useState, useEffect, useMemo } from '../vendor/preact-htm.mjs';
import * as F from './fmt.js';
import { jointProb, comboFee } from './combo.js';
import * as C from './charts.js';

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
export const setSlip = (legs) => saveSlip(legs);
export const toggleLeg = (leg) => saveSlip(slip.some((l) => l.id === leg.id) ? slip.filter((l) => l.id !== leg.id) : [...slip, leg]);
export function useSlip() {
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

// a board row's name links to that line's full detail page; a player's name to his page on that stat
function BK({ gid, m, t }) {
  const h = lineHref(gid, m, (m.en ?? -9) > (m.ey ?? -9) ? 'no' : 'yes');
  return html`<div class="bk">${h ? html`<a href=${h} title="Full breakdown: projection, distribution, recent games, injuries">${t} <span class="muted">›</span></a>` : t}</div>`;
}
const statHref = (gid, pid, fam, line) => `#/player/${gid}/${pid}/${fam.split('.')[1]}${isNum(line) ? `/${line}` : ''}`;

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
const isLive = (m) => S.liveFams?.has(m.f) && m.ck;  // value only on a line whose real book was read
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
  const rows = (d.fam_picks || []).filter((p) => p.tier === 'pick' && p.st !== 'live');  // Live ones are headline picks
  if (!rows.length) return null;
  const by = {};
  for (const p of rows) (by[p.fam] ||= []).push(p);
  const label = (f) => d.families?.[f]?.label || (d.fam_labels || {})[f] || f;
  return html`<${S.Info} title=${`Picks in other markets: rebounds, assists, game lines… (${rows.length}, all Testing until their backtests pass)`}>
    <div class="small ink2" style="margin-bottom:8px">Same bar as the points picks (fair chance beats the all-in price, tight fresh book, priced 25–80%). These families haven't passed their pre-registered backtest yet, so they're shown for information and tracked separately.</div>
    ${Object.entries(by).map(([f, ps]) => html`<div class="fp-group"><div class="fp-head"><b>${label(f)}</b> <${S.FamilyBadge} st=${ps[0].st}/></div>
      <table class="t"><tbody>${ps.sort((a, b) => (b.edge || 0) - (a.edge || 0)).map((p) => html`<tr class="click" onClick=${() => S.goPick(p)}>
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
  const setTab = (t, f) => S.go(`#/game/${gid}/${t}${f ? `/${f}` : ''}`, true);  // a view switch, not a new page
  return html`<main class="page">
    <${S.BackLink} d=${d} fallback="#/" label="Tonight"/>
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
        ${ml && html`<div class="brow"><${BK} gid=${b.id} m=${ml} t="Moneyline"/>${N(ml, `${away} win`)}${Y(ml, `${home} win`)}</div>`}
        ${sp && html`<div class="brow"><${BK} gid=${b.id} m=${sp} t="Spread"/>${N(sp)}${Y(sp)}</div>`}
        ${tot && html`<div class="brow"><${BK} gid=${b.id} m=${tot} t="Total"/>${Y(tot)}${N(tot)}</div>`}
        ${tt.map((m) => html`<div class="brow"><${BK} gid=${b.id} m=${m} t=${`${m.team} team total`}/>${Y(m)}${N(m)}</div>`)}
      </div></section>
    ${(h1home || h1s || h1t) && html`<section class="section"><div class="section-head"><h2>1st half</h2><span class="lede">Ties possible: the 1st-half winner is a three-way market</span></div>
      <div class="board card">
        ${(h1home || h1away) && html`<div class="brow b3"><div class="bk">Winner</div>${h1away ? N(h1away, `${away} win`) : html`<div></div>`}${h1tie ? yesCell(h1tie, 'Tie') : html`<div></div>`}${h1home ? Y(h1home, `${home} win`) : html`<div></div>`}</div>`}
        ${h1s && html`<div class="brow"><${BK} gid=${b.id} m=${h1s} t="Spread"/>${N(h1s)}${Y(h1s)}</div>`}
        ${h1t && html`<div class="brow"><${BK} gid=${b.id} m=${h1t} t="Total"/>${Y(h1t)}${N(h1t)}</div>`}
        ${h1tt.map((m) => html`<div class="brow"><${BK} gid=${b.id} m=${m} t=${`${m.team} team total`}/>${Y(m)}${N(m)}</div>`)}
      </div></section>`}
    <section class="section"><div class="section-head"><h2>Every line</h2><span class="lede">Alternate spreads and totals, winning margins, overtime</span></div>
      ${Object.entries(by).map(([f, ms]) => html`<${S.Info} id=${`lines:${b.id}:${f}`} title=${`${label(f)} (${ms.length})`}>
        <div class="lines-list">${ms.map((m) => html`<div class=${`lrow${m.main ? ' main' : ''}`}>${Y(m)}${N(m)}${isNum(m.model) ? html`<div class="lr-model small muted" title="The game model alone, before blending with the market">model ${F.pct(m.model)}${lineHref(b.id, m, 'yes') ? html` · <a href=${lineHref(b.id, m, 'yes')}>details →</a>` : ''}</div>` : html`<div class="lr-model small muted">price only</div>`}</div>`)}</div>
      </${S.Info}>`)}
    </section>`;
}

// value side of a prop's main rung: 'over' / 'under' when that side's all-in price is below its fair chance
const valueSide = (r) => (!r || !isNum(r.fair) ? null : isNum(r.co) && r.fair - r.co >= 0 ? 'over'
  : isNum(r.cu) && 1 - r.fair - r.cu >= 0 ? 'under' : null);
const mainRung = (p) => p.rungs.find((r) => r.main) || p.rungs[Math.floor(p.rungs.length / 2)];
const PROP_OPEN = {};      // game:family -> the player whose ladder is open (kept while you look at a line and come back)
const PROP_FILTER = { q: '', value: 'all' };  // shared by the game pages and Markets (kept across pages)
function PropFilters({ f, set, n, total }) {
  return html`<div class="filters">
    <input class="input" placeholder="Search a player" value=${f.q} onInput=${(e) => set({ ...f, q: e.target.value })} style="width:190px"/>
    <${S.Seg} value=${f.value} onChange=${(v) => set({ ...f, value: v })} options=${[['all', 'All players'], ['over', 'Value on the Over'], ['under', 'Value on the Under']]}/>
    <span class="small muted">${n} of ${total}</span>
  </div>`;
}
function filterPlayers(players, f) {
  const q = f.q.trim().toLowerCase();
  return players.filter((p) => (!q || (p.name || '').toLowerCase().includes(q)) && (f.value === 'all' || valueSide(mainRung(p)) === f.value));
}
function usePropFilter() {
  const [f, setF] = useState({ ...PROP_FILTER });
  return [f, (x) => { Object.assign(PROP_FILTER, x); setF({ ...x }); }];
}

function Props({ d, b, fam, onFam }) {
  const fams = PROP_ORDER.filter((f) => (b.props || {})[f]?.length);
  const [pf, setPf] = usePropFilter();
  const [openKey, setOpenKey] = useState(null);
  if (!fams.length) return html`<${S.Empty} title="No player props listed yet">Polymarket US and Kalshi list player props during the day before tip; this page fills in as they open.</${S.Empty}>`;
  const f = fams.includes(fam) ? fam : fams[0];
  const st = d.families?.[f]?.status || 'testing';
  const unit = PROP_UNIT[f];
  const tri = (id) => d.tri(id);
  const okey = `${b.id}:${f}`;
  const open = openKey ?? PROP_OPEN[okey] ?? null;
  const setOpen = (k) => { PROP_OPEN[okey] = k; setOpenKey(k); };
  const players = filterPlayers(b.props[f], pf);
  return html`
    <div class="row wrap" style="gap:10px;margin:12px 0"><${S.Seg} value=${f} options=${fams.map((x) => [x, b.labels?.[x] || x])} onChange=${onFam}/>
      <span class="spacer"></span><${S.FamilyBadge} st=${st}/></div>
    ${st !== 'live' && html`<div class="small ink2" style="margin-bottom:10px">${b.labels?.[f] || f}: ${f === 'player.pts' ? 'picks are in Testing at this lock time (see the note on Tonight).' : 'shown with fair prices now; picks count only after this market passes the same pre-registered backtest as points (real Kalshi prices, fees included).'}</div>`}
    <${PropFilters} f=${pf} set=${setPf} n=${players.length} total=${b.props[f].length}/>
    <div class="card props">
      <div class="prow2 phead2"><div>Player</div><div class="r">Projection</div><div>Main line</div><div>Over</div><div>Under</div></div>
      ${!players.length && html`<div class="small muted" style="padding:14px">No players match these filters.</div>`}
      ${players.map((p) => {
        const main = mainRung(p);
        const key = `${f}:${p.pid}`;
        const isOpen = open === key;
        return html`<div class=${`prow2${isOpen ? ' open' : ''}`} onClick=${() => setOpen(isOpen ? null : key)}>
          <div><a class="plink" href=${statHref(b.id, p.pid, f, main?.l)} onClick=${(e) => e.stopPropagation()}><b>${p.name}</b></a> <span class="muted small">${tri(p.team)}</span></div>
          <div class="r">${isNum(p.mu) ? p.mu.toFixed(1) : '—'} <span class="muted small">${p.q?.length ? `${p.q[0]}–${p.q[4]}` : ''}</span></div>
          <div>${main ? `${main.l}` : '—'} <span class="muted small">${p.rungs.length > 1 ? `· ${p.rungs.length} lines` : ''}</span></div>
          <div>${main && html`<${Cell} label=${`Over ${main.l}`} cost=${main.co} venue=${main.ov === 'kalshi' ? 'k' : main.ov} fair=${main.fair} model=${main.model} thin=${main.thin} live=${st === 'live' && main.ck} leg=${propLeg(b, f, p, main, 'over')}/>`}</div>
          <div>${main && html`<${Cell} label=${`Under ${main.l}`} cost=${main.cu} venue=${main.uv === 'kalshi' ? 'k' : main.uv} fair=${isNum(main.fair) ? 1 - main.fair : null} model=${isNum(main.model) ? 1 - main.model : null} thin=${main.thin} live=${st === 'live' && main.ck} leg=${propLeg(b, f, p, main, 'under')}/>`}</div>
        </div>
        ${isOpen && html`<div class="ladder"><table class="t"><thead><tr><th>Line</th><th class="r">Fair (over)</th><th class="r">Model</th><th>Over: best</th><th>Under: best</th><th class="r">PM US bid/ask</th><th class="r">Kalshi bid/ask</th></tr></thead>
          <tbody>${p.rungs.map((r) => html`<tr class=${r.main ? 'main' : ''}><td><a href=${statHref(b.id, p.pid, f, r.l)}>${r.l} ${unit}</a> <${AddBtn} leg=${propLeg(b, f, p, r, 'over')} t="+O"/> <${AddBtn} leg=${propLeg(b, f, p, r, 'under')} t="+U"/></td><td class="r">${F.pct(r.fair, 1)}</td><td class="r muted">${F.pct(r.model, 1)}</td>
            <td>${isNum(r.co) ? html`${F.odds(r.co, 1)} <span class="muted small">${VS[r.ov] || ''}</span>${isNum(r.fair) && r.fair - r.co >= 0 ? html` <span class="good small">${F.edge(r.fair - r.co, r.fair)}</span>` : ''}` : html`<span class="muted">—</span>`}</td>
            <td>${isNum(r.cu) ? html`${F.odds(r.cu, 1)} <span class="muted small">${VS[r.uv] || ''}</span>${isNum(r.fair) && 1 - r.fair - r.cu >= 0 ? html` <span class="good small">${F.edge(1 - r.fair - r.cu, 1 - r.fair)}</span>` : ''}` : html`<span class="muted small">not sold</span>`}</td>
            <td class="r small">${r.us ? `${F.odds(r.us.b)} / ${F.odds(r.us.a)}` : '—'}</td><td class="r small">${r.k ? `${F.odds(r.k.b)} / ${F.odds(r.k.a)}` : '—'}</td></tr>`)}</tbody></table>
          <div class="tiny muted" style="margin-top:6px">Projection range is the model's 10th–90th percentile. Polymarket US player props only sell the Over; Unders route to Kalshi when it lists the line. <a href=${statHref(b.id, p.pid, f, main?.l)}>Full breakdown for ${p.name} →</a></div></div>`}`;
      })}
    </div>`;
}

// "Add to your combo slip": both sides of the line on a detail page, as the same tappable cells as the boards
function SlipBox({ children, note }) {
  return html`<div class="card pad slipbox"><div class="row wrap" style="gap:8px;align-items:baseline"><b>Add to your combo slip</b>
      <span class="small muted">Tap a side to add it, tap again to remove. The slip opens at the bottom of the screen.</span></div>
    <div class="slipcells">${children}</div>${note && html`<div class="tiny muted" style="margin-top:6px">${note}</div>`}</div>`;
}
export function PropSlip({ d, b, fam, pid, line }) {
  setLive(d);
  const pl = (b.props?.[fam] || []).find((x) => x.pid === pid);
  const r = pl?.rungs.find((x) => x.l === line);
  if (!pl || !r) return null;
  const st = d.families?.[fam]?.status || 'testing';
  const over = propLeg(b, fam, pl, r, 'over');
  return html`<${SlipBox} note=${!over ? 'This line has no fair price yet (no real two-sided book), so it can\'t go in the slip.' : null}>
    <${Cell} label=${`Over ${r.l}`} cost=${r.co} venue=${r.ov === 'kalshi' ? 'k' : r.ov} fair=${r.fair} model=${r.model} thin=${r.thin} live=${st === 'live' && r.ck} leg=${over}/>
    <${Cell} label=${`Under ${r.l}`} cost=${r.cu} venue=${r.uv === 'kalshi' ? 'k' : r.uv} fair=${isNum(r.fair) ? 1 - r.fair : null} model=${isNum(r.model) ? 1 - r.model : null} thin=${r.thin} live=${st === 'live' && r.ck} leg=${propLeg(b, fam, pl, r, 'under')}/>
  </${SlipBox}>`;
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
  let legs = useSlip();
  // legs from games no longer on tonight's board (tipped, finished) expire: their fair chances are stale
  const onBoard = new Set((d.games || []).filter((g) => !g.tip || new Date(g.tip) > Date.now()).map((g) => g.id));
  if (d.games && legs.some((l) => !onBoard.has(l.g))) {
    legs = legs.filter((l) => onBoard.has(l.g));
    setTimeout(() => saveSlip(legs), 0);
  }
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
const MK = { game: 'all', lines: 'all' };  // Markets filters, kept while you open a line and come back
const hasValue = (m) => (isNum(m.ey) && m.ey >= 0) || (isNum(m.en) && m.en >= 0);
export function Markets({ d, cat }) {
  setLive(d);
  const bs = useBoards(d);
  const loaded = Object.values(bs);
  for (const b of loaded) S.labels = { ...(S.labels || {}), ...(b.labels || {}) };
  const have = new Set(loaded.flatMap((b) => Object.keys(b.props || {})));
  const cats = CATS.filter(([f]) => f === 'lines' || have.has(f)).map(([f, l]) => [f, l || S.labels?.[f] || f]);
  const c = cats.some(([f]) => f === cat) ? cat : 'lines';
  const games = (d.games || []).filter((g) => bs[g.id]);
  const [pf, setPf] = usePropFilter();
  const [gsel, setGselState] = useState(MK.game);
  const setGsel = (v) => { MK.game = v; setGselState(v); };
  const [lv, setLvState] = useState(MK.lines);
  const setLv = (v) => { MK.lines = v; setLvState(v); };
  return html`<main class="page">
    <${S.Hero} d=${d} kicker="Every market" title="Markets" sub="Every line tonight, both venues side by side, by category. Tap a price to add it to your combo slip."/>
    <div class="row wrap" style="gap:10px;margin:6px 0 10px"><${S.Seg} value=${c} options=${cats} onChange=${(f) => S.go(`#/markets/${f}`, true)}/>
      <span class="spacer"></span><${S.FamilyBadge} st=${c === 'lines' ? 'testing' : (d.families?.[c]?.status || 'testing')}/></div>
    <div class="filters">
      <${S.Select} label="Game" value=${gsel} onChange=${setGsel} options=${[['all', 'All games'], ...(d.games || []).map((g) => [g.id, `${d.tri(g.away)} @ ${d.tri(g.home)} · ${F.timeET(g.tip)}`])]}/>
      ${c !== 'lines' && html`<input class="input" placeholder="Search a player" value=${pf.q} onInput=${(e) => setPf({ ...pf, q: e.target.value })} style="width:190px"/>
        <${S.Seg} value=${pf.value} onChange=${(v) => setPf({ ...pf, value: v })} options=${[['all', 'All players'], ['over', 'Value on the Over'], ['under', 'Value on the Under']]}/>`}
      ${c === 'lines' && html`<${S.Seg} value=${lv} onChange=${setLv} options=${[['all', 'All lines'], ['value', 'Only sides with value']]}/>`}
    </div>
    ${!games.length ? html`<div class="card pad muted">Loading markets…</div>` : games.filter((g) => gsel === 'all' || g.id === gsel).map((g) => {
      const b = bs[g.id];
      const away = d.tri(g.away), home = d.tri(g.home);
      if (c === 'lines') {
        const mains = (f) => (b.lines || []).find((m) => m.f === f && m.main);
        const [ml, sp, tot] = ['game.ml', 'game.spread', 'game.total'].map(mains).map((m) => (m && (lv === 'all' || hasValue(m)) ? m : null));
        if (lv !== 'all' && !ml && !sp && !tot) return null;
        const Y = (m, l) => yesCell(m, l, false, lineLeg(b, home, m, 'yes'));
        const N = (m, l) => noCell(m, l, false, lineLeg(b, home, m, 'no'));
        return html`<div class="card board mk-game"><div class="mk-head"><${S.TeamChip} tri=${away}/><span class="muted">@</span><${S.TeamChip} tri=${home}/>
            <span class="small muted">${F.timeET(g.tip)}</span><span class="spacer"></span><a class="small" href=${`#/game/${g.id}`}>All ${b.lines.length} lines →</a></div>
          ${ml && html`<div class="brow"><${BK} gid=${g.id} m=${ml} t="Moneyline"/>${N(ml, `${away} win`)}${Y(ml, `${home} win`)}</div>`}
          ${sp && html`<div class="brow"><${BK} gid=${g.id} m=${sp} t="Spread"/>${N(sp)}${Y(sp)}</div>`}
          ${tot && html`<div class="brow"><${BK} gid=${g.id} m=${tot} t="Total"/>${Y(tot)}${N(tot)}</div>`}</div>`;
      }
      const players = filterPlayers((b.props || {})[c] || [], pf);
      if (!players.length) return null;
      const st = d.families?.[c]?.status || 'testing';
      return html`<div class="card props mk-game"><div class="mk-head"><${S.TeamChip} tri=${away}/><span class="muted">@</span><${S.TeamChip} tri=${home}/>
          <span class="small muted">${F.timeET(g.tip)}</span><span class="spacer"></span><a class="small" href=${`#/game/${g.id}/props/${c}`}>Full ladders →</a></div>
        ${players.map((p) => { const m = p.rungs.find((r) => r.main) || p.rungs[0]; return html`<div class="prow2">
          <div><a class="plink" href=${statHref(g.id, p.pid, c, m.l)}><b>${p.name}</b></a> <span class="muted small">${d.tri(p.team)}</span></div>
          <div class="r">${isNum(p.mu) ? p.mu.toFixed(1) : '—'}</div><div>${m.l}</div>
          <div><${Cell} label=${`Over ${m.l}`} cost=${m.co} venue=${m.ov === 'kalshi' ? 'k' : m.ov} fair=${m.fair} model=${m.model} thin=${m.thin} live=${st === 'live' && m.ck} leg=${propLeg(b, c, p, m, 'over')}/></div>
          <div><${Cell} label=${`Under ${m.l}`} cost=${m.cu} venue=${m.uv === 'kalshi' ? 'k' : m.uv} fair=${isNum(m.fair) ? 1 - m.fair : null} model=${isNum(m.model) ? 1 - m.model : null} thin=${m.thin} live=${st === 'live' && m.ck} leg=${propLeg(b, c, p, m, 'under')}/></div></div>`; })}
      </div>`;
    })}
  </main>`;
}

// ------------------------------------------------------------------------ one game line in full (#/line/{game}/{market}/{side})
const flipSide = (s) => (s === 'yes' ? 'no' : 'yes');
const VFULL = { us: 'Polymarket US', k: 'Kalshi', kalshi: 'Kalshi' };
// link to a board line's page; ids are venue market ids, sides are that venue's (a flipped venue's Yes is the row's No)
export const lineHref = (gid, m, side) => {
  const x = m.v?.us || m.v?.k;
  return x ? S.lineHash(gid, x.id, x.fl ? flipSide(side) : side) : null;
};
function findLine(b, mid) {
  for (const m of b.lines || []) for (const x of Object.values(m.v || {})) if (String(x.id) === String(mid)) return { m, fl: !!x.fl };
  return null;
}
const cdfMean = (c) => (c?.c?.length ? c.c.reduce((a, v, k) => a + (c.o + k) * (v - (k ? c.c[k - 1] : 0)), 0) : null);
const cdfQ = (c, p) => (c?.c?.length ? c.o + c.c.findIndex((v) => v >= p) : null);
const VAR_NAME = { margin: 'final margin', total: 'total points', home: 'points', away: 'points', h1_margin: '1st-half margin',
  h1_total: '1st-half total', h1_home: '1st-half points', h1_away: '1st-half points' };
const GAME_NOTE = "Game lines are information only for now: the game model misses the final margin by about 14 points on average (closing lines miss by 12–12.5), short of its pre-registered target, so the fair chance leans mostly on the market price.";

// one team's recent game seen in tonight's role: what the bet's variable would have been (home margin, total, ...)
function teamItems(rows, v, role, lo, hi, yes) {
  const H = v.startsWith('h1_');
  const base = v.replace('h1_', '');
  return rows.map((r) => {
    const a = H ? r[4] : r[2], b = H ? r[5] : r[3];
    if (!isNum(a) || !isNum(b)) return null;
    const rv = base === 'total' ? a + b : base === 'margin' ? (role === 'home' ? a - b : b - a) : (base === role ? a : b);
    const inside = (lo == null || rv > lo) && (hi == null || rv < hi);
    const shown = base === 'margin' ? a - b : base === 'total' ? a + b : (base === role ? a : b);
    return { date: r[0], label: r[1].replace('vs ', '').replace('@ ', '@'), v: shown, hit: yes ? inside : !inside,
      tip: `${r[0]} ${r[1]}: ${a}–${b}${H ? ' at the half' : ''}` };
  }).filter(Boolean);
}
// thresholds drawn on a team's own scale (an away team's margin is the negative of tonight's home margin)
const ownLines = (v, role, lo, hi) => {
  const flip = v.replace('h1_', '') === 'margin' && role === 'away';
  return [lo, hi].filter((x) => x != null).map((x) => (flip ? -x : x));
};
const SHOWN = { margin: 'own margin', total: 'total points', home: 'points', away: 'points' };

export function LinePage({ d, gid, mid, side: sideArg }) {
  setLive(d);
  const g = d.gameById[gid];
  const { board: b, error } = useBoard(gid, d.board_files?.[gid]);
  const [tab, setTab] = useState('recent');
  if (!g) return html`<main class="page"><a class="back" href="#/">← Tonight</a><${S.Empty} title="That game isn't on tonight's board">It may have finished.</${S.Empty}></main>`;
  const back = html`<div class="row wrap" style="gap:14px"><${S.BackLink} d=${d} fallback=${`#/game/${gid}`} label=${`${d.tri(g.away)} @ ${d.tri(g.home)}`}/>
    ${S.prevGame?.() !== gid && html`<a class="back" href=${`#/game/${gid}`}>${d.tri(g.away)} @ ${d.tri(g.home)}: every market →</a>`}</div>`;
  if (!b) return html`<main class="page">${back}${error ? html`<${S.Empty} title="Couldn't load this game">${error}</${S.Empty}>` : html`<div class="card pad muted">Loading…</div>`}</main>`;
  if (b.labels) S.labels = { ...(S.labels || {}), ...b.labels };
  const found = findLine(b, mid);
  if (!found) return html`<main class="page">${back}<${S.Empty} title="That line isn't listed anymore">The venues may have closed it. <a href=${`#/game/${gid}`}>See every line in this game</a>.</${S.Empty}></main>`;
  const { m, fl } = found;
  const away = d.tri(g.away), home = d.tri(g.home);
  const s0 = sideArg === 'yes' || sideArg === 'no' ? (fl ? flipSide(sideArg) : sideArg)
    : ((m.en ?? -9) > (m.ey ?? -9) ? 'no' : 'yes');
  const yes = s0 === 'yes';
  const label = yes ? m.ys : m.ns;
  const fair = isNum(m.fair) ? (yes ? m.fair : 1 - m.fair) : null;
  const model = isNum(m.model) ? (yes ? m.model : 1 - m.model) : null;
  const mkt = isNum(m.mid) ? (yes ? m.mid : 1 - m.mid) : null;
  const cost = yes ? m.cy : m.cn;
  const ven = yes ? m.vy : m.vn;
  const edge = yes ? m.ey : m.en;
  const v = gameVar(m.f, m.team, home);
  const det = b.game || {};
  const cd = v ? det.cdf?.[v] : null;
  const mean = cdfMean(cd);
  const st = d.families?.[m.f]?.status || 'testing';
  const ids = Object.values(m.v || {}).map((x) => String(x.id));
  const pick = (d.fam_picks || []).find((x) => x.g === gid && x.fam === m.f && ids.includes(String(x.m)) && x.tier === 'pick');
  const pickSide = pick ? (m.v.us && String(m.v.us.id) === String(pick.m) ? (m.v.us.fl ? flipSide(pick.side) : pick.side)
    : (m.v.k?.fl ? flipSide(pick.side) : pick.side)) : null;
  const pj = b.proj || {};
  const H1 = m.f.startsWith('h1.');
  const ph = H1 ? pj.h1_home : pj.home, pa = H1 ? pj.h1_away : pj.away;
  const lo = m.lo, hi = m.hi;
  // the bet's winning range on the variable (No = the complement)
  const lead = isNum(ph) && isNum(pa) ? (ph >= pa ? `${home} by ${(ph - pa).toFixed(1)}` : `${away} by ${(pa - ph).toFixed(1)}`) : null;
  const take = [];
  if (isNum(ph) && isNum(pa)) take.push(html`The model projects <b>${away} ${pa.toFixed(0)} – ${home} ${ph.toFixed(0)}</b>${H1 ? ' at halftime' : ' in regulation'} (${lead}${!H1 && isNum(pj.win_home) ? `; ${home} wins ${F.pct(pj.win_home)} of the time` : ''}). `);
  if (isNum(mean) && v) take.push(html`Its average ${VAR_NAME[v]}${v === 'home' ? ` for ${home}` : v === 'away' ? ` for ${away}` : ''} is <b>${v.includes('margin') ? `${mean >= 0 ? home : away} by ${Math.abs(mean).toFixed(1)}` : mean.toFixed(1)}</b>${v.includes('margin') ? ` (80% range: ${cdfQ(cd, 0.1)} to ${cdfQ(cd, 0.9)}, home minus away)` : ` (80% range ${cdfQ(cd, 0.1)}–${cdfQ(cd, 0.9)})`}. `);
  take.push(isNum(fair) ? html`For <b>${label}</b> the fair chance is <b>${F.pct(fair)}</b> (model alone ${F.pct(model)}) against a market at ${F.pct(mkt)}. `
    : html`For <b>${label}</b> there's no real two-sided book right now, so no fair chance; the model alone says ${F.pct(model)}. `);
  if (pick && pickSide === s0) take.push(html`That's one of tonight's <b>picks</b>${pick.st !== 'live' ? ' (Testing)' : ''}: an edge of ${F.edge(pick.edge, pick.p)} after the fee on ${VFULL[pick.venue] || 'its venue'}. `);
  else if (pick) take.push(html`Tonight's pick on this line is the other side: <b>${pickSide === 'yes' ? m.ys : m.ns}</b>. `);
  else if (isNum(edge) && edge >= 0) take.push(html`There's a small edge (${F.edge(edge, fair)}), but it doesn't pass every filter (spread, price range, verified order book). `);
  else if (isNum(edge)) take.push(html`After the spread and fee there's <b>no edge</b> here (${F.edge(edge, fair)}). `);
  const fams = (b.lines || []).filter((x) => x.f === m.f && (x.team || null) === (m.team || null));
  const ladder = fams.filter((x) => x.hi == null && x.lo != null).sort((a, z) => a.lo - z.lo).map((x) => {
    const bk = x.v.us || x.v.k || {};
    return { line: x.lo, tick: x.lo, label: x.ys, fair: x.fair, model: x.model, mid: x.mid, bid: bk.b, ask: bk.a };
  });
  const setSide = (s) => S.go(lineHref(gid, m, s), true);
  const yesWord = yes ? label : m.ys, noWord = yes ? m.ns : label;
  return html`<main class="page">
    ${back}
    <div class="phead">
      <div><div class="row small ink2" style="gap:6px;margin-bottom:6px"><${S.TeamChip} tri=${away}/> @ <${S.TeamChip} tri=${home}/> · ${F.dayET(g.tip)} ${F.timeET(g.tip)} · locks ${F.timeET(g.lock)}</div>
        <h1>${label}</h1><div class="small ink2">${S.labels?.[m.f] || m.f}${m.main ? ' · main line' : ''}</div></div>
      <span class="spacer"></span><${S.FamilyBadge} st=${st}/>
    </div>
    <div class="toolbar" style="margin-top:14px"><span class="small ink2">Side</span>
      <${S.Seg} value=${s0} onChange=${setSide} options=${[['yes', m.ys], ['no', m.ns]]}/></div>
    <div class="callout take" style="margin-top:8px"><div class="up muted" style="margin-bottom:4px">The model's take</div><div>${take}</div>
      <div class="small ink2" style="margin-top:6px">${GAME_NOTE}</div></div>
    <div class="tiles" style="margin-top:14px">
      <div class="tile"><div class="k">Projected score</div><div class="v" style="font-size:22px">${isNum(pa) ? `${pa.toFixed(0)}–${ph.toFixed(0)}` : '—'}</div><div class="s">${away}–${home}${H1 ? ' at the half' : ''}</div></div>
      <div class="tile"><div class="k">Fair · ${label}</div><div class="v over"><${S.OddsV} p=${fair}/></div><div class="s">model alone ${F.odds(model)}</div></div>
      <div class="tile"><div class="k">Market</div><div class="v"><${S.OddsV} p=${mkt}/></div><div class="s">midpoint of the real book</div></div>
      <div class="tile"><div class="k">Best price</div><div class="v"><${S.OddsV} p=${cost}/></div><div class="s">${isNum(cost) ? `all-in on ${VFULL[ven] || '—'}` : 'not sold right now'}</div></div>
      <div class="tile"><div class="k">Edge</div><div class=${`v ${isNum(edge) && edge >= 0 ? 'good' : ''}`}>${F.oddsMode() === 'us' ? (isNum(fair) ? `fair ${F.american(fair)}` : '—') : F.signedPct(edge)}</div><div class="s">after the fee</div></div>
      <div class="tile"><div class="k">How to place</div><div class="v" style="font-size:16px">${isNum(cost) ? html`Buy <b>${label}</b>` : '—'}</div><div class="s">${isNum(cost) ? `on ${VFULL[ven]} at ${F.odds(cost, 1)} incl. fee` : ''}</div></div>
    </div>
    <${SlipBox} note=${!lineLeg(b, home, m, 'yes') ? 'This line has no fair price yet (no real two-sided book), so it can\'t go in the slip.' : null}>
      ${yesCell(m, m.ys, false, lineLeg(b, home, m, 'yes'))}${noCell(m, m.ns, false, lineLeg(b, home, m, 'no'))}</${SlipBox}>
    <div class="grid g2" style="margin-top:14px">
      <div class="card chartcard"><h3>${v ? `The model's ${VAR_NAME[v]}${v === 'home' ? ` (${home})` : v === 'away' ? ` (${away})` : ''}` : 'Distribution'}</h3>
        <p class="cap">${v?.includes('margin') ? `Home minus away (${home} − ${away}); blue = this bet wins. ` : 'Blue = this bet wins. '}Overtime is included where the venue counts it.</p>
        ${cd ? html`<${C.DistRange} cdf=${cd.c} o=${cd.o} lo=${lo} hi=${hi} invert=${!yes} unit=${VAR_NAME[v]} yesLabel=${`${label} (model alone)`} noLabel=${yes ? m.ns : m.ys} mark=${mean}/>`
          : html`<div class="muted small" style="padding:20px 0">${v ? 'Loading the distribution…' : 'The game model doesn\'t price this market; prices only.'}</div>`}</div>
      <div class="card chartcard"><h3>Every ${S.labels?.[m.f]?.toLowerCase() || 'line'}${m.team ? ` for ${m.team}` : ''}</h3><p class="cap">${m.f.includes('spread') || m.f.includes('ml') ? `Chance ${home} wins by more than each margin (negative = ${home} can lose by up to that many): fair chance vs market.` : 'Chance of going over each line: fair chance vs market.'}</p>
        ${ladder.length >= 2 ? html`<${C.Ladder} rows=${ladder} sel=${m.lo}/>` : html`<div class="muted small" style="padding:20px 0">Only one line listed in this market.</div>`}</div>
    </div>
    <${S.Tabs} value=${tab} onChange=${setTab} tabs=${[['recent', 'Recent games'], ['why', 'Why'], ['injuries', 'Injuries & schedule'], ['lines', 'All lines']]}/>
    ${tab === 'recent' && html`<${LineRecent} d=${d} g=${g} det=${det} v=${v} lo=${lo} hi=${hi} yes=${yes} label=${label} away=${away} home=${home}/>`}
    ${tab === 'why' && html`<${LineWhy} det=${det} away=${away} home=${home} H1=${H1}/>`}
    ${tab === 'injuries' && html`<${LineInjuries} det=${det} away=${away} home=${home}/>`}
    ${tab === 'lines' && html`<${LineTable} gid=${gid} fams=${fams} sel=${m}/>`}
  </main>`;
}

function LineRecent({ det, v, lo, hi, yes, label, away, home }) {
  if (!v) return html`<${S.Empty} title="Not modeled">The game model doesn't cover this market, so there's no comparable history.</${S.Empty}>`;
  const panels = [['away', away], ['home', home]].map(([role, tri]) => {
    const rows = (det.recent?.[role] || []).slice(-10);
    const items = teamItems(rows, v, role, lo, hi, yes);
    return { role, tri, items, n: items.filter((x) => x.hit).length };
  });
  const base = v.replace('h1_', '');
  const shown = base === 'home' || base === 'away' ? null : SHOWN[base];
  return html`<div>
    <p class="ink2" style="margin-top:0">Each team's last 10 games, counted as if the team were in tonight's spot (${home} at home, ${away} on the road)${v.startsWith('h1_') ? ', 1st half only' : ''}. A small sample: it says how the team has been playing, not what tonight's price should be.</p>
    ${panels.map((pnl) => html`<div class="card chartcard" style="margin-bottom:12px">
      <h3><${S.TeamChip} tri=${pnl.tri}/> ${label} would have won in ${pnl.n} of ${pnl.items.length}</h3>
      <p class="cap">${shown ? `Bars: ${pnl.tri}'s ${shown}` : base === pnl.role ? `Bars: points ${pnl.tri} scored` : `Bars: points ${pnl.tri} allowed`}${base === 'margin' ? ' (above zero = won)' : ''}; dashed line = tonight's line on that scale.</p>
      ${pnl.items.length ? html`<${C.RecentBars} items=${pnl.items} lines=${ownLines(v, pnl.role, lo, hi)} unit=${shown || 'points'}/>` : html`<div class="muted small">No recent games in the data.</div>`}
    </div>`)}
  </div>`;
}

function LineWhy({ det, away, home, H1 }) {
  const w = det.why;
  if (!w?.home || !w?.away) return html`<${S.Empty} title="Breakdown not ready">It appears with the next price update.</${S.Empty}>`;
  const margin = w.home.mu - w.away.mu;
  return html`<div>
    <p class="ink2" style="margin-top:0">How the game model builds each team's ${H1 ? 'full-game ' : ''}regulation points: start from an average team-game, then add what's different about tonight. The steps add up exactly to the projection. It projects <b>${home} ${w.home.mu} – ${away} ${w.away.mu}</b>: ${margin >= 0 ? `${home} by ${margin.toFixed(1)}` : `${away} by ${(-margin).toFixed(1)}`}, total ${(w.home.mu + w.away.mu).toFixed(1)}${H1 ? ' (1st-half lines use a separate half-game model)' : ''}.</p>
    <div class="grid g2">${[['away', away], ['home', home]].map(([k, tri]) => html`<div class="card chartcard"><h3><${S.TeamChip} tri=${tri}/> points</h3>
      <${C.Waterfall} base=${w[k].base} groups=${w[k].groups} total=${w[k].mu} unit="pts" baseLabel="Average team-game"/></div>`)}</div>
    <div class="tiny muted" style="margin-top:8px">Team strength = ratings from this season and last (shrunk early in the season); Opponent = the other team's defense and style; Ratings projection = the simple ratings-based score; roster = how much of each team's usual scoring is expected to play (the model compares it with a typical roster, so a deep team can show a plus even with players out).</div>
  </div>`;
}

function LineInjuries({ det, away, home }) {
  const w = det.why || {};
  return html`<div class="grid g2">${[['away', away], ['home', home]].map(([k, tri]) => {
    const rep = det.reports?.[k] || {};
    const ro = w[k]?.roster || {};
    const cx = w[k]?.ctx || {};
    return html`<div class="card pad"><h3 style="margin:0 0 4px;font-size:15px"><${S.TeamChip} tri=${tri}/> injury report</h3>
      <div class="small muted" style="margin-bottom:8px">${rep.ts ? `Latest report: ${F.dayET(rep.ts)} ${F.timeET(rep.ts)} ET` : "Teams file on game day; tonight's report isn't out yet."}</div>
      ${(rep.rows || []).length ? html`<table class="t"><tbody>${rep.rows.map((r) => html`<tr><td>${r.name}</td><td><span class=${`chip ${r.status === 'OUT' ? 'bad' : 'warn'}`}>${r.status}</span></td><td class="small muted wrap">${r.reason || ''}</td></tr>`)}</tbody></table>`
        : html`<div class="small ink2">Nobody listed.</div>`}
      ${isNum(ro.usual_ppg) && html`<div class="note" style="margin-top:10px">Expected to play: <b>${ro.avail_ppg}</b> of the roster's usual <b>${ro.usual_ppg}</b> points per game${ro.missing_ppg > 0.5 ? html` (missing about <b>${ro.missing_ppg}</b>${ro.top_out_ppg > 0 ? `; biggest absence ${ro.top_out_ppg} ppg` : ''})` : ''}.</div>`}
      <div class="kv" style="margin-top:10px">
        <span class="k">Rest</span><span>${isNum(cx.rest) ? `${cx.rest} day${cx.rest === 1 ? '' : 's'}` : '—'}${cx.b2b >= 0.5 ? ' · back-to-back' : ''}</span>
        <span class="k">Travel to this game</span><span>${isNum(cx.travel_km) ? `${Math.round(cx.travel_km).toLocaleString()} km` : '—'}</span>
        <span class="k">Offense vs average</span><span>${isNum(cx.off_rel) ? `${cx.off_rel >= 0 ? '+' : ''}${cx.off_rel} pts/100` : '—'}</span>
        <span class="k">Net rating vs average</span><span>${isNum(cx.net_rel) ? `${cx.net_rel >= 0 ? '+' : ''}${cx.net_rel} pts/100` : '—'}</span>
        <span class="k">Pace vs average</span><span>${isNum(cx.pace_rel) ? `${cx.pace_rel >= 0 ? '+' : ''}${cx.pace_rel} possessions` : '—'}</span>
      </div></div>`;
  })}</div>`;
}

function LineTable({ gid, fams, sel }) {
  const ba = (x) => (x && (isNum(x.b) || isNum(x.a)) ? `${F.odds(x.b)} / ${F.odds(x.a)}` : '—');
  const best = (c, vn, e, f) => (isNum(c) ? html`${F.odds(c, 1)} <span class="muted small">${VS[vn] || ''}</span>${isNum(e) && e >= 0 ? html` <span class="good small">${F.edge(e, f)}</span>` : ''}` : html`<span class="muted small">not sold</span>`);
  return html`<div class="tablewrap"><table class="t"><thead><tr><th>Yes side</th><th class="r">Fair (yes)</th><th class="r">Model</th><th class="r">PM US bid / ask</th><th class="r">Kalshi bid / ask</th><th>Yes: best all-in</th><th>No: best all-in</th><th></th></tr></thead>
    <tbody>${fams.map((x) => html`<tr class=${x === sel ? 'main' : ''}><td>${x.ys}${x.main ? html` <span class="chip ghost">main</span>` : ''}</td><td class="r">${F.pct(x.fair, 1)}</td><td class="r muted">${F.pct(x.model, 1)}</td>
      <td class="r small">${ba(x.v.us)}</td><td class="r small">${ba(x.v.k)}</td><td>${best(x.cy, x.vy, x.ey, x.fair)}</td><td>${best(x.cn, x.vn, x.en, isNum(x.fair) ? 1 - x.fair : null)}</td>
      <td>${x !== sel && lineHref(gid, x, 'yes') ? html`<a class="small" href=${lineHref(gid, x, 'yes')}>details →</a>` : ''}</td></tr>`)}</tbody></table>
    <div class="tiny muted" style="margin-top:6px">Bid / ask are each venue's book for the Yes side as listed here. All-in = the ask plus that venue's taker fee.</div></div>`;
}
