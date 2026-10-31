// Pick & Roll - static front end. Reads data/latest.json (exported by the local pipeline) and renders everything.
import { html, render, useState, useEffect, useMemo } from '../vendor/preact-htm.mjs';
import * as F from './fmt.js';
import * as C from './charts.js';
import { comboProb, comboFee } from './combo.js';
import { init as initParlays, YourStyle, ReadyLegs, StyleRecord } from './parlays.js';
import { init as initGames, GameCards, GamePage, Slip, Markets, LinePage, PropSlip, useBoard } from './games.js';

const { isNum } = F;
const DATA_URL = 'data/latest.json';
// minutes before tip-off that picks lock (settings.decision_lead_min; 90 before Oct 24, 2026)
let LEAD = 20;
const LEAD_CHANGED = 'Oct 24';
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ===================================================================================== data
function useData() {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`${DATA_URL}?m=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => alive && setState({ data: prepare(d), error: null }))
      .catch((e) => alive && setState((s) => ({ ...s, error: String(e) })));
    load();
    const t = setInterval(load, 120000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return state;
}

function prepare(d) {
  LEAD = d.settings?.decision_lead_min ?? LEAD;
  const tri = (id) => d.teams?.[id]?.tri || '?';
  const gameById = Object.fromEntries((d.games || []).map((g) => [g.id, g]));
  const players = {};
  for (const p of d.players || []) players[`${p.g}:${p.id}`] = p;
  const markets = {};
  const byPlayer = {};
  for (const m of d.markets || []) {
    m.edge_o = isNum(m.fair) && isNum(m.cost_o) ? m.fair - m.cost_o : null;
    m.edge_u = isNum(m.fair) && isNum(m.cost_u) ? 1 - m.fair - m.cost_u : null;
    m.best = (m.edge_o ?? -9) >= (m.edge_u ?? -9) ? 'over' : 'under';
    m.best_edge = m.best === 'over' ? m.edge_o : m.edge_u;
    markets[m.id] = m;
    (byPlayer[`${m.g}:${m.p}`] ||= []).push(m);
  }
  Object.values(byPlayer).forEach((a) => a.sort((x, y) => x.line - y.line));
  const loggedBets = new Set(d.logged_bets || []);  // exactly the frozen market and side
  const decorate = (pk) => {
    const m = markets[pk.m] || {};
    const p = players[`${pk.g}:${pk.pid}`] || {};
    const g = gameById[pk.g] || {};
    return { ...pk, line: m.line, raw: m.raw, name: p.name, team: tri(p.team), opp: tri(p.opp), home: p.home,
      tip: g.tip, q: p.proj?.q, logged: loggedBets.has(`${pk.m}|${pk.side}`), l10: l10(p, m.line, pk.side), warn: warnings(m, p, pk.edge) };
  };
  const famLive = (d.fam_picks || []).filter((x) => x.tier === 'pick' && x.st === 'live').map((x) => ({
    ...x, l10: null, warn: [], logged: false, unit: FAM_UNIT[x.fam] || '',
    name: x.name || x.label, line: x.line ?? null }));
  const picks = [...(d.picks || []).filter((x) => x.tier === 'pick').map(decorate), ...famLive]
    .sort((a, b) => (b.strength || 0) - (a.strength || 0) || (b.edge || 0) - (a.edge || 0));
  const bubble = (d.picks || []).filter((x) => x.tier === 'bubble').map(decorate);
  const watch = (d.picks || []).filter((x) => x.tier === 'watch').map(decorate);
  const pickByKey = Object.fromEntries(picks.filter((x) => !x.fam || x.fam === 'player.pts').map((x) => [`${x.g}:${x.pid}`, x]));
  // every market's picks in one filterable list: Live ones above, Testing ones (other markets) too
  const famTesting = (d.fam_picks || []).filter((x) => x.tier === 'pick' && x.st !== 'live').map((x) => ({
    ...x, l10: null, warn: [], logged: false, unit: FAM_UNIT[x.fam] || '', name: x.name || x.label, line: x.line ?? null }));
  const allPicks = [...picks, ...famTesting];
  return { ...d, tri, gameById, players, marketById: markets, byPlayer, picks, bubble, watch, pickByKey, allPicks };
}

const FAM_UNIT = { 'player.pts': 'points', 'player.reb': 'rebounds', 'player.ast': 'assists', 'player.fg3m': 'threes',
  'player.pra': 'pts + reb + ast', 'player.stl': 'steals', 'player.blk': 'blocks' };

function l10(p, line, side) {
  const r = (p?.form?.recent || []).slice(-10);
  if (!r.length || !isNum(line)) return null;
  const hits = r.filter((g) => (side === 'over' ? g[2] > line : g[2] < line)).length;
  return { hits, n: r.length };
}

function warnings(m, p, edge) {
  const w = [];
  const st = p?.proj?.status;
  if (['Questionable', 'Doubtful', 'Out'].includes(st)) w.push(p.proj.status_text);
  for (const f of m?.flags || []) if (F.FLAG_TEXT[f] && f !== 'OUT') w.push(F.FLAG_TEXT[f]);
  if (isNum(edge) && edge >= 0.12) w.push('Huge gap vs market: check news');
  return w;
}

// ===================================================================================== shell
// In-app history. "Back" returns one step, and a page you come back to keeps its scroll position (and, through
// Info ids and the game boards' own memory, its open sections). Switching tabs inside a page replaces the history
// entry instead of adding one, so back skips them.
const NAV = { stack: [], y: {}, replacing: false };
function go(hash, replace = false) {
  if (replace) {
    NAV.replacing = true;
    NAV.stack[NAV.stack.length - 1] = hash;
    location.replace(hash);
  } else location.hash = hash;
}
function restoreScroll(y) {
  let n = 0;
  const step = () => {  // the page may still be filling in: retry until it's tall enough
    window.scrollTo(0, y);
    if (y > 0 && Math.abs(window.scrollY - y) > 4 && n++ < 30) setTimeout(step, 60);
  };
  requestAnimationFrame(step);
}
function useRoute() {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => {
    let cur = location.hash || '#/';
    NAV.stack = [cur];
    const onScroll = () => { NAV.y[cur] = window.scrollY; };
    const f = () => {
      const next = location.hash || '#/';
      if (NAV.replacing) {  // a tab switch inside the same page: keep the scroll
        NAV.replacing = false;
        cur = next;
        setH(next);
        return;
      }
      const back = NAV.stack.length > 1 && NAV.stack[NAV.stack.length - 2] === next;
      if (back) NAV.stack.pop(); else NAV.stack.push(next);
      cur = next;
      setH(next);
      restoreScroll(back ? NAV.y[next] || 0 : 0);
    };
    addEventListener('hashchange', f);
    addEventListener('scroll', onScroll, { passive: true });
    return () => { removeEventListener('hashchange', f); removeEventListener('scroll', onScroll); };
  }, []);
  return h.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}
// "← <where you came from>": one step back (or, opened from a link, to the page given as fallback)
function navLabel(hash, d) {
  const r = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const g = d.gameById?.[r[1]];
  if (!r.length) return 'Tonight';
  if (r[0] === 'game') return g ? `${d.tri(g.away)} @ ${d.tri(g.home)}` : 'Game';
  if (r[0] === 'player') return d.players?.[`${r[1]}:${r[2]}`]?.name || 'Player';
  return { markets: 'Markets', combos: 'Combos', record: 'Track record', how: 'How it works', line: 'Line' }[r[0]] || 'Back';
}
function BackLink({ d, fallback, label }) {
  const prev = NAV.stack.length > 1 ? NAV.stack[NAV.stack.length - 2] : null;
  return html`<a class="back" href=${prev || fallback} onClick=${(e) => { if (prev) { e.preventDefault(); history.back(); } }}>← ${prev ? navLabel(prev, d) : label}</a>`;
}

const Ball = ({ size = 30 }) => html`<svg class="brand-mark" width=${size} height=${size} viewBox="0 0 40 40" aria-hidden="true">
  <circle cx="20" cy="20" r="18" fill="var(--brand)"/><path d="M2 20h36M20 2v36M7 7c7 6 7 20 0 26M33 7c-7 6-7 20 0 26" stroke="#1a1a1a" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`;

const Court = () => html`<svg class="court" viewBox="0 0 300 150" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <path d="M10 140 H290"/><path d="M60 140 V100 A90 90 0 0 1 240 100 V140"/><rect x="110" y="70" width="80" height="70"/>
  <circle cx="150" cy="70" r="28"/><path d="M135 140 V128 H165 V140"/><circle cx="150" cy="128" r="4"/></svg>`;

const LockIcon = () => html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

function ThemeButton() {
  const [t, setT] = useState(store.get('theme', 'auto'));
  useEffect(() => {
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    store.set('theme', t);
  }, [t]);
  const next = { auto: 'dark', dark: 'light', light: 'auto' }[t];
  const icon = t === 'dark'
    ? html`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`
    : t === 'light' ? html`<g><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g>`
      : html`<g><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></g>`;
  return html`<button class="icon-btn" title=${`Theme: ${t} (click for ${next})`} onClick=${() => setT(next)}>
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${icon}</svg></button>`;
}

function freshLevel(d) {
  const m = F.minsSince(d?.freshness?.prices);
  const tips = (d?.games || []).map((g) => new Date(g.tip).getTime()).filter((t) => t > Date.now());
  if (m == null) return 'bad';
  // prices refresh from late morning until ~1 AM ET; long before tip-off an overnight gap is expected
  const hoursToTip = tips.length ? (Math.min(...tips) - Date.now()) / 3.6e6 : Infinity;
  if (m <= 20 || hoursToTip > 6) return 'good';
  return m <= 90 ? 'warn' : 'bad';
}

// %, US odds or both: every price and edge on the site follows this (a per-viewer preference)
function OddsToggle({ onOdds }) {
  const m = F.oddsMode();
  return html`<div class="seg odds-toggle" title="Show prices as the chance they imply, as US odds, or both">${F.ODDS_OPTIONS.map(([v, label]) => html`<button class=${v === m ? 'on' : ''} onClick=${() => onOdds(v)}>${label}</button>`)}</div>`;
}

function TopBar({ route, d, onOdds }) {
  const here = route[0] || '';
  const link = (to, label) => html`<a href=${`#/${to}`} class=${here === to ? 'on' : ''}>${label}</a>`;
  return html`<header class="topbar"><div class="topbar-in">
    <a class="brand" href="#/"><${Ball}/><span class="brand-name">PICK <span>&</span> ROLL</span></a>
    <nav class="nav">${link('', 'Tonight')}${link('markets', 'Markets')}${link('combos', 'Combos')}${link('record', 'Track record')}${link('how', 'How it works')}</nav>
    <span class="spacer"></span>
    <${OddsToggle} onOdds=${onOdds}/>
    ${d && html`<span class="fresh hide-sm" title="When Polymarket US prices were last read. They refresh every few minutes from late morning until about 1 AM ET."><span class=${`dot ${freshLevel(d)}`}></span>Prices ${F.ago(d.freshness?.prices)}</span>`}
    <${ThemeButton}/>
  </div></header>`;
}

const Footer = ({ d }) => html`<footer class="foot"><div class="foot-in">
  <b>For fun and information, not financial advice.</b> Nothing here places bets; prices come from Polymarket US's and Kalshi's public data and can move at any time.
  Probabilities are estimates and lose more often than you'd think. Bet only what you can afford to lose, and only where it's legal for you (21+; not available in all states).${' '}
  <b>Gambling problem? Call 1-800-MY-RESET (1-800-697-3738).</b> Statistics: NBA.com. Not affiliated with the NBA, Polymarket or Kalshi. Historical prices: Kalshi public API; polymarket.com history via the${' '}
  <a href="https://huggingface.co/datasets/epinnock/polymarket-nba" rel="noopener">epinnock/polymarket-nba</a> dataset (CC BY 4.0).
  ${d && html`<br/>Data generated ${F.ago(d.generated_at)} · model ${d.freshness?.model_version || '—'} (trained on games through ${d.freshness?.trained_through || '—'}).`}
</div></footer>`;

// ===================================================================================== small pieces
const TeamChip = ({ tri }) => html`<span class="chip team" style=${`background:${F.teamColor(tri)}`}>${tri}</span>`;
const Meter = ({ n }) => html`<span class="meter" title=${`Edge size ${n} of 5: how far our fair chance is from the price. Not yet shown to pick winners, so it isn't a quality rating.`}>${[1, 2, 3, 4, 5].map((i) => html`<i class=${i <= n ? 'on' : ''}></i>`)}</span>`;
const Empty = ({ title, children }) => html`<div class="card empty"><div class="big">${title}</div><div>${children}</div></div>`;
const OPEN_INFO = {};
const Info = ({ title, children, open = false, id }) => html`<details class="explain" open=${id && id in OPEN_INFO ? OPEN_INFO[id] : open}
  onToggle=${id ? (e) => { OPEN_INFO[id] = e.currentTarget.open; } : undefined}><summary>${title}</summary><div>${children}</div></details>`;
const Seg = ({ value, options, onChange }) => html`<div class="seg">${options.map(([v, label]) => html`<button class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${label}</button>`)}</div>`;
const Switch = ({ checked, onChange, children }) => html`<label class="switch"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)}/><span class="track"></span>${children}</label>`;
const matchup = (p, d) => `${d.tri(p.team)} ${p.home ? 'vs' : '@'} ${d.tri(p.opp)}`;
const goPlayer = (g, pid, line) => { location.hash = `#/player/${g}/${pid}${isNum(line) ? `/${line}` : ''}`; };
const goStat = (g, pid, stat, line) => { location.hash = `#/player/${g}/${pid}/${stat}${isNum(line) ? `/${line}` : ''}`; };
const lineHash = (g, mid, side) => `#/line/${g}/${encodeURIComponent(mid)}${side ? `/${side}` : ''}`;

// ===================================================================================== venues
// Polymarket US player props are Yes/Over only; Kalshi lets you buy No (the Under). Every pick names where it can be placed.
const VENUE = { us: 'Polymarket US', kalshi: 'Kalshi' };
const VenueChip = ({ v }) => (v
  ? html`<span class=${`chip venue venue-${v}`} title=${`Placeable on ${VENUE[v]}`}>${VENUE[v]}</span>`
  : html`<span class="chip ghost" title="No venue lists this side">Not placeable</span>`);
function howToPlace(pk) {
  if (pk.fam && !pk.fam.startsWith('player.')) {  // game lines: both sides trade on both venues
    return pk.venue ? html`On <b>${VENUE[pk.venue]}</b>: buy <b>${pk.label}</b> at ${F.price(pk.price)}` : html`<span class="muted">No venue lists this side right now.</span>`;
  }
  const yes = pk.side === 'over';
  const unit = FAM_UNIT[pk.fam || 'player.pts'];
  const contract = `“${pk.name}: ${pk.raw}+ ${unit}”`;
  if (pk.venue === 'kalshi') {
    return html`On <b>Kalshi</b>: buy <b>${yes ? 'Yes' : 'No'}</b> on ${contract} at ${F.price(pk.price)}${!yes ? html`<br/><span class="tiny muted">Not on Polymarket US: its player props only sell the Over.</span>` : ''}`;
  }
  if (pk.venue === 'us') return html`On <b>Polymarket US</b>: buy <b>Yes</b> on “${pk.raw}+ ${unit}” at ${F.price(pk.price)}`;
  return html`<span class="muted">No venue lists this side right now.</span>`;
}

// Live = the market family passed its pre-registered backtest gate at the current lock time; Testing = shown, unproven
const FamilyBadge = ({ st }) => (st === 'live'
  ? html`<span class="chip good" title="Passed its pre-registered backtest at this lock time">Live</span>`
  : html`<span class="chip ghost testing" title="Shown and tracked separately; counts only once the market passes its backtest or earns Live from its own record">Testing</span>`);

// the second path to Live: the market's own record of picks frozen at this lock time
function LivePath({ d, f }) {
  const R = d.settings?.live_rules || { promote_n: 300, roi_ci_floor: -0.03 };
  const lr = f?.live_record;
  return html`<span class="small"> <b>Second path to Live:</b> its own record at the ${f?.lead_min ?? LEAD}-minute lock. ${lr?.n
    ? html`So far <b>${lr.n} of ${R.promote_n}</b> graded picks, ${F.signedPct(lr.roi)} per bet${isNum(lr.roi_ci?.[0]) ? ` (95% range ${F.signedPct(lr.roi_ci[0])} to ${F.signedPct(lr.roi_ci[1])})` : ''}.`
    : 'No graded picks at this lock time yet.'} From ${R.promote_n} picks on it turns Live once the return is positive, that range's floor is ${F.signedPct(R.roi_ci_floor, 0)} or better, and the picks beat the closing price on average.</span>`;
}

function FamilyNote({ d, fam = 'player.pts' }) {
  const f = d.families?.[fam];
  if (!f || f.status === 'live') return null;
  const h = f.held_out || {}, dv = f.development || {}, ll = f.logloss || {};
  const failed = Object.entries(f.checks || {}).filter(([, ok]) => !ok).map(([k]) => k);
  return html`<div class="note warn" style="margin-bottom:12px">
    <b>${f.label} picks are in Testing at the ${f.lead_min}-minute lock.</b> Every market has to pass the same pre-registered backtest
    on real Kalshi prices (fees included), or earn it from its own live record, before its picks count.
    ${h.n ? html` Held out (Apr–Oct 2026): ${F.signedPct(h.roi)} per bet (95% CI ${F.signedPct(h.roi_ci?.[0])} to ${F.signedPct(h.roi_ci?.[1])}, n=${h.n}),
      hit ${F.pct(h.hit, 1)} vs ${F.pct(h.predicted, 1)} predicted${ll.n ? `, fair chance beats the market price in log loss (${ll.ll_fair?.toFixed(4)} vs ${ll.ll_market?.toFixed(4)})` : ''}.` : ''}
    ${failed.includes('dev_roi_nonnegative') && dv.n ? html` What failed: the earlier months (before Apr 2026) lost ${F.signedPct(dv.roi)} per bet (n=${dv.n}), and the rule requires both periods to be at least break-even.` : ''}
    <${LivePath} d=${d} f=${f}/>
    <span class="small"> Picks below are still the model's honest calls and are tracked in their own record.</span></div>`;
}

// ===================================================================================== Tonight
// a probability in the viewer's format, compact: 58% / −138 / 58% with −138 beside it
const OddsV = ({ p }) => (F.oddsMode() === 'both' ? html`${F.pct(p)}<span class="v-sub">${F.american(p)}</span>` : F.odds(p));

// where a pick opens: its full detail page (player page on that stat and line; game lines -> the line page)
const goPick = (pk) => (!pk.fam || pk.fam === 'player.pts' ? goPlayer(pk.g, pk.pid, pk.line)
  : pk.fam.startsWith('player.') ? goStat(pk.g, pk.pid, pk.fam.split('.')[1], pk.line)
    : (location.hash = lineHash(pk.g, pk.m, pk.side)));

function PickCard({ pk }) {
  const go = () => goPick(pk);
  const gameLine = pk.fam && !pk.fam.startsWith('player.');
  return html`<article class=${`card click pick pick-${pk.side}`} onClick=${go} tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && go()}>
    ${pk.logged && html`<span class="chip ghost logged" title=${`Frozen ${LEAD} minutes before tip for the public track record`}><${LockIcon}/> Logged</span>`}
    <div class="pick-top"><${Meter} n=${pk.strength}/><span class="up ink2">${F.STRENGTH_WORD[pk.strength]}</span><span class="spacer"></span>${pk.st !== 'live' && html`<${FamilyBadge} st=${pk.st}/>`}<${VenueChip} v=${pk.venue}/></div>
    <div>
      <div class="pick-name">${pk.name}${pk.fam && pk.fam !== 'player.pts' && !gameLine ? html` <span class="chip ghost">${FAM_UNIT[pk.fam]}</span>` : ''}</div>
      <div class="row small ink2" style="gap:6px;margin-top:4px">${gameLine
        ? html`<${TeamChip} tri=${pk.away_tri}/> @ <${TeamChip} tri=${pk.home_tri}/> · ${F.timeET(pk.tip)}`
        : html`<${TeamChip} tri=${pk.team}/> ${pk.home ? 'vs' : '@'} ${pk.opp} · ${F.timeET(pk.tip)}`}</div>
    </div>
    <div class="bet"><span class="bet-side">${gameLine ? pk.label : `${F.SIDE_UP(pk.side)} ${pk.line}`}</span></div>
    <div class="bet-how">${howToPlace(pk)}</div>
    <div class="stats3">
      <div class="stat"><div class="k">${F.oddsMode() === 'us' ? 'Fair line' : 'Fair chance'}</div><div class="v side"><${OddsV} p=${pk.p}/></div></div>
      <div class="stat"><div class="k">${F.oddsMode() === 'us' ? 'Price' : 'Price implies'}</div><div class="v"><${OddsV} p=${pk.price}/></div></div>
      <div class="stat" title="Fair chance minus the chance the all-in price implies (fee included), in percentage points"><div class="k">Edge</div><div class="v good">${F.signedPct(pk.edge)}</div></div>
    </div>
    ${pk.q?.length ? html`<${C.MiniRange} q=${pk.q} line=${pk.line} side=${pk.side}/>` : ''}
    <div class="pick-foot">${pk.q?.length ? html`<span>Projects <b>${pk.q?.[2]}</b> ${pk.fam && pk.fam !== 'player.pts' ? FAM_UNIT[pk.fam] : 'pts'} (80%: ${pk.q?.[0]}–${pk.q?.[4]})</span>` : ''}
      ${pk.l10 && html`<span>· last 10: ${pk.l10.hits}/${pk.l10.n} ${pk.side}</span>`}</div>
    ${pk.warn.length > 0 && html`<div class="row wrap" style="gap:6px">${pk.warn.map((w) => html`<span class="chip warn">${w}</span>`)}</div>`}
  </article>`;
}

function comboLegs(c, d) {
  return c.legs.map((lg) => {
    const m = d.marketById[lg.m] || {};
    const p = d.players[`${m.g}:${m.p}`] || {};
    const fair = lg.side === 'over' ? m.fair : isNum(m.fair) ? 1 - m.fair : null;
    const k = c.venue === 'kalshi' || (lg.side === 'under' && isNum(m.kb));
    const price = lg.side === 'over' ? (k && isNum(m.ka) ? m.ka : m.ask) : (k ? 1 - m.kb : isNum(m.bid) ? 1 - m.bid : null);
    return { ...lg, line: m.line, raw: m.raw, name: p.name, team: d.tri(p.team), g: m.g, pid: m.p, fair, price };
  });
}

function sameGameNote(c, legs) {
  if (!c.same_game?.length) return c.n_games > 1 ? 'Different games, so the legs are independent' : '';
  const r = c.same_game[0][2];
  return `Includes a same-game pair that ${r > 0.005 ? 'slightly helps' : 'barely affects'} the combo`;
}

function ComboCard({ c, d, section }) {
  const legs = comboLegs(c, d);
  const builder = `#/combos/${c.legs.map((l) => `${l.m}.${l.side}`).join(',')}`;
  return html`<article class="card combo">
    <div class="combo-head"><span class="rank">${c.rank}</span>
      <div class="grow"><div style="font-weight:650">${legs.length}-leg ${section === 'upside' ? 'long shot' : 'combo'}</div>
        <div class="tiny muted">${sameGameNote(c, legs)}</div></div>
      <span class=${`chip ${section === 'upside' ? 'under' : 'good'}`}>${section === 'upside' ? `Pays ${F.x1(c.payout)}` : `${F.pct(c.p)} to hit`}</span></div>
    <div class="row small" style="gap:6px">${c.placeable === false
      ? html`<span class="chip ghost">Not placeable as one combo</span><span class="tiny muted">has an Under leg; combos on both venues only take the Over on player props</span>`
      : html`<span class="tiny muted">Place as a combo on</span><${VenueChip} v=${c.venue || 'us'}/>`}</div>
    <div class="legs">${legs.map((l) => html`<div class="leg" style="cursor:pointer" onClick=${() => goPlayer(l.g, l.pid, l.line)}>
      <div><div class="who">${l.name} <span class=${l.side}>${F.SIDE_UP(l.side)} ${l.line}</span></div>
        <div class="what">${l.team} · ${l.side === 'over' ? 'Yes' : 'No'} on ${l.raw}+ at ${F.odds(l.price)}</div></div>
      <div class=${`pp ${l.side}`}>${F.pct(l.fair)}</div></div>`)}</div>
    <div class="combo-stats">
      <div class="bigstat"><div class="k">Chance all hit</div><div class="v">${F.pct(c.p)}</div></div>
      <div class="bigstat"><div class="k">Pays</div><div class="v">${F.x1(c.payout)}</div></div>
      <div class="bigstat" title="Expected profit per $1 at the estimated price, if the fair chances are right"><div class="k">Value</div><div class="v good">${F.signedPct(c.ev, 0)}</div></div>
    </div>
    <div class="payout-line">$10 returns <b>${F.money(10 * c.payout)}</b> if every leg hits · est. price ${F.odds(c.cost, 1)} incl. fee · stake ≤ ${F.pct(c.kelly_pct, 1)} of bankroll</div>
    <a class="btn ghost sm" href=${builder} style="align-self:flex-start">Check the app's real price →</a>
  </article>`;
}

// combos across every Live market family (props + game lines), priced with the joint model
const legHref = (lg) => (!lg.game_id ? null : lg.family?.startsWith('player.')
  ? (isNum(lg.player_id) ? `#/player/${lg.game_id}/${lg.player_id}/${lg.family.split('.')[1]}` : null)
  : lg.market_id ? lineHash(lg.game_id, lg.market_id, lg.side) : null);
const C2_TITLE = { strongest: 'Strongest', same_game: 'Same-game stacks', upside: 'Big upside' };
function Combos2({ d }) {
  const rows = d.combos2 || [];
  if (!rows.length) return null;
  return html`<div style="margin-top:14px"><div class="section-head" style="margin-bottom:6px"><h3 style="margin:0">Across markets</h3>
    <span class="lede">Props and game lines together; estimated prices (both venues quote combos on request)</span></div>
    <div class="grid g3">${rows.map((c) => html`<div class="card pad">
      <div class="row"><b>${C2_TITLE[c.section] || c.section}</b><span class="spacer"></span><${VenueChip} v=${c.venue}/></div>
      <div class="legs" style="margin-top:6px">${c.legs.map((lg) => html`<div class=${`leg${legHref(lg) ? ' click' : ''}`} onClick=${() => { const h = legHref(lg); if (h) location.hash = h; }}><div><div class="who">${lg.label}</div>
        <div class="what">fair ${F.pct(lg.p)} · ${F.odds(lg.price)}</div></div></div>`)}</div>
      <div class="small ink2" style="margin-top:6px">Chance all hit <b>${F.pct(c.p, 1)}</b> (independent ${F.pct(c.p_naive, 1)}) · est. price ${F.odds(c.cost, 1)} incl. fee · pays ${F.x1(c.payout)} · stake ≤ ${F.pct(c.kelly_pct, 1)}</div>
    </div>`)}</div></div>`;
}

function CombosBlock({ d }) {
  const [sec, setSec] = useState('strongest');
  const list = d.combos?.[sec] || [];
  return html`<div>
    <div class="toolbar"><${Seg} value=${sec} onChange=${setSec} options=${[['strongest', 'Strongest'], ['upside', 'Big upside']]}/>
      <span class="small ink2">${sec === 'strongest' ? 'Best mix of value and chance to hit (2–3 legs).' : 'Pays 4× or more, still has a real chance (3–5 legs).'}</span></div>
    ${list.length
      ? html`<div class="grid g3">${list.map((c) => html`<${ComboCard} c=${c} d=${d} section=${sec}/>`)}</div>`
      : html`<${Empty} title="No combo you can actually place">${d.picks.length < 2 ? 'Combos need at least two picks, and tonight has fewer.'
        : (d.picks.filter((p) => p.side === 'over').length < 2
          ? 'Polymarket US and Kalshi combos only take the Over side of player props, and tonight’s picks are mostly Unders, so there is nothing to combine. The Unders are still good singles on Kalshi.'
          : 'None of the ways to combine tonight’s Over picks keeps enough value after the combo fee.')}</${Empty}>`}
    ${(d.combos?.ideas || []).length > 0 && html`<div style="margin-top:12px"><${Info} title=${`Combo ideas you can't place (${d.combos.ideas.length})`}>
      <div class="small ink2" style="margin-bottom:8px">Built from all of tonight's picks, including Unders. Neither venue accepts an Under leg in a combo, so these are for information only (each leg can still be played as a single).</div>
      <div class="grid g3">${d.combos.ideas.map((c) => html`<${ComboCard} c=${c} d=${d} section="ideas"/>`)}</div></${Info}></div>`}
  </div>`;
}

function Hero({ d, title, kicker, sub }) {
  return html`<div class="hero"><${Court}/>
    <div><div class="up muted">${kicker}</div><h1>${title}</h1>${sub && html`<div class="sub">${sub}</div>`}</div>
    <span class="spacer"></span>
    <span class="fresh only-sm"><span class=${`dot ${freshLevel(d)}`}></span>Prices ${F.ago(d.freshness?.prices)}</span>
  </div>`;
}

function Welcome() {
  const [hide, setHide] = useState(store.get('welcome-hidden', false));
  if (hide) return null;
  return html`<div class="callout" style="margin-bottom:8px">
    <div class="row" style="align-items:flex-start"><div class="grow">
      <div style="font-weight:650;margin-bottom:4px">New here? Read a pick in 20 seconds</div>
      <div class="small ink2"><b>Fair chance</b> is our best estimate that the bet wins. <b>Price implies</b> is what the market charges.
        When fair beats price after the fee, there's an <b>edge</b>, usually just a percentage point or two, because the markets are sharp.
        The dot and bar show where tonight's line sits inside the model's projected range.</div></div>
      <button class="btn ghost sm" onClick=${() => { setHide(true); store.set('welcome-hidden', true); }}>Got it</button></div>
  </div>`;
}

function TrustStrip({ d }) {
  // the live record that counts: Live picks if any; otherwise everything frozen at today's lock time (never the 90-min era)
  const rec = d.record?.summary?.live?.n || d.record?.summary?.live?.pending ? d.record.summary.live : (d.record?.summary?.lock_now || d.record?.summary?.all);
  const bt = d.trust?.picks?.singles_holdout;
  const fam = d.families?.['player.pts'];
  return html`<div class="card pad">
    <div class="row wrap" style="align-items:flex-start;gap:24px">
      <div class="grow" style="min-width:240px">
        <div class="up muted">How reliable is this?</div>
        ${rec?.n > 0
          ? html`<div style="margin-top:6px"><b>Track record at the ${LEAD}-minute lock:</b> ${rec.wins}–${rec.losses} (${F.pct(rec.hit_rate)} hit vs ${F.pct(rec.predicted)} predicted), ${F.signedPct(rec.roi)} per bet over ${rec.n} picks${rec.pending ? `, ${rec.pending} still pending` : ''}. Far too few to judge yet.</div>`
          : html`<div style="margin-top:6px">The live track record starts with tonight's games: every pick is frozen ${LEAD} minutes before tip and graded after.</div>`}
        ${bt?.n > 0 && html`<div class="small ink2" style="margin-top:6px">Backtest of this exact rule (real Kalshi prices, Apr–Oct 2026, never used to design it): hit ${F.pct(bt.hit_rate, 1)} vs ${F.pct(bt.predicted, 1)} predicted, ${F.signedPct(bt.roi)} per bet (95% CI ${F.signedPct(bt.roi_ci[0])} to ${F.signedPct(bt.roi_ci[1])}, n=${bt.n}). Promising, not proven.</div>`}
        ${fam && fam.status !== 'live' && html`<div class="small ink2" style="margin-top:6px"><${FamilyBadge} st=${fam.status}/> ${fam.label} picks are in Testing at the ${fam.lead_min}-minute lock: ${fam.development?.n ? `the months before Apr 2026 lost ${F.signedPct(fam.development.roi)} per bet (n=${fam.development.n}), and the pre-registered rule needs both periods at break-even or better.` : 'its pre-registered backtest hasn\'t passed yet.'} They're still shown and tracked on their own.</div>`}
      </div>
      <a class="btn ghost" href="#/record">See the full track record</a>
    </div></div>`;
}

function Bubble({ d, keep = () => true }) {
  const rows = d.bubble.filter(keep);
  if (!rows.length) return null;
  return html`<${Info} id="bubble" title=${`On the bubble · ${rows.length} lines just missed the bar`}>
    <div class="small" style="margin-bottom:8px">Close calls: the fair chance is within 2 percentage points of the price. Not picks, and never used in combos.</div>
    <div class="tablewrap"><table class="t"><thead><tr><th>Player</th><th>Bet</th><th class="r">Fair</th><th class="r">Price</th><th class="r">Edge</th></tr></thead>
    <tbody>${rows.map((b) => html`<tr class="click" onClick=${() => goPlayer(b.g, b.pid, b.line)}>
      <td>${b.name} <span class="muted small">${b.team}</span></td><td class=${b.side}>${F.sideWord(b.side)} ${b.line}</td>
      <td class="r">${F.pct(b.p)}</td><td class="r">${F.odds(b.price)}</td><td class="r muted">${F.edge(b.edge, b.p)}</td></tr>`)}</tbody></table></div>
  </${Info}>`;
}

function MorePicks({ picks, title, note, id = 'more-picks' }) {
  return html`<${Info} id=${id} title=${title || `More picks that clear the bar · ${picks.length}`}>
    <div class="small" style="margin-bottom:8px">${note || 'Smaller edges. Logged and graded just like the ones above; Testing markets are tracked in their own record.'}</div>
    <div class="tablewrap"><table class="t"><thead><tr><th>Player / game</th><th>Bet</th><th>Market</th><th>Strength</th><th class="r">Fair</th><th class="r">Price</th><th class="r">Edge</th><th>Venue</th><th class="r">Tip</th></tr></thead>
    <tbody>${picks.map((b) => html`<tr class="click" onClick=${() => goPick(b)}>
      <td><b>${b.name}</b> <span class="muted small">${b.team || ''}</span></td>
      <td class=${pickDir(b) || ''}>${b.fam && !b.fam.startsWith('player.') ? b.label : html`${F.sideWord(b.side)} ${b.line} <span class="muted small">(${b.side === 'over' ? 'Yes' : 'No'} on ${b.raw}+)</span>`}</td>
      <td class="small">${MKT_NAME[mktOf(b)] || mktOf(b)}${b.st !== 'live' ? html` <${FamilyBadge} st=${b.st}/>` : ''}</td>
      <td><${Meter} n=${b.strength}/></td><td class="r">${F.pct(b.p)}</td><td class="r">${F.odds(b.price)}</td><td class="r good">${F.edge(b.edge, b.p)}</td>
      <td class="small">${VENUE[b.venue] || '—'}</td><td class="r">${F.timeET(b.tip)}</td></tr>`)}</tbody></table></div>
  </${Info}>`;
}

// ---------------------------------------------------------------- filters (Tonight's picks)
// a pick's direction for the Over/Under filter: props by side; totals and team totals by Yes (over) / No (under);
// spreads and moneylines have neither
const pickDir = (p) => (!p.fam || p.fam.startsWith('player.') ? p.side : /total/.test(p.fam) ? (p.side === 'yes' ? 'over' : 'under') : null);
const mktOf = (p) => (!p.fam ? 'player.pts' : p.fam.startsWith('player.') ? p.fam : 'game');
const MKT_NAME = { 'player.pts': 'Points', 'player.reb': 'Rebounds', 'player.ast': 'Assists', 'player.fg3m': 'Threes',
  'player.pra': 'Pts + Reb + Ast', 'player.stl': 'Steals', 'player.blk': 'Blocks', game: 'Game lines' };
const PF_KEY = 'pr_pick_filters_v1';
const PF_DEFAULT = { side: 'all', mkt: 'all', venue: 'all', st: 'all', game: 'all', str: 0, sort: 'strength' };
function usePickFilters() {
  const [f, setF] = useState({ ...PF_DEFAULT, ...store.get(PF_KEY, {}) });
  const set = (k, v) => { const n = { ...f, [k]: v }; setF(n); store.set(PF_KEY, n); };
  const reset = () => { setF(PF_DEFAULT); store.set(PF_KEY, PF_DEFAULT); };
  return [f, set, reset];
}
const SORTS = {
  strength: (a, b) => (b.st === 'live') - (a.st === 'live') || (b.strength || 0) - (a.strength || 0) || (b.edge || 0) - (a.edge || 0),
  edge: (a, b) => (b.edge || 0) - (a.edge || 0),
  fair: (a, b) => (b.p || 0) - (a.p || 0),
  tip: (a, b) => String(a.tip).localeCompare(String(b.tip)) || (b.edge || 0) - (a.edge || 0),
};
function filterPicks(list, f) {
  return list.filter((p) => (f.side === 'all' || pickDir(p) === f.side)
    && (f.mkt === 'all' || mktOf(p) === f.mkt)
    && (f.venue === 'all' || p.venue === f.venue)
    && (f.st === 'all' || (f.st === 'live' ? p.st === 'live' : p.st !== 'live'))
    && (f.game === 'all' || p.g === f.game)
    && (p.strength || 0) >= f.str).sort(SORTS[f.sort] || SORTS.strength);
}
const Select = ({ value, options, onChange, label }) => html`<label class="sel"><span class="sr">${label}</span>
  <select class="input" value=${value} onChange=${(e) => onChange(e.target.value)} aria-label=${label}>${options.map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select></label>`;

function PickFilters({ d, f, set, reset, shown, total }) {
  const mkts = ['all', ...Object.keys(MKT_NAME).filter((k) => d.allPicks.some((p) => mktOf(p) === k))];
  const games = (d.games || []).filter((g) => d.allPicks.some((p) => p.g === g.id));
  const active = Object.keys(PF_DEFAULT).some((k) => f[k] !== PF_DEFAULT[k]);
  return html`<div class="filters">
    <${Seg} value=${f.side} onChange=${(v) => set('side', v)} options=${[['all', 'All sides'], ['over', 'Overs'], ['under', 'Unders']]}/>
    <${Select} label="Market" value=${f.mkt} onChange=${(v) => set('mkt', v)} options=${mkts.map((k) => [k, k === 'all' ? 'All markets' : MKT_NAME[k]])}/>
    <${Select} label="Game" value=${f.game} onChange=${(v) => set('game', v)} options=${[['all', 'All games'], ...games.map((g) => [g.id, `${d.tri(g.away)} @ ${d.tri(g.home)} · ${F.timeET(g.tip)}`])]}/>
    <${Select} label="Venue" value=${f.venue} onChange=${(v) => set('venue', v)} options=${[['all', 'Any venue'], ['us', 'Polymarket US'], ['kalshi', 'Kalshi']]}/>
    <${Select} label="Status" value=${f.st} onChange=${(v) => set('st', v)} options=${[['all', 'Live + Testing'], ['live', 'Live only'], ['testing', 'Testing only']]}/>
    <${Select} label="Strength" value=${String(f.str)} onChange=${(v) => set('str', +v)} options=${[['0', 'Any strength'], ['2', 'Strength 2+'], ['3', 'Strength 3+'], ['4', 'Strength 4+'], ['5', 'Strength 5']]}/>
    <${Select} label="Sort" value=${f.sort} onChange=${(v) => set('sort', v)} options=${[['strength', 'Sort: strength'], ['edge', 'Sort: edge'], ['fair', 'Sort: fair chance'], ['tip', 'Sort: tip time']]}/>
    <span class="small muted">${shown} of ${total}</span>
    ${active && html`<button class="btn ghost sm" onClick=${reset}>Reset</button>`}
  </div>`;
}

function Tonight({ d }) {
  const [pf, setPf, resetPf] = usePickFilters();
  const [view, setView] = useState(store.get('home-view', 'lays'));  // "your method" first; Model picks one tap away
  const pickView = (v) => { setView(v); store.set('home-view', v); };
  const all = d.allPicks;
  const shown = filterPicks(all, pf);
  const live = shown.filter((p) => p.st === 'live');
  const testing = shown.filter((p) => p.st !== 'live');
  const best = live.filter((p) => p.strength >= 5);
  const featured = live.length ? (best.length >= 3 ? best.slice(0, 9) : live.slice(0, 6)) : testing.slice(0, 6);
  const rest = shown.filter((p) => !featured.includes(p));
  const keepSide = (x) => (pf.side === 'all' || x.side === pf.side) && (pf.game === 'all' || x.g === pf.game)
    && (pf.mkt === 'all' || pf.mkt === 'player.pts');
  const tips = (d.games || []).map((g) => g.tip).filter(Boolean);
  const nLines = Object.values(d.boards || {}).reduce((a, b) => a + (b.n_lines || 0) + (b.n_props || 0), 0);
  return html`<main class="page">
    <${Hero} d=${d} kicker="Tonight's slate" title=${tips.length ? F.longDayET(tips[0]) : 'No games right now'}
      sub=${tips.length ? `${d.games.length} games · ${nLines.toLocaleString()} lines priced across Polymarket US and Kalshi` : 'The next slate appears once markets open.'}/>
    <${Welcome}/>
    ${Object.keys(d.boards || {}).length > 0 && html`<section class="section">
      <div class="section-head"><h2>Tonight's games</h2><span class="lede">Main lines at the best price you can actually buy · tap a game for every market</span></div>
      <${GameCards} d=${d}/></section>`}
    <section class="section">
      <div class="row wrap" style="gap:10px;margin-bottom:10px"><${Seg} value=${view} onChange=${pickView} options=${[['lays', 'Best for your parlays'], ['model', 'Model picks']]}/></div>
      ${view === 'lays' ? html`<div class="section-head"><h2>Best for your parlays</h2><span class="lede">Overs and Unders on Polymarket US that pass the parlay-ready bar: a 65–85% fair chance from players whose side keeps winning</span></div>
      <${ReadyLegs} d=${d}/>` : html`
      <div class="section-head"><h2>The model's picks</h2><span class="lede">${all.length} line${all.length === 1 ? '' : 's'} clear the bar for tonight's games, across every market${!all.some((p) => p.st === 'live') && all.length ? ' · all in Testing' : ''}</span></div>
      ${all.length > 0 && html`<${PickFilters} d=${d} f=${pf} set=${setPf} reset=${resetPf} shown=${shown.length} total=${all.length}/>`}
      ${!live.length && testing.length > 0 && html`<${FamilyNote} d=${d}/>`}
      ${shown.length
        ? html`<div class="grid g3">${featured.map((pk) => html`<${PickCard} pk=${pk}/>`)}</div>`
        : all.length ? html`<${Empty} title="No picks match these filters"><button class="btn ghost sm" onClick=${resetPf}>Reset filters</button></${Empty}>`
          : html`<${Empty} title="Nothing clears the bar right now">Either every game has tipped off (see "Locked in today" below) or no line is mispriced enough to beat the fee.</${Empty}>`}
      ${rest.length > 0 && html`<div style="margin-top:12px"><${MorePicks} picks=${rest} title=${`More picks · ${rest.length}`}/></div>`}
      <div style="margin-top:12px"><${Bubble} d=${d} keep=${keepSide}/></div>
      ${(d.watch || []).filter(keepSide).length > 0 && html`<div style="margin-top:12px"><${Info} id="watch" title=${`The model likes these, but no venue lists them (${d.watch.filter(keepSide).length})`}>
        <div class="small ink2" style="margin-bottom:6px">Unders on Polymarket US props can't be bought, and Kalshi doesn't list these lines right now. Shown for information; not counted in the record.</div>
        <table class="t"><tbody>${d.watch.filter(keepSide).map((w) => html`<tr class="click" onClick=${() => goPlayer(w.g, w.pid, w.line)}>
          <td><b>${w.name}</b> <span class="muted small">${w.team}</span></td><td class=${w.side}>${F.sideWord(w.side)} ${w.line}</td>
          <td class="r">fair ${F.pct(w.p)}</td><td class="r muted">Polymarket price if it traded ${F.odds(w.price)}</td></tr>`)}</tbody></table></${Info}></div>`}`}
    </section>
    <${LockedToday} d=${d}/>
    <section class="section">
      <div class="section-head"><h2>Combos</h2><span class="lede">Built only from tonight's picks. Just for inspiration: every leg has to hit.</span></div>
      <${CombosBlock} d=${d}/><${Combos2} d=${d}/>
    </section>
    <section class="section">
      <div class="section-head"><h2>Every line</h2><span class="lede">All Polymarket US points markets, game by game</span></div>
      <${Slate} d=${d}/>
    </section>
    <section class="section"><${TrustStrip} d=${d}/></section>
  </main>`;
}

// ---------------------------------------------------------------- full slate
const SLATE_OPEN = {};  // which games are expanded (kept while you look at a player and come back)
function Slate({ d }) {
  const [q, setQ] = useState('');
  const [mainOnly, setMainOnly] = useState(store.get('mainOnly', true));
  const [valueOnly, setValueOnly] = useState(false);
  const [side, setSide] = useState('all');
  const [adv, setAdv] = useState(store.get('adv', false));
  const [open, setOpenState] = useState(SLATE_OPEN);
  const setOpen = (o) => { Object.assign(SLATE_OPEN, o); setOpenState({ ...SLATE_OPEN }); };
  useEffect(() => store.set('adv', adv), [adv]);
  useEffect(() => store.set('mainOnly', mainOnly), [mainOnly]);
  const games = d.games || [];
  return html`<div>
    <div class="toolbar">
      <input class="input" placeholder="Search a player" value=${q} onInput=${(e) => setQ(e.target.value)} style="width:220px"/>
      <${Switch} checked=${mainOnly} onChange=${setMainOnly}>Main line only</${Switch}>
      <${Switch} checked=${valueOnly} onChange=${setValueOnly}>Only lines with an edge</${Switch}>
      <${Seg} value=${side} onChange=${setSide} options=${[['all', 'Both sides'], ['over', 'Over better'], ['under', 'Under better']]}/>
      <span class="spacer"></span>
      <${Switch} checked=${adv} onChange=${setAdv}>Show advanced</${Switch}>
    </div>
    ${games.map((g) => {
      let rows = (d.markets || []).filter((m) => m.g === g.id);
      if (mainOnly) rows = rows.filter((m) => m.main);
      if (valueOnly) rows = rows.filter((m) => (m.best_edge ?? -1) >= 0);
      if (side !== 'all') rows = rows.filter((m) => m.best === side);
      if (q) rows = rows.filter((m) => (d.players[`${m.g}:${m.p}`]?.name || '').toLowerCase().includes(q.toLowerCase()));
      if (!rows.length && (q || valueOnly || side !== 'all')) return null;
      rows.sort((a, b) => (d.players[`${a.g}:${a.p}`]?.name || '').localeCompare(d.players[`${b.g}:${b.p}`]?.name || '') || a.line - b.line);
      const isOpen = open[g.id] ?? (q !== '' || valueOnly || games.length <= 3);
      const nPicks = d.picks.filter((p) => p.g === g.id).length;
      return html`<div class="card game">
        <div class="gamehead" onClick=${() => setOpen({ ...open, [g.id]: !isOpen })}>
          <${TeamChip} tri=${d.tri(g.away)}/><span class="muted">@</span><${TeamChip} tri=${d.tri(g.home)}/>
          <b style="margin-left:4px">${d.teams?.[g.away]?.name?.split(' ').slice(-1)[0] || ''} at ${d.teams?.[g.home]?.name?.split(' ').slice(-1)[0] || ''}</b>
          <span class="muted small hide-sm">· ${F.dayET(g.tip)} ${F.timeET(g.tip)}${g.lock ? ` · picks lock ${F.timeET(g.lock)}` : ''}${isNum(g.total) ? ` · projected total ${g.total}` : ''}</span>
          <span class="spacer"></span>
          ${nPicks > 0 && html`<span class="chip good">${nPicks} pick${nPicks > 1 ? 's' : ''}</span>`}
          <span class="muted small">${rows.length} lines</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style=${`transform:rotate(${isOpen ? 180 : 0}deg);transition:transform .15s`}><path d="M6 9l6 6 6-6"/></svg>
        </div>
        ${isOpen && html`<div style="overflow-x:auto;border-top:1px solid var(--line)"><table class="t">
          <thead><tr><th>Player</th><th>Line</th><th class="r">Projection</th><th class="r">Fair · over</th><th class="r">Market · over</th><th>Better side</th><th class="r">Edge</th><th class="r">Price</th>
            ${adv && html`<th class="r">Bid / ask</th><th class="r">Model alone</th><th class="r">Blend</th><th class="r">Raw dist.</th><th class="r">Cost O / U</th><th class="r">Quote age</th><th>Flags</th>`}</tr></thead>
          <tbody>${rows.map((m) => {
            const p = d.players[`${m.g}:${m.p}`] || {};
            const pick = d.pickByKey[`${m.g}:${m.p}`];
            const isPick = pick && pick.m === m.id;
            const px = m.best === 'over' ? m.ask : isNum(m.bid) ? 1 - m.bid : null;
            return html`<tr class="click" onClick=${() => goPlayer(m.g, m.p, m.line)}>
              <td><b>${p.name}</b> ${isPick && html`<span class="chip good" style="margin-left:4px">Pick</span>`}</td>
              <td>${m.line} <span class="muted small">(${m.raw}+)</span></td>
              <td class="r">${p.proj?.q?.[2] ?? '—'} <span class="muted small">${p.proj?.q ? `${p.proj.q[0]}–${p.proj.q[4]}` : ''}</span></td>
              <td class="r">${F.pct(m.fair)}</td><td class="r">${F.pct(m.mid)}</td>
              <td class=${m.best}>${F.sideWord(m.best)}</td>
              <td class="r">${isNum(m.best_edge) ? html`<span class=${m.best_edge >= 0 ? 'good' : 'muted'}>${F.edge(m.best_edge, isNum(m.fair) ? (m.best === 'over' ? m.fair : 1 - m.fair) : null)}</span>` : '—'}</td>
              <td class="r">${F.odds(px)}</td>
              ${adv && html`<td class="r">${F.odds(m.bid)} / ${F.odds(m.ask)}</td><td class="r">${F.pct(m.model)}</td><td class="r">${F.pct(m.blend)}</td><td class="r">${F.pct(m.dist)}</td>
                <td class="r">${F.odds(m.cost_o, 1)} / ${F.odds(m.cost_u, 1)}</td><td class="r">${isNum(m.age) ? `${m.age} min` : '—'}</td><td class="small">${(m.flags || []).map((f) => F.FLAG_TEXT[f] || f).join(', ')}</td>`}
            </tr>`;
          })}</tbody></table></div>`}
      </div>`;
    })}
    <div class="small muted" style="margin-top:10px">Fair and market are the chance of the <b>Over</b>. Edge = fair chance of the better side minus its best placeable price plus that venue's taker fee (Polymarket US 0.0695 × p × (1 − p); Kalshi 0.07 × p × (1 − p), per share). Polymarket US only sells the Over on props.</div>
  </div>`;
}

// ===================================================================================== Player
function Tabs({ tabs, value, onChange }) {
  return html`<div class="tabs" role="tablist">${tabs.map(([v, label]) => html`<button role="tab" class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${label}</button>`)}</div>`;
}

const SITUATIONAL = { 'Injuries & teammates': 'Teammates / injuries', 'Opponent defense': 'Opponent defense', 'Game environment (pace, total, blowout)': 'Pace & game script', 'Rest & schedule': 'Rest & travel', 'Team style': 'Team style', 'Game script (4th quarter, blowouts)': '4th quarter & blowouts' };
const STAT_ORDER = ['pts', 'reb', 'ast', 'fg3m', 'pra', 'stl', 'blk'];
const STAT_NAME = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', fg3m: 'Threes', pra: 'Pts + Reb + Ast', stl: 'Steals', blk: 'Blocks' };
const STAT_WORD = { pts: 'points', reb: 'rebounds', ast: 'assists', fg3m: 'threes', pra: 'points + rebounds + assists', stl: 'steals', blk: 'blocks' };
const STAT_UNIT = { pts: 'pts', reb: 'reb', ast: 'ast', fg3m: '3PM', pra: 'PRA', stl: 'stl', blk: 'blk' };
// columns of a recent-game row: [date, opp, pts, min, reb, ast, fg3m, stl, blk]; PRA is the sum
const REC_IDX = { pts: [2], reb: [4], ast: [5], fg3m: [6], stl: [7], blk: [8], pra: [2, 4, 5] };
const recVal = (g, s) => (REC_IDX[s].every((i) => isNum(g[i])) ? REC_IDX[s].reduce((a, i) => a + g[i], 0) : null);
const relabel = (gr) => (gr ? Object.fromEntries(Object.entries(gr).map(([k, v]) => [k === 'Recent form & scoring history' ? 'Recent form & history' : k, v])) : gr);

// one shape for every stat's ladder: points from the slate (latest.json), other stats from the game file
function statView(d, p, x, stat, board, key) {
  if (stat === 'pts') {
    const rungs = (d.byPlayer[key] || []).map((m) => ({ ...m, usb: m.bid, usa: m.ask }));
    return { rungs, q: p.proj.q, mean: p.proj.mean, cdf: p.proj.cdf, base: p.proj.base_pts, groups: p.proj.groups,
      total: p.proj.mu_raw, drivers: p.proj.drivers };
  }
  const pl = (board?.props?.[`player.${stat}`] || []).find((r) => r.pid === p.id);
  const sx = x?.stats?.[stat] || {};
  const rungs = (pl?.rungs || []).map((r) => {
    const eo = isNum(r.fair) && isNum(r.co) ? r.fair - r.co : null;
    const eu = isNum(r.fair) && isNum(r.cu) ? 1 - r.fair - r.cu : null;
    const best = (eo ?? -9) >= (eu ?? -9) ? 'over' : 'under';
    return { id: r.id, line: r.l, raw: r.l + 0.5, fair: r.fair, model: r.model, mid: r.mid, bid: r.us?.b ?? r.k?.b,
      ask: r.us?.a ?? r.k?.a, usb: r.us?.b, usa: r.us?.a, kb: r.k?.b, ka: r.k?.a, cost_o: r.co, cost_u: r.cu, ov: r.ov,
      uv: r.uv, main: r.main, thin: r.thin, edge_o: eo, edge_u: eu, best, best_edge: best === 'over' ? eo : eu };
  });
  const groups = relabel(sx.groups);
  const total = isNum(sx.base) && groups ? sx.base + Object.values(groups).reduce((a, b) => a + b, 0) : null;
  return { rungs, q: pl?.q?.length ? pl.q : null, mean: sx.mean ?? pl?.mu, cdf: sx.cdf, base: sx.base, groups, total,
    drivers: sx.drivers };
}

// the pick (if any) on this player and stat tonight
function pickFor(d, gid, pid, stat) {
  if (stat === 'pts') return d.pickByKey[`${gid}:${pid}`];
  return (d.fam_picks || []).find((x) => x.g === gid && x.pid === +pid && x.fam === `player.${stat}` && x.tier === 'pick');
}

function takeText(p, v, m, side, d, stat, pick) {
  const q = v.q;
  const first = (p.name || '').split(' ')[0];
  const word = STAT_WORD[stat];
  const parts = [q ? html`The model projects <b>${q[2]} ${word}</b> for ${first} (80% range ${q[0]}–${q[4]}) in about <b>${Math.round(p.proj.min)} minutes</b>. `
    : html`The model expects about <b>${isNum(v.mean) ? v.mean.toFixed(1) : '—'} ${word}</b> for ${first} in about <b>${Math.round(p.proj.min)} minutes</b>. `];
  if (m) {
    const fair = side === 'over' ? m.fair : 1 - m.fair;
    const mkt = side === 'over' ? m.mid : isNum(m.mid) ? 1 - m.mid : null;
    const edge = side === 'over' ? m.edge_o : m.edge_u;
    parts.push(isNum(fair) ? html`At <b>${F.sideWord(side)} ${m.line}</b> the fair chance is <b>${F.pct(fair)}</b> against a market at ${F.pct(mkt)}. `
      : html`At <b>${m.line}</b> there's no real two-sided book yet, so there's no fair chance; the model alone says ${F.pct(side === 'over' ? m.model : 1 - m.model)} for the ${F.sideWord(side)}. `);
    const isPick = pick && (pick.m === m.id || pick.line === m.line);
    if (isPick) parts.push(html`That's one of tonight's <b>picks</b>${pick.st !== 'live' ? ' (Testing)' : ''}: an edge of ${F.edge(pick.edge, pick.p)} after the fee on ${VENUE[pick.venue] || 'its venue'}. `);
    else if (pick) parts.push(html`Tonight's pick on his ${word} is <b>${F.sideWord(pick.side)} ${pick.line}</b>. `);
    else if (isNum(edge) && edge >= 0) parts.push(html`There's a small edge (${F.edge(edge, fair)}), but it doesn't pass every filter (spread, price range, verified order book or injury status). `);
    else if (isNum(edge)) parts.push(html`After the spread and fee there's <b>no edge</b> here (${F.edge(edge, fair)}). `);
    if (isNum(m.model) && isNum(m.mid) && Math.abs(m.model - m.mid) > 0.08) {
      parts.push(html`On its own the model would say ${F.pct(side === 'over' ? m.model : 1 - m.model)}, a big gap from the market; history says to trust the market more in that case. `);
    }
  }
  const sit = Object.entries(v.groups || {}).filter(([k, x]) => SITUATIONAL[k] && Math.abs(x) >= (stat === 'pts' || stat === 'pra' ? 0.2 : 0.05))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
  if (sit.length) parts.push(html`Tonight's situation: ${sit.map(([k, x]) => `${SITUATIONAL[k]} ${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(stat === 'pts' || stat === 'pra' ? 1 : 2)} ${STAT_UNIT[stat]}`).join(', ')}. `);
  const bw = blowoutWatch(p, stat);
  if (bw && bw.p >= 0.25 && bw.min <= -0.8) parts.push(html`<b>Blowout watch:</b> a ${F.pct(bw.p)} chance this one is decided by 15+ entering the 4th, and in those games he has played ${Math.abs(bw.cut).toFixed(1)} fewer 4th-quarter minutes (about ${Math.abs(bw.min).toFixed(1)} min${isNum(bw.out) ? ` and ${Math.abs(bw.out).toFixed(stat === 'pts' || stat === 'pra' ? 1 : 2)} ${STAT_UNIT[stat]}` : ''} expected tonight; see Game flow). `);
  else if (bw && bw.p >= 0.25 && bw.min >= 0.8) parts.push(html`<b>Blowout upside:</b> a ${F.pct(bw.p)} chance this one is decided by 15+ entering the 4th, and he has played ${bw.cut.toFixed(1)} <i>more</i> 4th-quarter minutes in those games (garbage time). `);
  if (['Questionable', 'Doubtful', 'Probable'].includes(p.proj.status)) parts.push(html`He's listed <b>${p.proj.status}</b>: players with that status have played ${F.pct(p.proj.play)} of the time. If he sits, the venues settle at the last fair price (roughly a refund).`);
  return parts;
}

function Player({ d, gid, pid, a3, a4 }) {
  const key = `${gid}:${pid}`;
  const legacy = a3 != null && a3 !== '' && isNum(+a3);  // old links: #/player/{game}/{player}/{points line}
  const statArg = !a3 || legacy ? 'pts' : a3;
  const lineArg = legacy ? a3 : a4;
  const { board } = useBoard(gid, d.board_files?.[gid]);
  const p0 = d.players[key];
  const x = board?.px?.[String(pid)];  // detail from the game file (distributions, drivers, matchup, teammates, games)
  const p = p0 && x ? { ...p0, proj: { ...p0.proj, ...x.proj }, matchup: x.matchup ?? p0.matchup, mates: x.mates ?? p0.mates,
    report: x.report ?? p0.report, recent: x.recent, avg: x.avg, mx: x.mx, flow: x.flow } : p0;
  const avail = STAT_ORDER.filter((s) => (s === 'pts' ? (d.byPlayer[key] || []).length > 0
    : (board?.props?.[`player.${s}`] || []).some((r) => r.pid === +pid)));
  const stat = avail.includes(statArg) || !board ? statArg : (avail[0] || statArg);
  const v = p ? statView(d, p, x, stat, board, key) : { rungs: [] };
  const rungs = v.rungs;
  const defLine = isNum(+lineArg) && rungs.some((m) => m.line === +lineArg) ? +lineArg : (rungs.find((m) => m.main) || rungs[0])?.line;
  const [line, setLine] = useState(defLine);
  const [tab, setTab] = useState('recent');
  useEffect(() => setLine(defLine), [key, stat, lineArg, rungs.length]);
  const g = d.gameById[gid] || {};
  const gameHash = `#/game/${gid}/props/player.${stat}`;
  const back = html`<div class="row wrap" style="gap:14px"><${BackLink} d=${d} fallback=${gameHash} label=${g.id ? `${d.tri(g.away)} @ ${d.tri(g.home)}` : 'Tonight'}/>
    ${g.id && prevGame() !== gid && html`<a class="back" href=${gameHash}>${d.tri(g.away)} @ ${d.tri(g.home)}: every ${STAT_WORD[stat]} line →</a>`}</div>`;
  if (!p) return html`<main class="page">${back}<${Empty} title="Player not on tonight's slate">He may have played already, or his markets closed.</${Empty}></main>`;
  if (stat !== 'pts' && !board) return html`<main class="page">${back}<div class="card pad muted">Loading his ${STAT_WORD[stat]} lines…</div></main>`;
  const m = rungs.find((r) => r.line === line);
  const side = m ? m.best : 'over';
  const q = v.q || [];
  const fair = m && isNum(m.fair) ? (side === 'over' ? m.fair : 1 - m.fair) : null;
  const mkt = m ? (side === 'over' ? m.mid : isNum(m.mid) ? 1 - m.mid : null) : null;
  const edge = m ? (side === 'over' ? m.edge_o : m.edge_u) : null;
  const cost = m ? (side === 'over' ? m.cost_o : m.cost_u) : null;
  const ven = m ? (side === 'over' ? m.ov : m.uv) : null;
  const statusTone = { Out: 'bad', Doubtful: 'bad', Questionable: 'warn', Probable: 'good', Available: 'good' }[p.proj.status] || '';
  const recent = (p.recent?.length ? p.recent : (stat === 'pts' ? p.form.recent : [])) || [];
  const r10 = recent.map((gm) => recVal(gm, stat)).filter(isNum).slice(-10);
  const hits = isNum(line) ? r10.filter((val) => (side === 'over' ? val > line : val < line)).length : null;
  const fam = `player.${stat}`;
  const st = d.families?.[fam]?.status || 'testing';
  const pick = pickFor(d, gid, pid, stat);
  const unit = STAT_UNIT[stat];
  const lineFallback = isNum(q[2]) ? q[2] + 0.5 : 0.5;
  return html`<main class="page">
    ${back}
    <div class="phead">
      <div><div class="row small ink2" style="gap:6px;margin-bottom:6px"><${TeamChip} tri=${d.tri(p.team)}/> ${p.home ? 'vs' : '@'} ${d.tri(p.opp)} · ${F.dayET(g.tip)} ${F.timeET(g.tip)}</div>
        <h1>${p.name}</h1></div>
      <span class="spacer"></span>
      <span class=${`chip ${statusTone}`}>${p.proj.status_text}</span>
    </div>
    ${avail.length > 1 && html`<div class="toolbar" style="margin-top:14px"><span class="small ink2">Stat</span>
      <${Seg} value=${stat} onChange=${(s) => go(`#/player/${gid}/${pid}/${s}`, true)} options=${avail.map((s) => [s, STAT_NAME[s]])}/>
      <span class="spacer"></span><${FamilyBadge} st=${st}/></div>`}
    ${rungs.length > 0 && html`<div class="toolbar" style="margin-top:8px"><span class="small ink2">Line</span>
      <${Seg} value=${line} onChange=${setLine} options=${rungs.map((r) => [r.line, `${r.raw}+`])}/></div>`}
    <div class="callout take" style="margin-top:8px"><div class="up muted" style="margin-bottom:4px">The model's take · ${STAT_NAME[stat]}</div><div>${takeText(p, v, m, side, d, stat, pick)}</div>
      ${st !== 'live' && stat !== 'pts' && html`<div class="small ink2" style="margin-top:6px">${STAT_NAME[stat]} picks are in Testing: shown and tracked, but they count only after this market passes the same pre-registered backtest as points.</div>`}</div>
    <div class="tiles" style="margin-top:14px">
      <div class="tile"><div class="k">Projection</div><div class="v">${isNum(q[2]) ? q[2] : isNum(v.mean) ? v.mean.toFixed(1) : '—'} ${unit}</div><div class="s">${isNum(q[0]) ? `80%: ${q[0]}–${q[4]}` : ''}${isNum(v.mean) ? ` · avg ${v.mean.toFixed(1)}` : ''}</div></div>
      <div class="tile"><div class="k">Minutes</div><div class="v">${Math.round(p.proj.min)}</div><div class="s">${isNum(p.form?.l10_min) ? `last 10: ${Math.round(p.form.l10_min)}` : ''}</div></div>
      <div class="tile"><div class="k">${m ? `Fair · ${F.sideWord(side)} ${m.line}` : 'Fair chance'}</div><div class=${`v ${side}`}><${OddsV} p=${fair}/></div><div class="s">model alone ${m ? F.odds(side === 'over' ? m.model : 1 - m.model) : '—'}</div></div>
      <div class="tile"><div class="k">Market</div><div class="v"><${OddsV} p=${mkt}/></div><div class="s">${isNum(cost) ? `best ${F.odds(cost, 1)} all-in on ${VENUE[ven] || '—'}` : m ? `${F.sideWord(side)} not sold right now` : ''}</div></div>
      <div class="tile"><div class="k">Edge</div><div class=${`v ${isNum(edge) && edge >= 0 ? 'good' : ''}`}>${F.oddsMode() === 'us' ? (isNum(fair) ? `fair ${F.american(fair)}` : '—') : F.signedPct(edge)}</div>
        <div class="s">${F.oddsMode() === 'both' && isNum(fair) ? `fair line ${F.american(fair)} · ` : ''}after the fee</div></div>
      <div class="tile"><div class="k">Plays</div><div class="v">${F.pct(p.proj.play)}</div><div class="s">${isNum(hits) && r10.length ? `last ${r10.length}: ${hits}/${r10.length} ${side}` : ''}</div></div>
    </div>
    ${board && isNum(line) && html`<${PropSlip} d=${d} b=${board} fam=${fam} pid=${+pid} line=${line}/>`}
    <div class="grid g2" style="margin-top:14px">
      <div class="card chartcard"><h3>Every line on the ladder</h3><p class="cap">Chance he goes over each line: our fair chance vs the market.</p>
        ${rungs.length ? html`<${C.Ladder} rows=${rungs.map((r) => ({ line: r.line, fair: r.fair, model: r.model, mid: r.mid, bid: r.bid, ask: r.ask }))} sel=${line}/>` : html`<div class="muted small" style="padding:20px 0">No lines listed for this stat right now.</div>`}</div>
      <div class="card chartcard"><h3>How many ${STAT_WORD[stat]}? ${isNum(q[2]) ? `Median ${q[2]}, 80% range ${q[0]}–${q[4]}` : ''}</h3><p class="cap">The model's own distribution (before it's anchored to the price).</p>
        ${v.cdf?.length ? html`<${C.Dist} cdf=${v.cdf} line=${line ?? lineFallback} q=${q.length ? q : [0, 0, 0, 0, 0]} unit=${unit}/>` : html`<div class="muted small" style="padding:20px 0">Loading the distribution…</div>`}</div>
    </div>
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[['recent', 'Recent games'], ['flow', 'Game flow'], ['why', 'Why'], ['team', 'Injuries & teammates'], ['matchup', 'Matchup'], ['numbers', 'All numbers']]}/>
    ${tab === 'recent' && html`<${RecentTab} p=${p} line=${line ?? lineFallback} stat=${stat} q=${q} recent=${recent}/>`}
    ${tab === 'flow' && html`<${FlowTab} p=${p} d=${d} stat=${stat}/>`}
    ${tab === 'why' && html`<${WhyTab} p=${p} v=${v} stat=${stat}/>`}
    ${tab === 'team' && html`<${TeamTab} p=${p} v=${v} stat=${stat}/>`}
    ${tab === 'matchup' && html`<${MatchupTab} p=${p} d=${d} v=${v} stat=${stat}/>`}
    ${tab === 'numbers' && html`<${NumbersTab} p=${p} v=${v} stat=${stat}/>`}
  </main>`;
}

function RecentTab({ p, line, stat, q, recent }) {
  const rows = recent.map((g) => [g[0], g[1], recVal(g, stat), g[3]]).filter((g) => isNum(g[2]));
  if (!rows.length) return html`<${Empty} title="No games yet">No games in the data for him yet.</${Empty}>`;
  const last10 = rows.slice(-10);
  const over = last10.filter((g) => g[2] > line).length;
  const avg = last10.reduce((a, g) => a + g[2], 0) / last10.length;
  const av = p.avg?.[stat];
  const word = STAT_WORD[stat];
  return html`<div>
    <div style="margin-bottom:10px"><b>Over ${line} in ${over} of his last ${last10.length} games</b> · averaging ${avg.toFixed(1)} ${word} over that stretch.
      ${av && html`<span class="ink2"> Season to date ${isNum(av.season) ? av.season : '—'} · last 5 ${isNum(av.l5) ? av.l5 : '—'} · last 20 ${isNum(av.l20) ? av.l20 : '—'}.</span>`}</div>
    <div class="card chartcard"><${C.Recent} games=${rows} line=${line} q=${q.length ? q : [avg, avg, avg, avg, avg]} unit=${STAT_UNIT[stat]}/></div>
    <div class="tablewrap" style="margin-top:12px"><table class="t"><thead><tr><th>Date</th><th>Opponent</th><th class="r">Min</th><th class="r">${STAT_NAME[stat]}</th><th>vs ${line}</th></tr></thead>
      <tbody>${[...rows].reverse().map((g) => html`<tr><td>${F.shortDate(g[0])}, ${g[0].slice(0, 4)}</td><td>${g[1]}</td><td class="r">${Math.round(g[3])}</td><td class="r"><b>${g[2]}</b></td>
        <td class=${g[2] > line ? 'over' : 'under'}>${g[2] > line ? 'Over' : 'Under'}</td></tr>`)}</tbody></table></div>
  </div>`;
}

// ---- game flow: when in the game he plays and produces, and what the score does to it (play-by-play)
const flowVal = (o, stat) => (!o ? null : stat === 'pra' ? (isNum(o.pts) ? o.pts + (o.reb || 0) + (o.ast || 0) : null) : o[stat]);
const MARGIN_NAME = { t20: 'Down 20+', t10: 'Down 10–19', c: 'Within 9', l10: 'Up 10–19', l20: 'Up 20+' };

// one sentence for the take and the flow tab: expected 4th-quarter minutes (and output) lost or gained to the score
function blowoutWatch(p, stat) {
  const fl = p.flow;
  const t = fl?.tonight;
  if (!t || !isNum(t.gs_p_bo) || !isNum(t.gs_exp_q4_cut)) return null;
  const q4 = (fl.quarters || []).find((x) => x.q === 4);
  const rate = q4 && q4.min > 0 ? (flowVal(q4, stat) ?? 0) / q4.min : null;
  return { p: t.gs_p_bo, min: t.gs_exp_q4_cut, out: isNum(rate) ? t.gs_exp_q4_cut * rate : null, cut: t.gs_bo_q4_cut };
}

function FlowTab({ p, d, stat }) {
  const fl = p.flow;
  if (!fl || !fl.n) return html`<${Empty} title="No play-by-play yet">Game-flow numbers need at least one of his games with a verified play-by-play.</${Empty}>`;
  const word = STAT_WORD[stat];
  const unit = STAT_UNIT[stat];
  const first = (p.name || '').split(' ')[0];
  const qs = fl.quarters || [];
  const sp = fl.splits || {};
  const w = blowoutWatch(p, stat);
  const t = fl.tonight || {};
  const dd = stat === 'pts' || stat === 'pra' ? 1 : 2;
  const fmt = (x, k = 1) => (isNum(x) ? x.toFixed(k) : '—');
  const signed = (x, k = 1) => (isNum(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(k)}` : '—');
  const q4 = qs.find((x) => x.q === 4);
  const q4share = q4 && qs.length ? q4.min / qs.reduce((a, x) => a + (x.q <= 4 ? x.min : 0), 0) : null;
  const margin = fl.margin || [];
  // [column, words, short header]
  const per36 = stat === 'fg3m' ? ['fg3a', 'three-point attempts', '3PA'] : ['pts', 'reb', 'ast'].includes(stat)
    ? [stat, STAT_WORD[stat], unit.toUpperCase()] : ['pts', 'points', 'PTS'];
  const fav = isNum(fl.margin_proj) ? (fl.margin_proj >= 0 ? `${d.tri(p.team)} by ${fl.margin_proj.toFixed(1)}` : `${d.tri(p.opp)} by ${(-fl.margin_proj).toFixed(1)}`) : null;
  const rows = [['close', 'Within 9'], ['up', `${d.tri(p.team)} up 15+`], ['down', `${d.tri(p.team)} down 15+`]];
  const inModel = d.settings?.gamescript_in_model;
  return html`<div>
    <p class="ink2" style="margin-top:0">When in the game ${first} plays and produces, and what the scoreboard does to it. From the play-by-play of his last ${fl.n} games, rebuilt possession by possession and checked against each box score.</p>
    ${w && html`<div class=${`callout ${w.p >= 0.25 && w.min <= -0.8 ? 'warn' : ''}`} style="margin-bottom:12px"><b>Tonight:</b> ${fav ? `projected margin ${fav}, so ` : ''}a <b>${F.pct(w.p)}</b> chance this game enters the 4th quarter decided by 15+.
      ${Math.abs(w.cut) >= 0.5 ? html` In games like that he has played <b>${signed(w.cut)} 4th-quarter minutes</b> compared with close games. Weighted by tonight's chance, that's about <b>${signed(w.min)} min</b>${isNum(w.out) ? html` and <b>${signed(w.out, dd)} ${unit}</b>` : ''} expected.`
        : ' His 4th-quarter minutes have barely changed in blowouts, so the score matters little for him.'}
      <div class="tiny muted" style="margin-top:4px">${inModel ? 'The model uses these game-script inputs.' : "Shown for context. The model is being tested with these inputs and uses them only if they make its predictions measurably better; until then this isn't in its numbers (beyond its general margin and blowout-risk inputs)."}</div></div>`}
    <div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));margin-bottom:12px">
      <div class="tile"><div class="k">4th-quarter share</div><div class="v" style="font-size:22px">${F.pct(q4share)}</div><div class="s">of his minutes come in the 4th</div></div>
      <div class="tile"><div class="k">4th-quarter rate</div><div class="v" style="font-size:22px">${isNum(t.gs_q4_ppm_ratio) ? `${t.gs_q4_ppm_ratio.toFixed(2)}×` : '—'}</div><div class="s">points per minute vs quarters 1–3 (close games)</div></div>
      <div class="tile"><div class="k">Garbage time</div><div class="v" style="font-size:22px">${F.pct(t.gs_garbage_share ?? ((margin.find((m) => m.b === 't20')?.share || 0) + (margin.find((m) => m.b === 'l20')?.share || 0)))}</div><div class="s">of his minutes at 20+ either way</div></div>
      <div class="tile"><div class="k">Share of team points</div><div class="v" style="font-size:22px">${F.pct(fl.share?.l10)}</div><div class="s">last 10 · ${F.pct(fl.share?.l40)} over 40</div></div>
      <div class="tile"><div class="k">His coach in blowouts</div><div class="v" style="font-size:22px">${isNum(t.gs_team_bo_cut) ? `${signed(t.gs_team_bo_cut)} min` : '—'}</div><div class="s">starters' 4th-quarter minutes vs close games</div></div>
    </div>
    <div class="grid g2">
      <div class="card chartcard"><h3>${STAT_NAME[stat]} by quarter</h3><p class="cap">Per game, last ${fl.n} games${qs.some((x) => x.q === 5) ? ' (OT averaged over all games)' : ''}.</p>
        <${C.QuarterBars} rows=${qs.map((x) => ({ q: x.q, v: flowVal(x, stat) }))} unit=${unit} digits=${dd === 1 ? 1 : 2} label=${STAT_NAME[stat]}/></div>
      <div class="card chartcard"><h3>Minutes by quarter</h3><p class="cap">Stars usually sit early in the 2nd and close games in the 4th.</p>
        <${C.QuarterBars} rows=${qs.map((x) => ({ q: x.q, v: x.min }))} unit="min" label="Minutes"/></div>
    </div>
    <div class="card pad flowt" style="margin-top:12px"><h3 style="margin:0 0 4px;font-size:15px">Close games vs blowouts</h3>
      <div class="small muted" style="margin-bottom:8px">Grouped by the score entering the 4th quarter. Few games in a row means a noisy average.</div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Entering the 4th</th><th class="r">Games</th><th class="r hide-sm">Min</th><th class="r">Q4 min</th><th class="r">${unit}</th></tr></thead>
        <tbody>${rows.map(([k, label]) => { const s = sp[k] || {}; return html`<tr><td>${label}</td><td class="r">${s.n || 0}</td><td class="r hide-sm">${fmt(s.min)}</td><td class="r"><b>${fmt(s.q4)}</b></td><td class="r"><b>${fmt(flowVal(s, stat), dd)}</b></td></tr>`; })}</tbody></table></div>
    </div>
    <div class="card pad flowt" style="margin-top:12px"><h3 style="margin:0 0 4px;font-size:15px">By the score while he's on the court</h3>
      <div class="small muted" style="margin-bottom:8px">Share of his minutes at each margin, and his ${per36[1]} per 36 minutes there (blank under 5 minutes). Catch-up shooting shows up as more shots when trailing.</div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Margin</th><th>His minutes</th><th class="r">${per36[2]}/36</th><th class="r hide-sm">FGA/36</th></tr></thead>
        <tbody>${margin.map((m) => html`<tr><td>${MARGIN_NAME[m.b]}</td>
          <td><div class="row" style="gap:6px"><div class="gd-bar" style="flex:1;min-width:36px;max-width:140px"><i style=${`width:${Math.round(100 * (m.share || 0))}%`}></i></div><span class="small">${F.pct(m.share)}</span></div></td>
          <td class="r">${fmt(m[per36[0]])}</td><td class="r hide-sm">${fmt(m.fga)}</td></tr>`)}</tbody></table></div>
    </div>
  </div>`;
}

function WhyTab({ p, v, stat }) {
  const pr = p.proj;
  const unit = STAT_UNIT[stat];
  const mg = Object.fromEntries(Object.entries(pr.min_groups || {}).map(([k, x]) => [k.startsWith('Recent form') ? 'Recent minutes & form' : k, x]));
  return html`<div>
    <p class="ink2" style="margin-top:0">Start from a typical player-game, then add what's different about him and tonight. Blue raises the projection, orange lowers it; the steps add up exactly to the model's average.</p>
    <div class="grid g2">
      <div class="card chartcard"><h3>${STAT_NAME[stat]}</h3>${isNum(v.base) && v.groups ? html`<${C.Waterfall} base=${v.base} groups=${v.groups} total=${v.total} unit=${unit}/>`
        : html`<div class="muted small" style="padding:20px 0">The breakdown appears with the next price update.</div>`}</div>
      <div class="card chartcard"><h3>Minutes</h3><${C.Waterfall} base=${pr.base_min} groups=${mg} total=${pr.min} unit="min"/></div>
    </div>
    <div class="tablewrap" style="margin-top:12px"><table class="t"><thead><tr><th>Biggest single factors</th><th>His value</th><th class="r">Effect</th></tr></thead>
      <tbody>${[...(v.drivers || []).map((x) => [...x, unit]), ...(pr.min_drivers || []).map((x) => [...x, 'min'])].map((x) => html`<tr><td>${x[0]}</td><td>${x[1]}</td><td class=${`r ${x[2] >= 0 ? 'over' : 'under'}`}>${x[2] >= 0 ? '+' : '−'}${Math.abs(x[2]).toFixed(x[3] === 'pts' || x[3] === 'min' || x[3] === 'PRA' ? 1 : 2)} ${x[3]}</td></tr>`)}</tbody></table></div>
  </div>`;
}

function TeamTab({ p, v, stat }) {
  const rep = p.report || {};
  const mates = p.mates || [];
  const net = v.groups?.['Injuries & teammates'];
  return html`<div class="grid g2">
    <div class="card pad"><h3 style="margin:0 0 4px;font-size:15px">His team's injury report</h3>
      <div class="small muted" style="margin-bottom:8px">${rep.ts ? `Latest report: ${F.dayET(rep.ts)} ${F.timeET(rep.ts)} ET` : "Teams file on game day; tonight's report isn't out yet."}</div>
      ${(rep.rows || []).length ? html`<table class="t"><tbody>${rep.rows.map((r) => html`<tr><td>${r.name}</td><td><span class=${`chip ${r.status === 'OUT' ? 'bad' : 'warn'}`}>${r.status}</span></td><td class="small muted wrap">${r.reason || ''}</td></tr>`)}</tbody></table>`
        : html`<div class="small ink2">Nobody listed.</div>`}
      ${isNum(net) && html`<div class="note" style="margin-top:10px">Net effect of injuries & teammates on his ${STAT_WORD[stat]} projection tonight: <b>${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(stat === 'pts' || stat === 'pra' ? 1 : 2)} ${STAT_UNIT[stat]}</b>.</div>`}
    </div>
    <div class="card pad"><h3 style="margin:0 0 4px;font-size:15px">When key teammates sat</h3>
      <div class="small muted" style="margin-bottom:8px">His scoring and usage in games each teammate missed (this season and last), shrunk toward zero when there are few such games.</div>
      ${mates.length ? html`<table class="t"><thead><tr><th>Teammate</th><th class="r">Games without</th><th class="r">Pts / 36</th><th class="r">Usage</th></tr></thead>
        <tbody>${mates.map((x) => html`<tr><td>${x.name}</td><td class="r">${x.n_out}</td><td class=${`r ${x.p36 >= 0 ? 'over' : 'under'}`}>${x.p36 >= 0 ? '+' : '−'}${Math.abs(x.p36 || 0).toFixed(1)}</td><td class="r">${F.signedPct(x.dusg, 1)}</td></tr>`)}</tbody></table>`
        : html`<div class="small ink2">No teammate history yet.</div>`}
    </div></div>`;
}

// what the opponent gives up in this stat (and what his team generates), vs league average
const MX_ROWS = {
  reb: [['opp_reb100_allowed_rel', 'Rebounds teams get against this opponent, per 100 possessions'], ['opp_oreb_pct_allowed_rel', 'Offensive-rebound rate it allows', 'pp'],
    ['opp_dreb_pct_allowed_rel', 'Defensive-rebound rate it allows', 'pp'], ['own_reb100_rel', "His team's rebounds per 100"], ['reb_share_l20', 'His share of team rebounds (last 20)', 'share']],
  ast: [['opp_ast100_allowed_rel', 'Assists teams get against this opponent, per 100'], ['own_ast100_rel', "His team's assists per 100"], ['ast_share_l20', 'His share of team assists (last 20)', 'share']],
  fg3m: [['opp_fg3m100_allowed_rel', 'Threes teams make against this opponent, per 100'], ['own_fg3m100_rel', "His team's threes per 100"], ['fg3pct_std', 'His 3-point % this season (shrunk toward average)', 'share']],
  stl: [['opp_stl100_allowed_rel', 'Steals teams get against this opponent, per 100'], ['own_stl100_rel', "His team's steals per 100"]],
  blk: [['opp_blk100_allowed_rel', 'Blocks teams get against this opponent, per 100'], ['own_blk100_rel', "His team's blocks per 100"]],
};
MX_ROWS.pra = [...MX_ROWS.reb.slice(0, 1), ...MX_ROWS.ast.slice(0, 1), ['opp_tov100_allowed_rel', 'Turnovers this opponent forces, per 100']];

function MatchupTab({ p, d, v, stat }) {
  const mu = p.matchup;
  if (!mu) return html`<${Empty} title="No matchup data">Matchup features aren't available for this game yet.</${Empty}>`;
  const words = (r) => (r >= 3 ? 'much weaker than average' : r >= 1 ? 'weaker than average' : r > -1 ? 'about average' : r > -3 ? 'stronger than average' : 'much stronger than average');
  const pace = (r) => (r >= 1.5 ? 'fast' : r <= -1.5 ? 'slow' : 'average pace');
  const ord = (n) => (isNum(n) ? `${n}${[11, 12, 13].includes(n % 100) ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}` : '—');
  const tiles = [
    ['Opponent defense', `${ord(mu.def_rank)} of ${mu.n_teams || 30}`, `${mu.def_rel >= 0 ? '+' : ''}${mu.def_rel} pts/100 vs avg · ${words(mu.def_rel)}`],
    ['Opponent pace', `${ord(mu.pace_rank)} fastest`, `${mu.pace_rel >= 0 ? '+' : ''}${mu.pace_rel} possessions · ${pace(mu.pace_rel)}`],
    ['Points allowed to his position', `${mu.pos_rel >= 0 ? '+' : ''}${mu.pos_rel}`, '+ easier than average, − tougher'],
    ['Projected total', `${mu.total}`, `his team ${mu.team_pts} · margin ${mu.margin >= 0 ? '+' : ''}${mu.margin}`],
    ['Rest', `${mu.rest} day${mu.rest === 1 ? '' : 's'}`, mu.b2b ? 'second night of a back-to-back' : 'not a back-to-back'],
    ['Travel', `${(mu.travel_km || 0).toLocaleString()} km`, `time-zone change ${mu.tz >= 0 ? '+' : ''}${mu.tz} h`],
    ['Venue', p.home ? 'Home' : 'Away', ''],
    ['Blowout risk', mu.blowout < 5 ? 'Low' : mu.blowout < 9 ? 'Moderate' : 'High', `expected margin ±${mu.blowout} pts`],
  ];
  const g = v.groups || {};
  const rows = (MX_ROWS[stat] || []).filter(([k]) => isNum(p.mx?.[k]));
  const sgn = (v, dd) => (Math.abs(v) < 0.5 * 10 ** -dd ? (0).toFixed(dd) : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(dd)}`);
  const fmt = (x, kind) => (kind === 'share' ? F.pct(x, 1) : kind === 'pp' ? `${sgn(100 * x, 1)} pct. pts` : sgn(x, 1));
  const tone = (x, kind) => (kind === 'share' || Math.abs(kind === 'pp' ? 100 * x : x) < 0.05 ? '' : x > 0 ? 'over' : 'under');
  return html`<div>
    ${rows.length > 0 && html`<div class="card pad" style="margin-bottom:12px"><h3 style="margin:0 0 6px;font-size:15px">${STAT_NAME[stat]} matchup</h3>
      <table class="t"><tbody>${rows.map(([k, label, kind]) => html`<tr><td>${label}</td><td class=${`r ${tone(p.mx[k], kind)}`}><b>${fmt(p.mx[k], kind)}</b></td><td class="small muted">${kind === 'share' ? '' : 'vs league average'}</td></tr>`)}</tbody></table>
      <div class="tiny muted" style="margin-top:6px">From games before tonight, shrunk toward league average early in the season. + means more ${STAT_WORD[stat]} than average.</div></div>`}
    <div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">${tiles.map(([k, val, s]) => html`<div class="tile"><div class="k">${k}</div><div class="v" style="font-size:22px">${val}</div><div class="s">${s}</div></div>`)}</div>
    ${stat === 'pts' && html`<${Guards} p=${p} d=${d} mu=${mu}/>`}
    <div class="note" style="margin-top:12px">Effect on his ${STAT_WORD[stat]} projection in the model: ${Object.keys(SITUATIONAL).filter((k) => isNum(g[k])).map((k) => `${SITUATIONAL[k]} ${g[k] >= 0 ? '+' : '−'}${Math.abs(g[k]).toFixed(stat === 'pts' || stat === 'pra' ? 1 : 2)} ${STAT_UNIT[stat]}`).join(' · ') || 'not available yet'}.
      Opponent strength comes from games before tonight, shrunk toward league average early in the season.</div>
  </div>`;
}

// defender rating: points allowed per 100 tracked possessions vs what his matchups usually score (negative = tough)
const dqWord = (x) => (!isNum(x) ? 'no rating yet' : x <= -3 ? 'tough defender' : x <= -1 ? 'solid defender' : x < 1 ? 'average defender' : x < 3 ? 'below-average defender' : 'weak defender');

function Guards({ p, d, mu }) {
  const gd = mu.guards || [];
  if (!gd.length) return null;
  const notes = [];
  if (isNum(mu.def_out) && Math.abs(mu.def_out) >= 0.05) notes.push(mu.def_out > 0 ? `Defenders who usually cover players like him are out for ${F.pct(mu.def_out)} more of their time than usual tonight.` : `More of his usual defenders are back than usual (${F.pct(-mu.def_out)} of their time).`);
  if (isNum(mu.h2h) && Math.abs(mu.h2h) >= 2) notes.push(`Against ${d.tri(p.opp)} lately he has scored ${mu.h2h >= 0 ? '+' : '−'}${Math.abs(mu.h2h).toFixed(1)} pts per 100 tracked possessions vs his norm.`);
  return html`<div class="card pad" style="margin-top:12px">
    <h3 style="margin:0 0 4px;font-size:15px">Who usually guards him</h3>
    <p class="small ink2" style="margin:0 0 10px">From NBA.com player tracking: the ${d.tri(p.opp)} defenders who have spent the most time on players like him (same position and role) in their recent games.</p>
    <div class="guards">${gd.map((x) => html`<div class="guard">
      <div class="gd-name"><b>${x.name || '—'}</b>${x.status && x.status !== 'Not on injury report' ? html` <span class=${`chip ${/out|doubt|quest/i.test(x.status) ? 'warn' : 'ghost'}`}>${x.status}</span>` : ''}</div>
      <div class="gd-bar" title=${`${F.pct(x.share)} of the time`}><i style=${`width:${Math.round(100 * x.share)}%`}></i></div>
      <div class="small ink2">${F.pct(x.share)} of the time</div>
      <div class="small">${dqWord(x.dq)} <span class="tiny muted">${isNum(x.dq) ? `${x.dq >= 0 ? '+' : '−'}${Math.abs(x.dq).toFixed(1)} pts/100` : ''}</span></div>
    </div>`)}</div>
    ${notes.length > 0 && html`<div class="small ink2" style="margin-top:10px">${notes.join(' ')}</div>`}
    <div class="tiny muted" style="margin-top:8px">Defender rating = points allowed per 100 tracked possessions compared with what the same scorers usually get against defenders at that position (minus = tougher).
      ${d.settings?.matchups_in_model ? ' The model uses this tracking data.' : ' Shown for context: the model is being tested with this data and only starts using it if it makes predictions measurably better.'}</div>
  </div>`;
}

function NumbersTab({ p, v, stat }) {
  const pr = p.proj;
  const ba = (b, a) => (isNum(b) || isNum(a) ? `${F.odds(b)} / ${F.odds(a)}` : '—');
  const best = (c, ven) => (isNum(c) ? html`${F.odds(c, 1)} <span class="muted small">${VENUE[ven] || ''}</span>` : html`<span class="muted small">not sold</span>`);
  return html`<div>
    <div class="tablewrap"><table class="t"><thead><tr><th>Line</th><th>Market</th><th class="r">Fair over</th><th class="r">Model alone</th><th class="r">Mid</th><th class="r">PM US bid / ask</th><th class="r">Kalshi bid / ask</th><th>Over: best all-in</th><th>Under: best all-in</th><th class="r">Edge O</th><th class="r">Edge U</th></tr></thead>
      <tbody>${v.rungs.map((m) => html`<tr><td>${m.line}</td><td>${m.raw}+</td><td class="r">${F.pct(m.fair, 1)}</td><td class="r">${F.pct(m.model, 1)}</td>
        <td class="r">${F.pct(m.mid, 1)}</td><td class="r small">${ba(m.usb, m.usa)}</td><td class="r small">${ba(m.kb, m.ka)}</td><td>${best(m.cost_o, m.ov)}</td><td>${best(m.cost_u, m.uv)}</td>
        <td class="r">${F.edge(m.edge_o, m.fair)}</td><td class="r">${F.edge(m.edge_u, isNum(m.fair) ? 1 - m.fair : null)}</td></tr>`)}</tbody></table></div>
    <div class="card pad" style="margin-top:12px"><div class="kv">
      <span class="k">Mean ${STAT_WORD[stat]} (model)</span><span>${stat === 'pts' ? `${pr.mu_raw} · calibrated mean ${pr.mean}` : (isNum(v.mean) ? v.mean.toFixed(2) : '—')}</span>
      ${stat === 'pts' && html`<span class="k">Dispersion (negative binomial r)</span><span>${pr.nb_r}</span>`}
      <span class="k">Chance he plays</span><span>${F.pct(pr.play, 1)} (${pr.status_text})</span>
      <span class="k">Features as of</span><span>${pr.as_of ? `${F.dayET(pr.as_of)} ${F.timeET(pr.as_of)} ET` : '—'}</span>
      <span class="k">Injury report used</span><span>${pr.report_ts ? `${F.dayET(pr.report_ts)} ${F.timeET(pr.report_ts)} ET` : 'none yet'}</span>
    </div></div>
    <div class="tiny muted" style="margin-top:6px">All-in = the ask plus that venue's taker fee. Fair over anchors on a real two-sided book; with none, only the model's own chance is shown. Picks need a verified order book with at least $10 behind the price.</div>
  </div>`;
}

// ===================================================================================== Combos page + builder
function CombosPage({ d, preset }) {
  return html`<main class="page">
    <${Hero} d=${d} kicker="Parlays" title="Combos" sub="The model's suggested combos, and a builder to check any combo against the price the app quotes."/>
    <section class="section" style="margin-top:8px"><div class="section-head"><h2>Your style</h2>
      <span class="lede">Consistent players, Overs and Unders: 5–7 legs from 1–3 games paying 4–7× (3–6× profit), or safer 2–4 legs from 1–2 games paying 3–5× (2–4× profit). Every combination scored and ranked</span></div>
      <${YourStyle} d=${d}/></section>
    <section class="section"><div class="section-head"><h2>Model combos</h2><span class="lede">2–5 legs from tonight's picks</span></div><${CombosBlock} d=${d}/><${Combos2} d=${d}/>
      <div style="margin-top:12px"><${Info} title="How these combos are built">
        <ul style="margin:6px 0 0;padding-left:18px">
          <li>Only legs that cleared the single-line bar. A combo of no-value legs has no value, and the margin compounds with every leg.</li>
          <li>One leg per player and at most two per game. Most combos spread across games, so one blowout or a surprise scratch can't sink every leg at once.</li>
          <li>Same-game pairs are allowed only when the two outcomes don't work against each other (teammates share shots; a fast game lifts everyone).</li>
          <li><b>Strongest</b> ranks 2–3-leg combos by long-run bankroll growth (value and hit chance together). <b>Big upside</b> needs at least a 4× payout and a 12%+ chance, ranked by expected profit.</li>
          <li>Fewer legs is better: every leg adds the market's margin and the combo fee (about 4% of the price on a coin flip, more on long shots). Sportsbooks keep ~18% of parlay money versus ~5% on single bets.</li>
          <li>Prices are estimates (the product of the leg prices plus the combo fee). The app quotes its own combo price, so check it below before you buy.</li>
          <li>If a player doesn't take part, that leg settles at its last fair price, so the payout shrinks but the combo isn't voided. Any losing leg pays $0.</li>
        </ul></${Info}></div>
    </section>
    <section class="section"><div class="section-head"><h2>Build your own</h2><span class="lede">Pick legs, type the app's quote, and see if it's fair</span></div>
      <${Builder} d=${d} preset=${preset}/></section>
  </main>`;
}

function Builder({ d, preset }) {
  const parse = (s) => (s || '').split(',').filter(Boolean).map((x) => { const [m, side] = x.split('.'); return { m, side }; }).filter((x) => d.marketById[x.m]);
  const [legs, setLegs] = useState(parse(preset));
  const [q, setQ] = useState('');
  const [quote, setQuote] = useState('');
  useEffect(() => setLegs(parse(preset)), [preset]);
  const add = (m, side) => setLegs((L) => (L.some((x) => x.m === m.id) ? L.map((x) => (x.m === m.id ? { m: m.id, side } : x)) : [...L, { m: m.id, side }]));
  const del = (id) => setLegs((L) => L.filter((x) => x.m !== id));
  const found = q.length < 2 ? [] : (d.markets || []).filter((m) => (d.players[`${m.g}:${m.p}`]?.name || '').toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const info = legs.map(({ m, side }) => {
    const mk = d.marketById[m];
    const p = d.players[`${mk.g}:${mk.p}`] || {};
    return { m, side, mk, p, fair: side === 'over' ? mk.fair : 1 - mk.fair, price: side === 'over' ? mk.ask : isNum(mk.bid) ? 1 - mk.bid : null };
  });
  const res = useMemo(() => {
    if (info.length < 2 || info.some((x) => !isNum(x.fair))) return null;
    return comboProb(info.map((x) => ({ p: x.fair, side: x.side, g: x.mk.g, pid: x.mk.p, team: x.p.team, min: x.p.proj?.min ?? 25 })), d.corr);
  }, [JSON.stringify(legs)]);
  const product = info.length && info.every((x) => isNum(x.price)) ? info.reduce((a, x) => a * x.price, 1) : null;
  const typed = F.parseOdds(quote);
  const priceUsed = quote !== '' && isNum(typed) ? typed : product;
  const fee = isNum(priceUsed) ? comboFee(priceUsed, d.settings?.theta, d.settings?.combo_extra) : null;
  const cost = isNum(priceUsed) ? priceUsed + fee : null;
  const ev = res && isNum(cost) ? res.p / cost - 1 : null;
  const contradictions = [];
  for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
    const a = info[i], b = info[j];
    if (a.mk.p === b.mk.p && a.mk.g === b.mk.g && a.side !== b.side) {
      const lo = a.side === 'over' ? a.mk.line : b.mk.line, hi = a.side === 'over' ? b.mk.line : a.mk.line;
      if (lo >= hi) contradictions.push(`${a.p.name}: Over ${lo} and Under ${hi} can't both win.`);
    }
  }
  return html`<div class="grid g2" style="align-items:start">
    <div class="card pad">
      <div style="font-weight:650;margin-bottom:8px">1 · Add legs</div>
      <input class="input" style="width:100%" placeholder="Search a player (e.g. Tatum)" value=${q} onInput=${(e) => setQ(e.target.value)}/>
      ${found.length > 0 && html`<div class="picker-list" style="margin-top:8px">${found.map((m) => {
        const p = d.players[`${m.g}:${m.p}`] || {};
        const on = legs.find((x) => x.m === m.id);
        return html`<div class="picker-row"><div><b>${p.name}</b> <span class="muted small">${m.raw}+ · ${d.tri(p.team)}</span><div class="tiny muted">fair over ${F.pct(m.fair)} · ask ${F.odds(m.ask)} / bid ${F.odds(m.bid)}</div></div>
          <button class=${`sidebtn over ${on?.side === 'over' ? 'on' : ''}`} onClick=${() => add(m, 'over')}>Over ${m.line}</button>
          <button class=${`sidebtn under ${on?.side === 'under' ? 'on' : ''}`} onClick=${() => add(m, 'under')}>Under ${m.line}</button></div>`;
      })}</div>`}
      ${q.length >= 2 && !found.length && html`<div class="small muted" style="margin-top:8px">No player matches “${q}” on tonight's slate.</div>`}
      <div style="font-weight:650;margin:16px 0 8px">Your legs</div>
      ${info.length ? html`<div class="legs">${info.map((x) => html`<div class="leg"><div><div class="who">${x.p.name} <span class=${x.side}>${F.SIDE_UP(x.side)} ${x.mk.line}</span></div>
          <div class="what">fair ${F.pct(x.fair)} · price ${F.price(x.price)}</div></div>
          <button class="sidebtn" onClick=${() => del(x.m)} title="Remove">✕</button></div>`)}</div>`
        : html`<div class="small muted">No legs yet. Search above, or open a suggested combo.</div>`}
    </div>
    <div class="card pad">
      <div style="font-weight:650;margin-bottom:8px">2 · What does the app charge?</div>
      <div class="row wrap"><input class="input" style="width:150px" inputmode="text" placeholder=${isNum(product) ? (F.oddsMode() === 'us' ? F.american(product) : `${(100 * product).toFixed(1)}%`) : 'e.g. +450 or 18%'} value=${quote} onInput=${(e) => setQuote(e.target.value)}/>
        <span class="small ink2">${quote !== '' && isNum(typed) ? `= ${F.pct(typed, 1)} · ${F.american(typed)}` : quote !== '' ? 'type US odds (+450) or a chance (18%)' : isNum(product) ? 'US odds or %; empty = the legs multiplied' : 'US odds (+450) or a chance (18%)'}</span></div>
      <div style="font-weight:650;margin:18px 0 8px">3 · The verdict</div>
      ${contradictions.map((c) => html`<div class="note warn" style="margin-bottom:8px">${c}</div>`)}
      ${!res ? html`<div class="small muted">Add at least two legs.</div>` : html`<div>
        <div class="combo-stats">
          <div class="bigstat"><div class="k">Chance all hit</div><div class="v">${F.pct(res.p, 1)}</div></div>
          <div class="bigstat"><div class="k">If independent</div><div class="v">${F.pct(res.naive, 1)}</div></div>
          <div class="bigstat"><div class="k">Price implies</div><div class="v">${F.pct(priceUsed, 1)}</div></div>
        </div>
        <div class=${`note ${isNum(ev) && ev < 0 ? 'warn' : ''}`} style="margin-top:10px">${isNum(ev)
          ? html`With the combo fee the all-in price is <b>${F.odds(cost, 1)}</b>. If the fair chances are right, every $1 staked returns <b class=${ev >= 0 ? 'good' : 'bad'}>${F.signedPct(ev, 0)}</b> on average. ${ev >= 0 ? 'The price looks generous.' : 'The price is worse than our estimate.'}`
          : 'Enter the price to see the value.'}</div>
        <div class="small muted" style="margin-top:8px">Assumes every player plays. If one sits, Polymarket US settles that leg at its last fair price, so the payout shrinks. Correlation within a game comes from past games; ±${F.pct(res.se, 1)} simulation error.</div>
      </div>`}
    </div></div>`;
}

// ===================================================================================== Track record
const RESULT_LABEL = { win: 'Won', loss: 'Lost', void: 'Void · DNP', live: 'In play', grading: 'Grading', locked: 'Locked' };
const units = (u) => (isNum(u) ? `${u >= 0 ? '+' : '−'}${Math.abs(u).toFixed(2)}u` : '—');
const wl = (s) => `${s?.wins ?? 0}–${s?.losses ?? 0}`;
const todayET = () => F.dateKeyET(new Date().toISOString());

function pickStatus(pk, g) {
  if (pk.result) return pk.result;
  if (g?.status === 2) return 'live';
  if (g?.status === 3) return 'grading';
  return 'locked';
}

function ResultChip({ pk, g }) {
  const st = pickStatus(pk, g);
  return html`<span class=${`result ${st}`}>${st === 'live' && html`<i class="pulse"></i>`}${RESULT_LABEL[st]}</span>`;
}

// points scored (or so far) against the line: the fill turns green when the pick is winning
function PtsBar({ pk, g }) {
  const pts = pk.result ? pk.pts : pk.live_pts;
  if (!isNum(pts)) return html`<span class="muted small">${g?.status === 1 || !g ? `tips ${F.timeET(g?.tip)}` : '—'}</span>`;
  const max = Math.max(pk.line * 1.6, pts + 2, 10);
  const winning = pk.side === 'over' ? pts > pk.line : pts < pk.line;
  return html`<div class="ptsbar" title=${`${pts} pts${pk.live_min != null ? ` in ${pk.live_min} min` : ''} · line ${pk.line}`}>
    <div class="ptsnum"><b>${pts}</b> pts${!pk.result && isNum(pk.live_min) ? html` <span class="muted">· ${pk.live_min}m</span>` : ''}</div>
    <div class="ptstrack"><i class=${winning ? 'win' : 'lose'} style=${`width:${Math.min(100, (100 * pts) / max)}%`}></i>
      <b style=${`left:${(100 * pk.line) / max}%`}></b></div></div>`;
}

function GameStatus({ g }) {
  if (!g) return null;
  if (g.status === 3 && g.score) return html`<span class="gstat final">Final ${g.score[0]}–${g.score[1]}</span>`;
  if (g.status === 2) return html`<span class="gstat live"><i class="pulse"></i>${g.status_text || 'In play'}${g.score ? ` · ${g.score[0]}–${g.score[1]}` : ''}</span>`;
  return html`<span class="gstat">Tips ${F.timeET(g.tip)}</span>`;
}

function PickRow({ pk, g }) {
  const st = pickStatus(pk, g);
  const pnl = isNum(pk.pnl) && !pk.nf ? pk.pnl * 10 : null;
  return html`<div class=${`prow ${st}${pk.nf ? ' nf' : ''}`}>
    <div class="pr-who"><b>${pk.name}</b> <span class="muted small">${pk.team}</span>${pk.st === 'testing' && html` <${FamilyBadge} st="testing"/>`}${pk.st === 'lead90' && html` <span class="chip ghost" title="Frozen 90 minutes before tip, before the 20-minute lock and before market gates existed; kept separate">90-min lock</span>`}${pk.nf && html` <span class="chip ghost" title=${`${pk.nf}. Shown for the record, left out of wins, losses and ROI.`}>Not counted</span>`}</div>
    <div class="pr-bet"><span class=${pk.side}>${F.sideWord(pk.side)} ${pk.line}</span><span class="tiny muted"> · ${pk.side === 'over' ? 'Yes' : 'No'} on ${pk.raw}+</span>
      <span class="tiny muted" title=${pk.venue_known ? '' : 'Before Oct 24 the venue was not recorded; Polymarket US props only sell the Over, so Unders were Kalshi-only'}> · ${VENUE[pk.venue] || ''}${pk.venue_known ? '' : '*'}</span></div>
    <div class="pr-str"><${Meter} n=${pk.strength}/></div>
    <div class="pr-num" title="Fair chance at lock"><span class="k">Fair</span>${F.pct(pk.p)}</div>
    <div class="pr-num" title=${`Price at lock ${F.odds(pk.price)}; closing midpoint ${F.odds(pk.close)}`}><span class="k">Price → close</span>${(() => {
      const one = (p) => (F.oddsMode() === 'us' ? F.american(p) : F.pct(p));
      const cls = pk.clv > 0.0005 ? 'good' : pk.clv < -0.0005 ? 'bad' : 'muted';
      return html`${one(pk.price)}${isNum(pk.close) ? html` <span class=${cls}>→ ${one(pk.close)}</span>` : ''}${F.oddsMode() === 'both'
        ? html`<div class="tiny muted">${F.american(pk.price)}${isNum(pk.close) ? ` → ${F.american(pk.close)}` : ''}</div>` : ''}`;
    })()}</div>
    <div class="pr-num"><span class="k">Locked</span>${F.timeET(pk.locked)}</div>
    <div class="pr-res"><${PtsBar} pk=${pk} g=${g}/><${ResultChip} pk=${pk} g=${g}/></div>
    <div class="pr-pnl"><span class="k">$10 →</span>${isNum(pnl) ? html`<b class=${pnl > 0 ? 'good' : pnl < 0 ? 'bad' : 'muted'}>${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}</b>` : html`<span class="muted">—</span>`}</div>
  </div>`;
}

const PickHeader = () => html`<div class="prow phead"><div>Player</div><div>Bet</div><div>Str.</div><div class="pr-num">Fair</div>
  <div class="pr-num">Price → close</div><div class="pr-num">Locked</div><div class="pr-res">Points vs line · result</div><div class="pr-pnl">$10 bet</div></div>`;

function DayHead({ day, view }) {
  const s = day.stats || {};
  const b = day.best || {};
  const live = (day.picks || []).filter((p) => !p.result && day.games.find((g) => g.id === p.g)?.status === 2).length;
  return html`<div class="dayhead">
    <div><div class="dh-date">${F.longDayET(`${day.date}T17:00:00Z`)}</div>
      <div class="tiny muted">${day.picks.length} picks · ${day.combos.length} combos${day.lines ? ` · ${day.lines.logged} lines logged` : ''}</div></div>
    <span class="spacer"></span>
    ${view !== 'combos' ? html`<div class="dh-chips">
      <span class="chip ghost" title="Wins–losses (graded picks)">${wl(view === 'best' ? b : s)}</span>
      ${isNum((view === 'best' ? b : s).units) && html`<span class=${`chip ${(view === 'best' ? b : s).units >= 0 ? 'good' : 'bad'}`}>${units((view === 'best' ? b : s).units)}</span>`}
      ${live > 0 && html`<span class="chip over"><i class="pulse"></i>${live} in play</span>`}
      ${(s.pending || 0) - live > 0 && html`<span class="chip">${s.pending - live} pending</span>`}
    </div>` : null}
  </div>`;
}

function ComboRow({ c, games }) {
  const g = (id) => games.find((x) => x.id === id);
  const st = c.result || (c.legs.some((l) => g(l.g)?.status === 2) ? 'live' : 'locked');
  return html`<div class="crow">
    <div class="cr-head"><span class=${`chip ${c.section === 'upside' ? 'under' : 'good'}`}>${c.section === 'upside' ? 'Big upside' : 'Strongest'} #${c.rank}</span>
      <span class="small ink2">${F.pct(c.p)} to hit · pays ${F.x1(c.payout)} · locked ${F.timeET(c.locked)}</span><span class="spacer"></span>
      <span class=${`result ${st}`}>${st === 'live' && html`<i class="pulse"></i>`}${RESULT_LABEL[st]}</span></div>
    <div class="cr-legs">${c.legs.map((l) => html`<span class=${`legchip ${l.result || (g(l.g)?.status === 2 ? 'live' : '')}`}>
      <i>${l.result === 'win' ? '✓' : l.result === 'loss' ? '✕' : l.result === 'void' ? '–' : '•'}</i>${l.name} <b class=${l.side}>${F.sideWord(l.side)} ${l.line}</b></span>`)}</div>
  </div>`;
}

function DayCard({ day, view, filter, q, side = 'all', open, onToggle }) {
  const ql = q.toLowerCase();
  let picks = day.picks;
  if (side !== 'all') picks = picks.filter((p) => p.side === side);
  if (view === 'best') picks = picks.filter((p) => p.strength >= 5);
  if (filter !== 'all') picks = picks.filter((p) => (filter === 'pending' ? !p.result : p.result === filter));
  if (ql) picks = picks.filter((p) => p.name.toLowerCase().includes(ql));
  let combos = day.combos;
  if (filter !== 'all') combos = combos.filter((c) => (filter === 'pending' ? !c.result : c.result === filter));
  if (ql) combos = combos.filter((c) => c.legs.some((l) => l.name.toLowerCase().includes(ql)));
  const empty = view === 'combos' ? !combos.length : !picks.length;
  if (empty && (filter !== 'all' || ql || side !== 'all')) return null;
  return html`<section class="card daycard">
    <div class="dc-top" onClick=${onToggle}><${DayHead} day=${day} view=${view}/>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style=${`transform:rotate(${open ? 180 : 0}deg);transition:transform .15s;flex:none`}><path d="M6 9l6 6 6-6"/></svg></div>
    ${open && (view === 'combos'
      ? html`<div class="dc-body">${combos.length ? combos.map((c) => html`<${ComboRow} c=${c} games=${day.games}/>`) : html`<div class="small muted" style="padding:12px 16px">No combos this day.</div>`}</div>`
      : html`<div class="dc-body"><${PickHeader}/>${day.games.map((g) => {
          const rows = picks.filter((p) => p.g === g.id);
          if (!rows.length) return null;
          const gs = day.stats && rows.filter((p) => p.result === 'win' && !p.nf).length;
          return html`<div class="dc-game">
            <div class="dg-head"><${TeamChip} tri=${g.away}/><span class="muted">@</span><${TeamChip} tri=${g.home}/>
              <span class="small ink2 hide-sm">${F.timeET(g.tip)}</span><span class="spacer"></span><${GameStatus} g=${g}/>
              <span class="small muted">${gs}–${rows.filter((p) => p.result === 'loss' && !p.nf).length}</span></div>
            ${rows.map((pk) => html`<${PickRow} pk=${pk} g=${g}/>`)}</div>`;
        })}</div>`)}
  </section>`;
}

function SumTile({ k, v, s, tone }) {
  return html`<div class="card pad sumtile"><div class="up muted">${k}</div><div class=${`display sv ${tone || ''}`}>${v}</div><div class="small ink2">${s}</div></div>`;
}

function LiveRecord({ d }) {
  const rec = d.record || {};
  const S = rec.summary || {};
  const days = rec.days || [];
  const [view, setView] = useState(store.get('rec-view', 'picks'));
  const [filter, setFilter] = useState('all');
  const [side, setSide] = useState('all');
  const [q, setQ] = useState('');
  const [openMap, setOpenMap] = useState({});
  useEffect(() => store.set('rec-view', view), [view]);
  const a = S.lock_now || S.all || {}, o = S.lead90 || {};
  if (!days.length) return html`<${Empty} title="No picks logged yet">Picks are frozen ${LEAD} minutes before each tip-off and show up here right away.</${Empty}>`;
  return html`<div>
    <div class="grid g4">
      <${SumTile} k=${`At the ${LEAD}-minute lock`} v=${wl(a)} tone=${isNum(a.units) ? (a.units >= 0 ? 'good' : 'bad') : ''}
        s=${a.n ? `${units(a.units)} · ${F.signedPct(a.roi)} per bet · hit ${F.pct(a.hit_rate)} vs ${F.pct(a.predicted)} predicted · n=${a.n}${a.pending ? ` · ${a.pending} pending` : ''}` : `${a.pending || 0} pending, results tonight`}/>
      <${SumTile} k="Earlier: 90-minute lock (Oct 22–23)" v=${wl(o)} tone=""
        s=${o.n ? `${units(o.units)} · ${F.signedPct(o.roi)} per bet · n=${o.n} · a different lock time, kept separate` : 'none'}/>
      <${SumTile} k="Placeable on Polymarket US" v=${wl(S.us)} tone=${isNum(S.us?.units) ? (S.us.units >= 0 ? 'good' : 'bad') : ''}
        s=${`Overs only (its player props don't sell the Under)${S.us?.n ? ` · ${units(S.us.units)}` : ''} · Unders are Kalshi picks`}/>
      <${SumTile} k="Combos" v=${`${wl(S.strongest)} · ${wl(S.upside)}`} s="Strongest · Big upside (estimated prices)"/>
    </div>
    <div class="toolbar" style="margin-top:16px">
      <${Seg} value=${view === 'best' ? 'picks' : view} onChange=${setView} options=${[['picks', 'Picks'], ['combos', 'Combos'], ['lines', 'Every line']]}/>
      ${view !== 'lines' && html`<${Seg} value=${filter} onChange=${setFilter} options=${[['all', 'All'], ['win', 'Won'], ['loss', 'Lost'], ['pending', 'Pending']]}/>`}
      ${view !== 'lines' && view !== 'combos' && html`<${Seg} value=${side} onChange=${setSide} options=${[['all', 'All sides'], ['over', 'Overs'], ['under', 'Unders']]}/>`}
      ${view !== 'lines' && html`<input class="input" placeholder="Search a player" value=${q} onInput=${(e) => setQ(e.target.value)} style="width:190px"/>`}
    </div>
    ${view === 'lines' ? html`<${LinesView} d=${d}/>` : html`<div class="days">${days.map((day, i) => html`<${DayCard} key=${day.date} day=${day} view=${view} filter=${filter} q=${q} side=${side}
        open=${openMap[day.date] ?? (i < 2 || filter !== 'all' || q !== '' || side !== 'all')} onToggle=${() => setOpenMap({ ...openMap, [day.date]: !(openMap[day.date] ?? (i < 2 || filter !== 'all' || q !== '' || side !== 'all')) })}/>`)}</div>`}
  </div>`;
}

function LinesView({ d }) {
  const L = d.record?.summary?.lines;
  const cal = (L?.calibration || []).map((r) => ({ p: r.p, h: r.h, n: r.n }));
  return html`<div class="grid g2" style="align-items:start">
    <div class="card chartcard"><h3>Every prediction, not just the picks</h3>
      <p class="cap">All ${L?.logged?.toLocaleString() || 0} lines frozen at lock time, grouped by the fair chance of the Over, against how often the Over hit (${L?.graded?.toLocaleString() || 0} graded so far).</p>
      ${cal.length ? html`<${C.Reliability} rows=${cal} xLabel="Fair chance of the Over" yLabel="Over hit"/>` : html`<div class="small muted" style="padding:20px 0">Fills in as tonight's games finish.</div>`}</div>
    <div class="card pad"><h3 style="margin-top:0;font-size:15px">Lines logged per day</h3>
      <table class="t"><thead><tr><th>Day</th><th class="r">Lines</th><th class="r">Graded</th><th class="r">Picks</th></tr></thead>
        <tbody>${(d.record?.days || []).map((x) => html`<tr><td>${F.shortDate(x.date)}</td><td class="r">${x.lines?.logged ?? '—'}</td><td class="r">${x.lines?.graded ?? '—'}</td><td class="r">${x.picks.length}</td></tr>`)}</tbody></table>
      <p class="small ink2" style="margin-bottom:0">Dots on the diagonal mean the percentages are honest across the whole board, not just on the lines we pick.
        The full searchable list is at the bottom: <a href="javascript:void 0" onClick=${() => document.getElementById('archive')?.scrollIntoView({ behavior: 'smooth' })}>Every line, ever ↓</a></p></div>
  </div>`;
}

// ===================================================================================== Archive: every line ever logged
// Monthly files (data/archive/lines-YYYY-MM.json) load only when this section is on screen, never with latest.json.
const ARCHIVE = 'data/archive/';
const ARCH_RESULT = { over: 'Over hit', under: 'Under hit', void: 'DNP' };
const MKT = { pts: ['Points', 'pts'], reb: ['Rebounds', 'reb'], ast: ['Assists', 'ast'], fg3m: ['Threes', '3PM'], pra: ['Pts+Reb+Ast', 'PRA'],
  stl: ['Steals', 'stl'], blk: ['Blocks', 'blk'] };
const archPick = (r) => (!r.pick || !r.result ? null : r.result === 'void' ? 'void' : r.result === r.pick ? 'win' : 'loss');

function useArchive(month) {
  const [idx, setIdx] = useState(null);
  const [files, setFiles] = useState({});
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch(`${ARCHIVE}index.json?m=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setIdx).catch((e) => setError(String(e)));
  }, []);
  const want = !idx ? [] : (month === 'all' ? idx.months : idx.months.filter((m) => m.month === (month || idx.months[0]?.month)));
  useEffect(() => {
    want.filter((m) => !files[m.file]).forEach((m) => {
      fetch(`${ARCHIVE}${m.file}?v=${encodeURIComponent(idx.updated)}`)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((j) => setFiles((f) => ({ ...f, [m.file]: j.rows.map((row) => Object.fromEntries(j.cols.map((c, i) => [c, row[i]]))) })))
        .catch((e) => setError(String(e)));
    });
  }, [idx, month]);
  const loading = want.some((m) => !files[m.file]);
  const rows = useMemo(() => (loading ? [] : want.flatMap((m) => files[m.file])), [files, idx, month, loading]);
  return { idx, rows, loading, error };
}

function archiveCsv(rows, name) {
  const cols = ['date', 'tip', 'away', 'home', 'player', 'team', 'mkt', 'line', 'raw', 'fair', 'model', 'mid', 'bid', 'ask', 'lean', 'edge',
    'pick', 'strength', 'price', 'result', 'pts', 'locked', 'rec'];
  const head = ['date_et', 'tip_utc', 'away', 'home', 'player', 'team', 'stat', 'line', 'market', 'fair_over', 'model_over', 'mid', 'bid', 'ask',
    'value_side', 'value_edge', 'pick', 'strength', 'pick_price', 'result', 'actual', 'locked_utc', 'reconstructed'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [head.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'raw' && r.raw != null ? `${r.raw}+` : r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function ArchiveRow({ r }) {
  const ps = archPick(r);
  const px = isNum(r.mid) ? r.mid : r.ask;
  const value = r.lean && isNum(r.edge) ? html`<span class=${r.lean}>${F.sideWord(r.lean)}</span> <span class=${`tiny ${r.edge >= 0 ? 'good' : 'muted'}`}>${F.edge(r.edge, isNum(r.fair) ? (r.lean === 'over' ? r.fair : 1 - r.fair) : null)}</span>` : html`<span class="muted">—</span>`;
  return html`<tr class=${ps || ''}>
    <td class="hide-sm"><span class="muted">${F.timeET(r.tip)}</span></td>
    <td class="small a-wide">${r.away} @ ${r.home}</td>
    <td class="a-player"><b>${r.player}</b> <span class="muted small">${r.team}</span>${r.mkt && r.mkt !== 'pts' ? html` <span class="chip ghost">${(MKT[r.mkt] || [r.mkt])[0]}</span>` : ''}</td>
    <td class="r a-line"><b>${r.line}</b> <span class="tiny muted">${r.raw}+</span></td>
    <td class="r a-wide">${F.pct(r.fair)}</td>
    <td class="r a-wide">${F.odds(px)}${isNum(r.bid) && isNum(r.ask) ? html` <span class="tiny muted">${F.oddsMode() === 'us' ? `${F.american(r.bid)} / ${F.american(r.ask)}` : `${F.pct(r.bid)}–${F.pct(r.ask)}`}</span>` : ''}</td>
    <td class="a-wide">${value}</td>
    <td class="a-pick">${r.pick ? html`<span class=${`chip ${r.pick}`}>${F.sideWord(r.pick)}</span> <${Meter} n=${r.strength}/>` : html`<span class="muted">—</span>`}</td>
    <td class="a-res">${r.result ? html`${isNum(r.pts) ? html`<b>${r.pts}</b> <span class="muted small">${(MKT[r.mkt || 'pts'] || ['', r.mkt])[1]}</span> ` : ''}<span class=${`chip ${r.result === 'void' ? 'ghost' : r.result}`}>${ARCH_RESULT[r.result]}</span>${ps ? html` <span class=${`result ${ps}`}>${RESULT_LABEL[ps]}</span>` : ''}`
      : html`<span class="muted small">Pending</span>`}</td>
    <td class="hide-sm small muted">${F.timeET(r.locked)}${r.rec ? html` <span class="chip ghost" title="Rebuilt after the fact from the frozen pre-game prediction and the last price before lock (this day was not logged live)">rebuilt</span>` : ''}</td>
    <td class="a-meta tiny ink2">${r.away} @ ${r.home} · fair ${F.pct(r.fair)} · Over ${F.odds(px)} · value ${value}${r.rec ? ' · rebuilt' : ''}</td>
  </tr>`;
}

function Archive() {
  const [month, setMonth] = useState('');
  const [q, setQ] = useState('');
  const [day, setDay] = useState('');
  const [picksOnly, setPicksOnly] = useState(false);
  const [res, setRes] = useState('all');
  const [mkt, setMkt] = useState('');
  const [n, setN] = useState(100);
  const { idx, rows, loading, error } = useArchive(month);
  useEffect(() => setN(100), [month, q, day, picksOnly, res, mkt]);
  const mkts = useMemo(() => [...new Set(rows.map((r) => r.mkt || 'pts'))], [rows]);
  useEffect(() => setDay(''), [month]);
  const days = useMemo(() => [...new Set(rows.map((r) => r.date))], [rows]);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => (!day || r.date === day) && (!picksOnly || r.pick) && (!mkt || (r.mkt || 'pts') === mkt)
      && (!ql || r.player.toLowerCase().includes(ql) || r.team === ql.toUpperCase())
      && (res === 'all' || (res === 'pending' ? !r.result : res === 'win' || res === 'loss' ? archPick(r) === res : r.result === res)));
  }, [rows, q, day, picksOnly, res, mkt]);
  if (error && !idx) return html`<div class="note">The archive couldn't load (${error}). It's published with the next update.</div>`;
  if (!idx) return html`<div class="small muted">Loading the archive…</div>`;
  if (!idx.total) return html`<${Empty} title="No lines logged yet">Every line is frozen ${LEAD} minutes before tip-off and lands here.</${Empty}>`;
  const curMonth = month || idx.months[0]?.month;
  const resOpts = picksOnly ? [['all', 'All'], ['win', 'Won'], ['loss', 'Lost'], ['pending', 'Pending'], ['void', 'DNP']]
    : [['all', 'All'], ['over', 'Over hit'], ['under', 'Under hit'], ['pending', 'Pending'], ['void', 'DNP']];
  const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const page = shown.slice(0, n);
  const perDay = {};
  for (const r of shown) { const x = (perDay[r.date] ||= { n: 0, picks: 0 }); x.n += 1; if (r.pick) x.picks += 1; }
  return html`<div>
    <div class="toolbar">
      <input class="input" type="search" placeholder="Search a player or team (BOS)" value=${q} onInput=${(e) => setQ(e.target.value)} style="width:230px"/>
      <select class="input" value=${month || curMonth} onChange=${(e) => setMonth(e.target.value)} aria-label="Month">
        ${idx.months.map((m) => html`<option value=${m.month}>${monthName(m.month)} (${m.n.toLocaleString()})</option>`)}
        ${idx.months.length > 1 && html`<option value="all">All time (${idx.total.toLocaleString()})</option>`}
      </select>
      <select class="input" value=${day} onChange=${(e) => setDay(e.target.value)} aria-label="Day">
        <option value="">Every day</option>${days.map((x) => html`<option value=${x}>${F.longDayET(`${x}T17:00:00Z`)}</option>`)}
      </select>
      ${mkts.length > 1 && html`<select class="input" value=${mkt} onChange=${(e) => setMkt(e.target.value)} aria-label="Market">
        <option value="">Every market</option>${mkts.map((x) => html`<option value=${x}>${(MKT[x] || [x])[0]}</option>`)}</select>`}
      <${Switch} checked=${picksOnly} onChange=${(v) => { setPicksOnly(v); setRes('all'); }}>Model picks only</${Switch}>
    </div>
    <div class="toolbar">
      <${Seg} value=${res} onChange=${setRes} options=${resOpts}/>
      <span class="spacer"></span>
      <span class="small muted">${loading ? 'Loading…' : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} lines`}</span>
      <button class="btn ghost sm" disabled=${!shown.length} onClick=${() => archiveCsv(shown, `pick-and-roll-lines-${month === 'all' ? 'all' : curMonth}.csv`)}>Download CSV</button>
    </div>
    ${q.trim().length >= 2 && month !== 'all' && idx.months.length > 1 && html`<div class="note" style="margin-bottom:10px">Searching ${monthName(curMonth)} only.
      <button class="btn ghost sm" style="margin-left:6px" onClick=${() => setMonth('all')}>Search every month</button></div>`}
    ${loading ? html`<div class="small muted" style="padding:16px 0">Loading ${month === 'all' ? 'every month' : monthName(curMonth)}…</div>`
      : !shown.length ? html`<div class="note">No lines match.</div>`
      : html`<div class="tablewrap archive"><table class="t">
          <thead><tr><th class="hide-sm">Tip</th><th>Game</th><th>Player</th><th class="r">Line</th>
            <th class="r" title="Fair chance the player goes Over, frozen at lock">Fair (Over)</th>
            <th class="r" title="Price of the Over at lock: midpoint, then bid–ask">Price (Over)</th>
            <th title="The side whose fair chance beat its price by the most, after fees. Negative = neither side was worth it">Value side</th>
            <th>Model pick</th><th>Result</th><th class="hide-sm">Locked</th></tr></thead>
          <tbody>${page.map((r, i) => html`${(i === 0 || page[i - 1].date !== r.date) && html`<tr class="arch-day"><td colspan="10">
              <b>${F.longDayET(`${r.date}T17:00:00Z`)}</b><span class="muted small"> · ${perDay[r.date].n.toLocaleString()} lines · ${perDay[r.date].picks} pick${perDay[r.date].picks === 1 ? '' : 's'}</span></td></tr>`}
            <${ArchiveRow} r=${r}/>`)}</tbody></table></div>
        ${shown.length > n && html`<div style="text-align:center;margin-top:12px"><button class="btn ghost" onClick=${() => setN(n + 250)}>Show ${Math.min(250, shown.length - n)} more · ${(shown.length - n).toLocaleString()} left</button></div>`}`}
    <p class="small muted" style="margin-top:10px">Every line the model priced, frozen ${LEAD} minutes before tip-off (90 minutes before ${LEAD_CHANGED}) and kept for good. Over/Under hit comes from the official box score; DNP lines are void. "Rebuilt" lines come from a day before live logging started, recreated from that day's frozen predictions and prices.</p>
  </div>`;
}

function Record({ d }) {
  const t = d.trust || {};
  const pk = t.picks || {};
  const months = (pk.by_month || []).filter((r) => r.n > 0).map((r) => ({ label: new Date(`${r.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), v: r.roi, lo: r.roi_ci?.[0], hi: r.roi_ci?.[1], n: r.n }));
  const cal = (pk.calibration || []).map((r) => ({ p: r.predicted, h: r.hit_rate, n: r.n }));
  return html`<main class="page">
    <${Hero} d=${d} kicker="Accountability" title="Track record" sub=${`Every pick is frozen ${LEAD} minutes before tip-off (90 minutes before ${LEAD_CHANGED}), graded from the box score the moment the game ends, and never edited.`}/>
    <section class="section" style="margin-top:6px"><div class="section-head"><h2>Live record</h2><span class="lede">Every pick since the site went up, day by day</span>
      ${d.record?.updated && html`<span class="spacer"></span><span class="small muted">updated ${F.ago(d.record.updated)}</span>`}</div>
      <${LiveRecord} d=${d}/>
      ${d.record?.summary?.all?.unfillable > 0 && html`<div class="note" style="margin-top:10px">${d.record.summary.all.unfillable} early picks (Oct 23–25) are marked <b>Not counted</b>: their Polymarket US price was a placeholder quote with under $10 behind it, so nobody could actually have bought it. They stay on the list but are left out of wins, losses and ROI. Since Oct 25 every pick is priced from the real order book.</div>`}
    </section>
    <section class="section"><div class="section-head"><h2>Your-style combos</h2><span class="lede">5–7-leg combos built your way, frozen at lock and graded per main combo; strength = how many of its variations hit</span></div>
      <${StyleRecord} d=${d}/></section>
    <${FamilyRecord} d=${d}/>
    <section class="section"><div class="section-head"><h2>Backtest</h2><span class="lede">The exact same rule, replayed on real Kalshi prices</span></div>
      ${!t.visible ? html`<div class="note">${t.note || 'No backtest available.'}</div>` : html`<div>
        <div class="grid g3">
          <div class="card pad"><div class="up muted">Held out (Apr–Oct 2026)</div><div class="display" style="font-size:34px">${F.signedPct(pk.singles_holdout?.roi)}</div>
            <div class="small ink2">per bet, 95% CI ${F.signedPct(pk.singles_holdout?.roi_ci?.[0])} to ${F.signedPct(pk.singles_holdout?.roi_ci?.[1])} · n=${pk.singles_holdout?.n} · hit ${F.pct(pk.singles_holdout?.hit_rate, 1)} vs ${F.pct(pk.singles_holdout?.predicted, 1)} predicted</div></div>
          <div class="card pad"><div class="up muted">All months (Jan–Oct 2026)</div><div class="display" style="font-size:34px">${F.signedPct(pk.singles_all?.roi)}</div>
            <div class="small ink2">per bet, 95% CI ${F.signedPct(pk.singles_all?.roi_ci?.[0])} to ${F.signedPct(pk.singles_all?.roi_ci?.[1])} · n=${pk.singles_all?.n} · ${pk.picks_per_day?.toFixed(1)} picks a day</div></div>
          <div class="card pad"><div class="up muted">What we don't do</div><div class="display" style="font-size:34px;color:var(--bad)">${F.signedPct(pk.naive_disagreement?.roi)}</div>
            <div class="small ink2">Betting the model's biggest disagreements with the market: hit ${F.pct(pk.naive_disagreement?.hit_rate, 1)} vs ${F.pct(pk.naive_disagreement?.predicted, 1)} predicted (n=${pk.naive_disagreement?.n}).</div></div>
        </div>
        <div class="grid g2" style="margin-top:14px">
          <div class="card chartcard"><h3>Are the percentages honest?</h3><p class="cap">Picks grouped by their fair chance: predicted vs how often they won.</p><${C.Reliability} rows=${cal} xLabel="Fair chance" yLabel="Won"/></div>
          <div class="card chartcard"><h3>Return by month</h3><p class="cap">Per bet after fees, with 95% intervals. Small months swing a lot.</p><${C.BarsCI} rows=${months} fmt=${(v) => F.signedPct(v, 0)}/></div>
        </div>
        <div class="grid g2" style="margin-top:14px">
          ${['strongest', 'upside'].map((s) => { const c = pk.combos?.[s]; return c && html`<div class="card pad"><div class="up muted">${s === 'strongest' ? 'Strongest combos' : 'Big-upside combos'} · backtest</div>
            <div class="small ink2" style="margin-top:6px">hit ${F.pct(c.hit_rate, 1)} vs ${F.pct(c.predicted, 1)} predicted · <b>${F.signedPct(c.roi)}</b> per combo (95% CI ${F.signedPct(c.roi_ci?.[0])} to ${F.signedPct(c.roi_ci?.[1])}) · n=${c.n}${c.avg_payout ? ` · avg payout ${F.x1(c.avg_payout)}` : ''} ${c.flag ? `· ${c.flag}` : ''}</div>
            <div class="tiny muted" style="margin-top:4px">Combo prices estimated as the product of the legs' real prices plus the Polymarket US combo fee.</div></div>`; })}
        </div>
        ${pk.under_share > 0.6 && html`<div class="note" style="margin-top:14px">Why mostly Unders (${F.pct(pk.under_share)} of backtest picks)? Fans like betting Overs, so Over prices run a little rich${isNum(t.fair?.a) && t.fair.a < 0 ? ', which the fair-chance fit picks up' : ''}. On real prices the model's own view adds only a little beyond the market, so the bar is "fair chance beats the price", not "the model disagrees".${pk.naive_disagreement?.roi < 0 ? ' Betting the biggest model-vs-market gaps lost money in the backtest.' : ''}</div>`}
        ${t.kalshi && html`<div class="small muted" style="margin-top:10px">Model vs market on ${t.kalshi.n.toLocaleString()} past player-games (Kalshi): log loss ${t.kalshi.ll_model?.toFixed(3)} (model) vs ${t.kalshi.ll_market?.toFixed(3)} (market), lower is better. Backtest ${t.run_id}, leakage check passed for this code.</div>`}
      </div>`}
    </section>
    ${(t.mae || []).length > 0 && html`<section class="section"><div class="section-head"><h2>Projection accuracy</h2><span class="lede">Average miss in points, predictions made before each game</span></div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Season</th><th class="r">Model</th><th class="r">Season average</th><th class="r">Last-10 average</th><th class="r">Player-games</th></tr></thead>
        <tbody>${t.mae.map((r) => html`<tr><td>${r.season}</td><td class="r"><b>${r.model.toFixed(2)}</b></td><td class="r">${r.season_avg.toFixed(2)}</td><td class="r">${r.last10.toFixed(2)}</td><td class="r">${r.n.toLocaleString()}</td></tr>`)}</tbody></table></div></section>`}
    <section class="section" id="archive"><div class="section-head"><h2>Every line, ever</h2><span class="lede">The permanent list of every line the model has priced: search any player, day or result</span></div>
      <${Archive}/></section>
  </main>`;
}

// rebounds, assists, game lines...: each family's own record (Testing families never mix into the headline)
function FamilyRecord({ d }) {
  const fams = Object.entries(d.record?.families || {});
  const [open, setOpen] = useState(null);
  if (!fams.length) return null;
  return html`<section class="section"><div class="section-head"><h2>Other markets</h2><span class="lede">Rebounds, assists, threes, PRA, game lines… locked at the same time and graded the same way, each tracked on its own</span></div>
    <div class="tablewrap card"><table class="t"><thead><tr><th>Market</th><th>Status</th><th class="r">W–L</th><th class="r">Hit vs predicted</th><th class="r">Return per bet</th><th class="r">Pending</th><th class="r" title="Logged at a price that can't be shown to have been buyable">Not counted</th><th class="r" title=${`Picks at this lock time toward the ${d.settings?.live_rules?.promote_n || 300} needed to earn Live status from the live record`}>Toward Live</th></tr></thead>
      <tbody>${fams.map(([f, r]) => { const st = r.stats || {}; const fs = d.families?.[f]?.status || 'testing'; return html`
        <tr class="click" onClick=${() => setOpen(open === f ? null : f)}><td><b>${r.label}</b></td><td><${FamilyBadge} st=${fs}/></td>
          <td class="r">${st.wins ?? 0}–${st.losses ?? 0}</td><td class="r">${isNum(st.hit_rate) ? `${F.pct(st.hit_rate)} vs ${F.pct(st.predicted)}` : '—'}</td>
          <td class="r">${isNum(st.roi) ? F.signedPct(st.roi) : '—'}</td><td class="r">${st.pending ?? 0}</td><td class="r muted">${st.unfillable || '—'}</td>
          <td class="r small">${(() => { const lr = d.families?.[f]?.live_record; const need = d.settings?.live_rules?.promote_n || 300;
            return lr?.n ? html`${lr.n}/${need}${lr.promote ? html` <span class="good">✓</span>` : ''}` : '—'; })()}</td></tr>
        ${open === f && html`<tr><td colspan="8"><table class="t"><tbody>${(r.recent || []).map((x) => html`<tr class=${x.nf ? 'nf' : ''}>
          <td class="small muted">${F.dayET(x.tip)}</td><td>${x.what}</td><td class="r">fair ${F.pct(x.p)}</td><td class="r">${F.odds(x.cost)}</td>
          <td><${VenueChip} v=${x.venue}/></td><td>${x.result ? html`<span class=${`chip ${x.result === 'win' ? 'good' : x.result === 'loss' ? 'bad' : 'ghost'}`}>${RESULT_LABEL[x.result] || x.result}</span>` : html`<span class="chip ghost">Pending</span>`}${isNum(x.actual) ? html` <span class="small muted">${x.actual}</span>` : ''}${x.nf && html` <span class="chip ghost" title=${x.nf}>Not counted</span>`}</td></tr>`)}</tbody></table></td></tr>`}`; })}</tbody></table></div>
    <div class="small muted" style="margin-top:6px">These markets are in Testing until they pass the same pre-registered backtest as points, or earn Live from their own record: at least ${d.settings?.live_rules?.promote_n || 300} graded picks at this lock time with a positive return, a 95% return range whose floor is −3% or better, and an average closing-line value of zero or better. A Live market drops back after ${d.settings?.live_rules?.demote_n || 200} picks if that range falls below zero. Until then their record never counts toward the headline numbers above. <b>Not counted</b>: Polymarket US picks logged before Oct 25 evening, when order books weren't read yet. Quotes on these markets were often placeholders with almost nothing behind them, so those prices can't be shown to have been buyable. Kalshi picks are counted.</div></section>`;
}

// today's locked picks on the home page, so a pick never disappears when its game tips off
function LockedToday({ d }) {
  const [all, setAll] = useState(false);
  const day = (d.record?.days || []).find((x) => x.date === todayET());
  if (!day || !day.picks.length) return null;
  const best = day.picks.filter((p) => p.strength >= 5);
  const rows = all ? day.picks : best.length ? best : day.picks.slice(0, 8);
  const s = day.stats || {};
  return html`<section class="section">
    <div class="section-head"><h2>Locked in today</h2><span class="lede">Frozen ${LEAD} minutes before tip · graded live from the box score</span><span class="spacer"></span>
      <span class="chip ghost">${wl(s)}${isNum(s.units) ? ` · ${units(s.units)}` : ''}</span></div>
    <div class="card daycard"><div class="dc-body"><${PickHeader}/>
      ${day.games.map((g) => {
        const gr = rows.filter((p) => p.g === g.id);
        if (!gr.length) return null;
        return html`<div class="dc-game"><div class="dg-head"><${TeamChip} tri=${g.away}/><span class="muted">@</span><${TeamChip} tri=${g.home}/>
          <span class="spacer"></span><${GameStatus} g=${g}/></div>${gr.map((pk) => html`<${PickRow} pk=${pk} g=${g}/>`)}</div>`;
      })}
    </div></div>
    <div class="row" style="margin-top:10px">
      <button class="btn ghost sm" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${day.picks.length} locked picks`}</button>
      <a class="btn ghost sm" href="#/record">Full track record →</a></div>
  </section>`;
}

// ===================================================================================== How it works
const RESEARCH = [
  ['Our own backtest: betting the biggest disagreements loses',
    'On real Kalshi prices, betting where the model disagreed most with the market hit far less often than it predicted. Anchoring to the price, and betting only when the fair chance beats it, held up on months we never used to design the rule.',
    'the fair chance starts from the market price, and the bar is "beats the price after fees", not "disagrees most".', [['Track record', '#/record']]],
  ['Game lines are the sharpest market on the board',
    "Closing NBA spreads and totals absorb opening biases and injury news by tip-off. Closing lines miss the final margin by about 12–12.5 points; our game model misses by 14.2 (2025-26, out of time), better than a ratings baseline but not good enough.",
    'moneylines, spreads and totals are shown with fair prices, but stay information only (Testing) until the model clears its pre-registered target.',
    [['Dare, Dennis & Paul', 'https://ideas.repec.org/a/eee/finlet/v13y2015icp130-136.html'], ['Le (2026)', 'https://arxiv.org/html/2602.19520v1']]],
  ['Which props? Reputation says rebounds and assists, but nobody has proven it',
    "There's no peer-reviewed study of NBA prop efficiency; the 'props are softer' view comes from low limits and little sharp money. On real Kalshi prices the obvious shortcut fails: rebound/assist/three Overs were underpriced from November to March (in books 11–18 points wide) and Unders were favoured from April to June.",
    "every prop family gets its own model and has to pass the same backtest as points on months it never saw before its picks count. On complete Kalshi history (Oct 25), rebounds returned +6.7% per bet in the held-out months (95% CI −0.8% to +16.3%, n = 384) but lost 5.1% earlier. Assists returned +13.6% on only 117 bets (300 needed), and threes +1.2% (CI −5.4% to +6.8%). None clears the bar yet, so all stay in Testing.",
    [['Kalshi API', 'https://docs.kalshi.com/'], ['Track record', '#/record']]],
  ['Tested before trusted: what helps the rebound and assist models',
    "We tested three ideas on the same out-of-time folds: how each teammate's absence shifts a player's rebounds, assists and threes; threes as attempts × shooting percentage; and the opponent's own misses and turnovers. None moved the error by more than about 0.1%, so none was kept. Confirmed starting lineups did help: minutes error fell 3%, and points error and real-line log loss both improved.",
    "lineups switch on only after two weeks of lineups captured live before each lock confirm the archive (its starters match the box scores 100% of the time, which may mean it was finalized after tip). Until then they're collected, not used.",
    [['Track record', '#/record']]],
  ['A quoted price isn\'t always a price you can get',
    'Polymarket US often shows placeholder quotes on a fraction of a share in front of the real orders. Examples: 8% offered on 0.06 shares while real offers start at 26%, or 67/68% on top while $10 actually fills at 47/74%. Priced off those, a long list of rebounds and low points rungs looked like value nobody could buy.',
    'before a line can be a pick or a combo leg, its order books are read and each side is priced where $10 actually fills. Picks logged before this check at Polymarket US prices are shown on the record but not counted.',
    [['Polymarket US docs', 'https://docs.polymarket.us/'], ['Track record', '#/record']]],
  ['Picking 20 instead of 90 minutes before tip barely changes the market',
    'On Kalshi points books the market sharpens only slightly between 90 and 20 minutes before tip (log loss 0.5339 → 0.5305) while spreads tighten, and starting lineups are posted by 30 minutes out. Rebuilt at each lock time, the model held out +3% to +4% per bet everywhere, with intervals that include zero.',
    'picks lock 20 minutes before tip; the backtest for that exact lock time decides whether points count as Live.', [['Track record', '#/record']]],
  ['Where a bet can actually be placed',
    "Polymarket US player props only sell the Over (“N+”); Kalshi sells both sides as singles but accepts props in combos only as YES. So the model's Under picks are Kalshi-only singles, and a combo with a prop Under can't be placed anywhere.",
    "every pick names its cheapest placeable venue, Unders are labelled “not on Polymarket US”, and combos use only legs that can be combined on one venue.",
    [['Polymarket US docs', 'https://docs.polymarket.us/'], ['Kalshi API', 'https://docs.kalshi.com/']]],
  ['Long shots are overpriced, and NO tends to beat YES',
    'Studies of Kalshi trades find cheap contracts lose the most, while favorites priced above about 70–80% do slightly better than their price. Across price levels, NO beats YES more often than not.',
    'picks stay between a 25% and an 80% price (about +300 to −400), and when the numbers agree the model leans Under (buying No).',
    [['Bürgi, Deng & Whelan', 'https://www.karlwhelan.com/Papers/Kalshi.pdf'], ['Becker', 'https://www.jbecker.dev/research/prediction-market-microstructure']]],
  ['Parlays compound the house edge',
    "Illinois sportsbooks kept 18.3% of parlay money in 2025, versus about 5% on other bets. A 4.5% margin per leg grows to about 13% over three legs and 21% over five. A Kelly-sized parlay does no better than betting the legs one after another.",
    'combos only use legs with value and stay short (2–3 legs for Strongest, 5 at most). Always check the real quote.',
    [['Illinois data (InGame)', 'https://www.ingame.com/illinois-december-2025-sportsbook-revenue/'], ['Grant et al.', 'https://pubsonline.informs.org/doi/10.1287/deca.1080.0106'], ['Moshrefi (2026): Kalshi parlays overpriced', 'https://arxiv.org/abs/2607.14430'], ['Long (2026)', 'https://arxiv.org/abs/2603.26620']]],
  ["The optimizer's curse",
    'Pick the best-looking of many estimates and its edge is overstated on average. Shrinking estimates toward a sensible anchor fixes it, and betting off the market consensus has itself been shown to work.',
    'every probability is pulled toward the market price before anything is ranked.',
    [['Smith & Winkler', 'https://jimsmith.host.dartmouth.edu/wp-content/uploads/2022/04/The_Optimizers_Curse.pdf'], ['Baker & McHale', 'https://dl.acm.org/doi/abs/10.1287/deca.2013.0271']]],
  ['Bet small: fractional Kelly',
    'Half Kelly keeps about three quarters of the long-run growth and cuts the chance of ever halving your bankroll from 1 in 2 to 1 in 8. In NBA backtests, full Kelly went broke.',
    'suggested stakes are a quarter Kelly for singles and an eighth for combos, capped at 2% of a bankroll.',
    [['Thorp', 'https://gwern.net/doc/statistics/decision/2006-thorp.pdf'], ['Uhrín et al.', 'https://arxiv.org/abs/2107.08827']]],
  ['How Polymarket US combos work',
    "Combos are priced on request: market makers quote within a fraction of a second, then get a short 'last look'. A combo has 2–10 legs. The payout is the full amount times each leg's value; a leg whose player doesn't take part settles at its last fair price, and any losing leg pays $0.",
    "our combo price is only an estimate (the product of the leg prices plus the combo fee), so check the app's quote in the builder.",
    [['Combos FAQ', 'https://docs.polymarket.us/faqs/combos-faqs'], ['Fees', 'https://docs.polymarket.us/fees']]],
  ['What real bettors actually buy',
    "We pulled every public Kalshi trade placed before tip-off on 3,000 player-points markets (Jan–Mar 2026): 93% of the contracts people bought were Overs, and most markets saw no Under buying at all. Knowing that flow didn't improve predictions beyond the price, because the price already reflects it.",
    "we use the overs bias through the fair chance rather than following or fading the crowd directly. Screenshots of slips posted online wouldn't help either: people mostly post winners.",
    [['Kalshi public trades API', 'https://docs.kalshi.com/']]],
  ['Blowouts kill overs',
    'Across about 40,000 NBA props, overs hit 46.7% in games decided by 7 points or fewer, but 40.9% in 20-point blowouts, because starters sit late.',
    "blowout risk is a model input, and combos spread across games so one blowout can't sink every leg.",
    [['DataStreak', 'https://datastreak.com/insights/nba-blowouts-4th-quarter-props']]],
  ['Closing line value is the honest scoreboard',
    'In large samples, beating the closing price predicts long-run results almost one for one (it is noisier for props).',
    `every pick is logged ${LEAD} minutes before tip so its price can be compared with the close.`,
    [['football-data.co.uk', 'https://football-data.co.uk/blog/pinnacle_efficiency.php']]],
];
function How({ d }) {
  const fp = d.trust?.fair;
  return html`<main class="page">
    <${Hero} d=${d} kicker="The method" title="How it works" sub="What the numbers mean, how picks and combos are chosen, and how much to trust them."/>
    <div class="grid g2" style="margin-top:8px;align-items:start">
      <div class="card pad"><h3 style="margin-top:0">1 · A projection for every player and every game</h3>
        <p class="ink2">Machine-learning models (gradient-boosted trees) predict each player's minutes, then his points, rebounds, assists, threes, steals, blocks and points + rebounds + assists. They use recent form, role, the official injury report (his and his teammates'), how he played when key teammates sat, opponent defense and rebounding/assist rates, pace, rest and travel. A game model projects each team's score, the total, the margin and the 1st half, with overtime handled explicitly. Every projection is a full range of outcomes, not just one number, and the outcomes of one game are tied together (a star's big night tends to come with his team's points), so combos are priced as a whole.</p>
        <h3>2 · A fair chance for every line</h3>
        <p class="ink2">Markets are sharp. On real prices the model's own view adds only a little information beyond the price, and when it disagrees a lot, the market is usually right. So each line's <b>fair chance</b> starts from the market price, adds the model's view, and corrects a known bias: Overs are slightly overpriced because that's what people like to bet${fp ? ` (fit on ${fp.n.toLocaleString()} real lines)` : ''}.</p>
        <h3>3 · Picks, locked ${LEAD} minutes before tip</h3>
        <p class="ink2">A line is a <b>pick</b> when its fair chance beats the price plus the fee on a tight, fresh market, priced between 25% and 80% (about +300 to −400), for a player who isn't questionable and is projected for 15+ minutes. Every side is priced on Polymarket US and Kalshi and routed to the cheapest one that actually sells it (Polymarket US props only sell the Over). There's no fixed number: some nights have ten, some none. <b>Strength</b> ranks picks by long-run bankroll growth (the Kelly criterion). Picks freeze ${LEAD} minutes before each tip-off, after starting lineups are posted.</p>
        <h3>4 · Live vs Testing</h3>
        <p class="ink2">Every market family (points, rebounds, spreads…) must pass the same pre-registered backtest on real Kalshi prices, fees included, before its picks count or go into combos. Until then it's <b>Testing</b>: shown with fair prices and tracked in its own record, never mixed into the headline.</p>
        <h3>5 · Combos</h3>
        <p class="ink2">Suggested combos only use picks from Live families that a venue will actually combine (prop Overs and game sides; no venue takes a prop Under in a combo). Strongest = best mix of value and hit chance; Big upside = 4×+ payouts that still hit 12%+ of the time. On any game page you can tap prices to build your own: the slip shows the chance all legs hit, with correlations, and whether Polymarket US or Kalshi would take it.</p>
      </div>
      <div class="card pad"><h3 style="margin-top:0">How to use it</h3>
        <ol class="ink2" style="padding-left:18px;margin:0">
          <li>Check that prices are fresh (green dot, top right).</li>
          <li>Start with <b>The model's picks</b>, then open a player to see why: his recent games against the line, the injury report, the matchup.</li>
          <li>Add what the model can't know: late scratches, minutes limits, coach comments. If the price moved for a reason you can see, trust the price.</li>
          <li>For a combo, type the app's quote into the builder before you buy.</li>
          <li>Size small. Edges are a point or two of chance; the suggested stake is a quarter of the Kelly formula (an eighth for combos), never more than 2% of a bankroll.</li>
        </ol>
        <h3>What it doesn't know</h3>
        <ul class="ink2" style="padding-left:18px;margin:0">
          <li>News after the latest injury report (shootaround updates, late scratches)</li><li>Minutes limits and returns from injury</li>
          <li>Motivation, revenge games, rest decisions not yet announced</li><li>In-game events: foul trouble, blowouts as they happen</li>
        </ul>
        <h3>How much to trust it</h3>
        <p class="ink2">On a held-out stretch of real prices, picks like these won about as often as predicted and returned a few percent per bet, but the uncertainty band still includes zero. Treat it as an informed second opinion. The <a href="#/record">track record</a> keeps score in public.</p>
      </div>
    </div>
    <section class="section"><div class="section-head"><h2>The research behind the rules</h2><span class="lede">What we checked before deciding how to pick lines and build combos</span></div>
      <div class="grid g2">${RESEARCH.map((r) => html`<div class="card pad"><div style="font-weight:650">${r[0]}</div><div class="small ink2" style="margin-top:4px">${r[1]}</div>
        <div class="small" style="margin-top:6px"><b>So:</b> ${r[2]}</div><div class="tiny muted" style="margin-top:6px">${r[3].map((l, i) => html`${i ? ' · ' : ''}<a href=${l[1]} rel="noopener" target=${l[1].startsWith('#') ? null : '_blank'}>${l[0]}</a>`)}</div></div>`)}</div></section>
    <section class="section"><div class="section-head"><h2>Glossary</h2></div>
      <div class="grid g2">${F.GLOSSARY.map(([k, v]) => html`<div class="card pad"><b>${k}</b><div class="ink2 small" style="margin-top:4px">${v}</div></div>`)}</div></section>
  </main>`;
}

// ===================================================================================== app
// the game id of the page you came from, if it was a game page (detail pages then skip their own "game" link)
const prevGame = () => { const r = (NAV.stack[NAV.stack.length - 2] || '').split('/'); return r[1] === 'game' ? r[2] : null; };
initGames({ TeamChip, VenueChip, FamilyBadge, Seg, Info, Empty, Tabs, Hero, goPick, goStat, lineHash, OddsV, VENUE, go, BackLink, Select,
  Switch, prevGame });
initParlays({ Seg, Info, Empty, Select, Switch, goStat, TeamChip, VenueChip, OddsV });

function App() {
  const { data: d, error } = useData();
  const route = useRoute();
  const [, setOdds] = useState(F.oddsMode());
  const onOdds = (m) => { F.setOddsMode(m); setOdds(m); };
  let page;
  if (!d) {
    page = error
      ? html`<main class="page"><${Empty} title="Couldn't load tonight's data">${error}. Try again in a minute.</${Empty}></main>`
      : html`<div class="loading"><svg class="ball-spin" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="var(--brand)"/><path d="M2 20h36M20 2v36M7 7c7 6 7 20 0 26M33 7c-7 6-7 20 0 26" stroke="#1a1a1a" stroke-width="1.6" fill="none"/></svg></div>`;
  } else if (route[0] === 'player') page = html`<${Player} d=${d} gid=${route[1]} pid=${route[2]} a3=${route[3]} a4=${route[4]}/>`;
  else if (route[0] === 'line') page = html`<${LinePage} d=${d} gid=${route[1]} mid=${route[2]} side=${route[3]}/>`;
  else if (route[0] === 'game') page = html`<${GamePage} d=${d} gid=${route[1]} tab=${route[2]} fam=${route[3]}/>`;
  else if (route[0] === 'markets') page = html`<${Markets} d=${d} cat=${route[1]}/>`;
  else if (route[0] === 'combos') page = html`<${CombosPage} d=${d} preset=${route[1]}/>`;
  else if (route[0] === 'record') page = html`<${Record} d=${d}/>`;
  else if (route[0] === 'how') page = html`<${How} d=${d}/>`;
  else page = html`<${Tonight} d=${d}/>`;
  return html`<${TopBar} route=${route} d=${d} onOdds=${onOdds}/>${page}<${Footer} d=${d}/>${d && html`<${Slip} d=${d}/>`}`;
}

render(html`<${App}/>`, document.getElementById('app'));
