// Streaks: tonight's lines players keep hitting (10/10, 9/10, ... of their last 10), filters to narrow them, a combo
// helper that builds from what's left, and what the consistency backtest found (data/streaks.json, written by
// app/pipeline/parlays_live.py streak_legs + app/backtest/consistency.py).
import { html, useState, useEffect, useMemo } from '../vendor/preact-htm.mjs';
import * as F from './fmt.js';
import { comboFee } from './combo.js';
import { setSlip, toggleLeg, useSlip } from './games.js';
import { slipLeg, Dots } from './parlays.js';

const { isNum } = F;
let S = {};
export const init = (shared) => { S = shared; };

const UNIT = { pts: 'pts', reb: 'reb', ast: 'ast', fg3m: '3PM', pra: 'PRA', stl: 'stl', blk: 'blk' };
const STAT_LABEL = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', fg3m: 'Threes', pra: 'Pts+Reb+Ast', stl: 'Steals', blk: 'Blocks' };
const sideOf = (lg) => lg.side || 'over';
const KEY = 'pr_streak_filters_v1';
const DEFAULT = { rec: '9', run: '0', side: 'all', stat: 'all', game: 'all', price: 'any', agree: false, l5: false,
  season: false, starters: false, best: true, real: false, started: true, q: '', sort: 'streak' };
const PRICE = { any: [0, 1], u90: [0, 0.9], u80: [0, 0.8], b6090: [0.6, 0.9], b7090: [0.7, 0.9] };
const SORT = {
  streak: (a, b) => b.streak - a.streak || b.l10_hits - a.l10_hits || a.price - b.price,
  record: (a, b) => b.l10_hits / b.l10_n - a.l10_hits / a.l10_n || b.streak - a.streak,
  payout: (a, b) => a.price - b.price,
  chance: (a, b) => b.p - a.p,
  value: (a, b) => (b.p - b.price) - (a.p - a.price),
  tip: (a, b) => String(a.tip).localeCompare(String(b.tip)) || b.streak - a.streak,
};

function load() {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT }; }
}
function useFilters() {
  const [f, setF] = useState(load);
  const set = (k, v) => setF((o) => { const n = { ...o, [k]: v }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ } return n; });
  const reset = () => { setF({ ...DEFAULT }); try { localStorage.removeItem(KEY); } catch { /* private mode */ } };
  return [f, set, reset];
}

let cache = null;
function useStreaks(stamp) {
  const [st, setSt] = useState(cache);
  useEffect(() => {
    let alive = true;
    fetch(`data/streaks.json?m=${encodeURIComponent(stamp || Date.now())}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) { cache = j; setSt(j); } })
      .catch(() => { if (alive && !cache) setSt({ lines: [], error: true }); });
    return () => { alive = false; };
  }, [stamp]);
  return st;
}

export function applyFilters(lines, f) {
  const [lo, hi] = PRICE[f.price] || PRICE.any;
  const q = f.q.trim().toLowerCase();
  let x = lines.filter((lg) => lg.l10_hits >= +f.rec && lg.streak >= +f.run
    && (f.side === 'all' || sideOf(lg) === f.side) && (f.stat === 'all' || lg.stat === f.stat)
    && (f.game === 'all' || lg.game_id === f.game) && lg.price >= lo && lg.price <= hi
    && (!f.agree || lg.p >= lg.price) && (!f.l5 || lg.l5 === 5)
    && (!f.season || (lg.season_n >= 5 && lg.season_hits >= 0.8 * lg.season_n))
    && (!f.starters || lg.mu_min >= 28) && (!f.real || lg.checked !== false) && (f.started || !lg.started) && (!q || lg.name.toLowerCase().includes(q)));
  if (f.best) {  // one line per player, stat and side: the one that pays most among those passing the filters
    const best = new Map();
    for (const lg of x) {
      const k = `${lg.game_id}|${lg.player_id}|${lg.stat}|${sideOf(lg)}`;
      if (!best.has(k) || lg.price < best.get(k).price) best.set(k, lg);
    }
    x = [...best.values()];
  }
  return x.sort(SORT[f.sort] || SORT.streak);
}

function Row({ d, lg }) {
  const s = useSlip();
  const leg = slipLeg(d, lg);
  const on = s.some((x) => x.id === leg.id);
  const g = d.gameById?.[lg.game_id] || {};
  const tri = d.teams?.[lg.team_id]?.tri || '';
  const home = lg.team_id === g.home;
  const opp = d.tri ? d.tri(home ? g.away : g.home) : '';
  const u = sideOf(lg) === 'under';
  const go = () => S.goStat(lg.game_id, lg.player_id, lg.stat, lg.thr - 0.5);
  return html`<div class="srow click" onClick=${go} tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && go()}>
    <div class="srow-main">
      <div class="who">${lg.name} <span class=${sideOf(lg)}>${u ? 'Under' : 'Over'} ${lg.thr - 0.5} ${UNIT[lg.stat]}</span></div>
      <div class="what"><${S.TeamChip} tri=${tri}/> ${home ? 'vs' : '@'} ${opp} · ${lg.started ? html`<span class="chip ghost tiny" title=${`Started: the record and price are as of ${F.timeET(g.frozen_at)}, before tip`}>Started${g.score ? ` · ${g.score[0]}–${g.score[1]}` : ''}</span>` : F.timeET(g.tip || lg.tip)} · ${u ? 'No' : 'Yes'} on ${lg.thr}+</div>
      <div class="what"><b class="good">${lg.l10_hits}/${lg.l10_n}</b> last ${lg.l10_n} <${Dots} lg=${lg}/>
        · ${lg.streak >= 20 ? '20+' : lg.streak} in a row · ${lg.season_n ? `${lg.season_hits}/${lg.season_n} this season` : 'none this season yet'}</div>
    </div>
    <div class="srow-nums">
      <div title=${lg.checked === false ? "The model's chance: this rung's book wasn't read yet, so it isn't anchored on the market" : 'Fair chance: the model anchored on a real order book'}>
        <div class="k">${lg.checked === false ? 'Model' : 'Fair'}</div><div class="v"><${S.OddsV} p=${lg.p}/></div></div>
      <div title=${lg.checked === false ? 'Snapshot quote, book not checked: confirm the price on Polymarket US' : 'The price $10 fills at on Polymarket US'}>
        <div class="k">Price</div><div class=${`v${lg.checked === false ? ' muted' : ''}`}><${S.OddsV} p=${lg.price}/>${lg.checked === false ? '*' : ''}</div></div>
      ${!lg.started && html`<button class=${`addbtn${on ? ' on' : ''}`} title=${on ? 'Remove from your combo slip' : 'Add to your combo slip'} onClick=${(e) => { e.stopPropagation(); toggleLeg(leg); }}>${on ? '✓' : '+ slip'}</button>`}
    </div>
  </div>`;
}

// greedy combos from the filtered list, in its order: one leg per player, a per-game cap
function suggest(list, k, spread) {
  const cap = spread === 'one' ? 1 : spread === 'two' ? 2 : 99;
  const pick = (skip) => {
    const out = [], players = new Set(), games = {};
    for (const lg of list) {
      if (lg.started || skip.has(lg.key) || players.has(lg.player_id) || (games[lg.game_id] || 0) >= cap) continue;
      out.push(lg); players.add(lg.player_id); games[lg.game_id] = (games[lg.game_id] || 0) + 1;
      if (out.length === k) return out;
    }
    return null;
  };
  const a = pick(new Set());
  if (!a) return [];
  const b = pick(new Set(a.slice(0, Math.ceil(k / 2)).map((x) => x.key)));
  const c = pick(new Set(a.map((x) => x.key)));
  const seen = new Set();
  return [a, b, c].filter(Boolean).filter((s) => { const id = s.map((x) => x.key).sort().join(); if (seen.has(id)) return false; seen.add(id); return true; });
}

const variantFor = (rec) => (+rec >= 10 ? '10/10' : +rec >= 9 ? '9+/10' : '8+/10');

function Suggestion({ d, legs, bt, rec, i }) {
  const px = legs.reduce((a, l) => a * l.price, 1);
  const cost = px + comboFee(px);
  const games = new Set(legs.map((l) => l.game_id)).size;
  const v = variantFor(rec);
  const row = bt?.combos?.by_k?.find((r) => r.variant === v && r.k === legs.length);
  return html`<div class="card pad sugg">
    <div class="row wrap" style="gap:8px"><b>Combo ${i + 1}</b><span class="small ink2">${legs.length} legs · ${games} game${games > 1 ? 's' : ''}</span><span class="spacer"></span>
      <span class="chip good">Pays ~${F.x1(1 / cost)}</span></div>
    <div class="legs" style="margin-top:8px">${legs.map((lg) => html`<div class="leg"><div><div class="who">${lg.name} <span class=${sideOf(lg)}>${sideOf(lg) === 'under' ? 'Under' : 'Over'} ${lg.thr - 0.5} ${UNIT[lg.stat]}</span></div>
      <div class="what">${lg.l10_hits}/${lg.l10_n} last ${lg.l10_n} · ${lg.streak >= 20 ? '20+' : lg.streak} in a row · price ${F.odds(lg.price)}</div></div></div>`)}</div>
    <div class="small ink2" style="margin-top:8px">Est. price ${F.odds(cost, 1)} incl. the combo fee (the app's own quote can differ).
      ${row?.n ? html` In the backtest, ${legs.length}-leg combos of ${v} lines hit <b>${F.pct(row.hit, 0)}</b> and missed by just one leg ${F.pct(row.one_short, 0)} of the time; return ${F.signedPct(row.roi, 0)} per $1 (${row.nights} nights).` : ''}</div>
    <div class="row" style="margin-top:8px"><button class="btn ghost sm" onClick=${() => setSlip(legs.map((lg) => slipLeg(d, lg)))}>Load into combo slip</button></div>
  </div>`;
}

function Builder({ d, list, bt, rec }) {
  const [k, setK] = useState(4);
  const [spread, setSpread] = useState('two');
  const sug = useMemo(() => suggest(list, k, spread), [list, k, spread]);
  return html`<div>
    <div class="toolbar wrap">
      <span class="small ink2">Legs</span><${S.Seg} value=${String(k)} onChange=${(v) => setK(+v)} options=${[2, 3, 4, 5, 6, 7, 8].map((x) => [String(x), String(x)])}/>
      <${S.Seg} value=${spread} onChange=${setSpread} options=${[['one', 'One per game'], ['two', 'Up to 2 per game'], ['any', 'Any']]}/>
    </div>
    <div class="small muted" style="margin:4px 0 10px">Built from the lines listed below (games still to come only), in their current order and filters: top lines first, one leg per player. Change the sort or filters to change the combos.</div>
    ${sug.length ? html`<div class="grid g3">${sug.map((s, i) => html`<${Suggestion} d=${d} legs=${s} bt=${bt} rec=${rec} i=${i}/>`)}</div>`
      : html`<${S.Empty} title="Not enough lines for that many legs">Loosen the filters, allow more legs per game, or pick fewer legs.</${S.Empty}>`}
  </div>`;
}

// hit rate by number of legs: all legs hit vs at most one miss, for one record bar
function LegsChart({ rows }) {
  const [tip, setTip] = useState(null);
  if (!rows.length) return null;
  const W = 460, H = 220, L = 36, R = 10, T = 14, B = 34;
  const n = rows.length, bw = (W - L - R) / n;
  const y = (v) => H - B - v * (H - B - T);
  return html`<div class="relpos"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hit rate by number of legs">
    <g class="grid">${[0, 0.25, 0.5, 0.75, 1].map((t) => html`<line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)}/>`)}</g>
    ${[0, 0.5, 1].map((t) => html`<text x=${L - 6} y=${y(t) + 4} text-anchor="end">${F.pct(t)}</text>`)}
    ${rows.map((r, i) => {
      const x0 = L + i * bw + bw * 0.14, w = bw * 0.34;
      return html`<g>
        <rect x=${x0} y=${y(r.within_one)} width=${w} height=${y(0) - y(r.within_one)} rx="3" fill="var(--chart-2, #9aa7b8)"/>
        <rect x=${x0 + w + 2} y=${y(r.hit)} width=${w} height=${y(0) - y(r.hit)} rx="3" fill="var(--brand)"/>
        <text x=${x0 + w + 2 + w / 2} y=${y(r.hit) - 4} text-anchor="middle" style="fill:var(--ink)">${F.pct(r.hit)}</text>
        <text x=${L + i * bw + bw / 2} y=${H - 14} text-anchor="middle">${r.k} legs</text>
        <rect x=${L + i * bw} y=${T} width=${bw} height=${H - B - T} fill="transparent"
          onMouseEnter=${() => setTip({ x: L + i * bw + bw / 2, y: y(r.within_one) - 8, text: `${r.k} legs: all hit ${F.pct(r.hit, 1)}, at most one miss ${F.pct(r.within_one, 1)}, typical payout ${F.x1(r.payout)}, return ${F.signedPct(r.roi, 0)} per $1 (${r.n.toLocaleString()} combos, ${r.nights} nights)` })}
          onMouseLeave=${() => setTip(null)}/></g>`;
    })}
  </svg>
  <div class="legend small"><span><i style="background:var(--brand)"></i>Every leg hit</span><span><i style="background:var(--chart-2, #9aa7b8)"></i>At most one leg missed</span></div>
  ${tip && html`<div class="tt" style=${`left:${(100 * tip.x) / W}%;top:${(100 * tip.y) / H}%`}>${tip.text}</div>`}</div>`;
}

function Findings({ bt }) {
  const [v, setV] = useState('9+/10');
  if (!bt) return html`<div class="small muted">The consistency backtest hasn't run yet.</div>`;
  const s = bt.singles || {};
  const one = (b) => s.by_l10?.find((r) => r.side === 'all' && r.l10 === b);
  const byK = (bt.combos?.by_k || []).filter((r) => r.variant === v && r.n);
  const split = (bt.combos?.by_split || []).filter((r) => r.variant === '9+/10' && (r.k === 4 || r.k === 5));
  const SPLIT = { 1: 'All from 1 game', 2: 'From 2 games', 3: 'From 3 games', each: 'Every leg a different game' };
  return html`<div>
    <div class="pstats rec">${[10, 9, 8, 7].map((b) => { const r = one(b); return r?.n && html`<div class="bigstat"><div class="k">${b}/10 lines</div>
      <div class="v">${F.pct(r.hit, 0)}</div><div class="tiny muted">hit, priced ${F.pct(r.price, 0)} · return ${F.signedPct(r.roi, 1)} per $1 (n=${r.n.toLocaleString()})</div></div>`; })}</div>
    <div class="small ink2" style="margin-top:10px"><b>What this says:</b> streaks are real: lines he hit 10 of his last 10 cleared ${F.pct(one(10)?.hit, 0)} of the time, far above a coin flip. But the price already knows it: those lines were priced at ${F.pct(one(10)?.price, 0)}, so they won about as often as the price said (a point or so less). Consistency tells you <i>which</i> lines are likely; it doesn't make them cheap.</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card chartcard"><h3>How many legs?</h3><p class="cap">Random combos of tonight-style consistent lines on every past night, by number of legs. One leg short happens about 40% of the time at every size: "so close" is normal, not a sign you're nearly there.</p>
        <div style="margin-bottom:6px"><${S.Seg} value=${v} onChange=${setV} options=${(bt.combos?.variants || []).filter((x) => !x.includes('Overs')).map((x) => [x, x.replace(', model agrees', ' + model').replace(', Unders only', ' Unders')])}/></div>
        <${LegsChart} rows=${byK}/></div>
      <div class="card chartcard"><h3>Splitting across games</h3><p class="cap">9+/10 lines, 4 and 5 legs: the same combos drawn from one game, two, three, or a different game for every leg.</p>
        <div class="tablewrap" style="box-shadow:none"><table class="t"><thead><tr><th>Legs</th><th>Games</th><th class="r">All hit</th><th class="r">≤ 1 miss</th><th class="r">Return</th></tr></thead>
          <tbody>${split.map((r) => html`<tr><td>${r.k}</td><td>${SPLIT[r.split]}</td><td class="r">${F.pct(r.hit, 0)}</td><td class="r">${F.pct(r.within_one, 0)}</td><td class=${`r ${r.roi >= 0 ? 'good' : 'bad'}`}>${F.signedPct(r.roi, 0)}</td></tr>`)}</tbody></table></div>
        <div class="small ink2" style="margin-top:8px">No consistent difference: spreading legs over more games didn't make these combos safer, and stacking one game didn't sink them. Pick the legs you like; the split matters less than the number of legs.</div></div>
    </div>
    <div style="margin-top:12px"><${S.Info} title="Which extra filters helped a 9+/10 line?" open=${false}>
      <div class="tablewrap" style="box-shadow:none"><table class="t"><thead><tr><th>Lines</th><th class="r">n</th><th class="r">Hit</th><th class="r">Priced</th><th class="r">Return per $1</th></tr></thead>
        <tbody>${(s.stacked || []).map((r) => html`<tr><td>${r.name}</td><td class="r">${r.n?.toLocaleString()}</td><td class="r">${F.pct(r.hit, 1)}</td><td class="r">${F.pct(r.price, 1)}</td><td class=${`r ${r.roi >= 0 ? 'good' : 'bad'}`}>${F.signedPct(r.roi, 1)}</td></tr>`)}</tbody></table></div>
      <div class="small ink2" style="margin-top:8px">Our model agreeing (its chance at least the price) was the one filter that moved a 9+/10 line from a small loss to about even; lines it rated below the price did worst. That was spotted while exploring this data, so treat it as a lead, not a proven edge. Longer streaks and a strong season record barely changed anything: the price already reflects them.</div>
    </${S.Info}></div>
    <div class="tiny muted" style="margin-top:8px">${bt.source}. ${bt.n_lines?.toLocaleString()} lines over ${bt.n_nights} nights (${bt.from} to ${bt.to}), points, rebounds, assists, threes, steals and blocks, Overs and Unders. Combos: up to ${bt.per_night} random ones a night per record bar, one leg per player, the cheapest rung that still meets the bar, priced as the product of the legs plus the Polymarket US combo fee. Returns resample whole nights; nothing here is fit, so it's a plain record of the method.</div>
  </div>`;
}

export function Streaks({ d }) {
  const data = useStreaks(d.streaks?.computed_at || d.generated_at);
  const [f, set, reset] = useFilters();
  const [n, setN] = useState(30);
  const lines = data?.lines || [];
  const shown = useMemo(() => applyFilters(lines, f), [lines, f]);
  useEffect(() => setN(30), [f]);
  const games = (d.games || []).filter((g) => lines.some((x) => x.game_id === g.id));
  const stats = [...new Set(lines.map((x) => x.stat))];
  const dirty = JSON.stringify(f) !== JSON.stringify(DEFAULT);
  const nMore = ['run', 'game', 'price', 'q', 'agree', 'l5', 'season', 'starters', 'best', 'real', 'started'].filter((k) => f[k] !== DEFAULT[k]).length;
  const [more, setMore] = useState(typeof window !== 'undefined' && window.innerWidth > 720);
  return html`<main class="page">
    <${S.Hero} d=${d} kicker="Consistency" title="Streaks" sub="Lines players keep hitting: 10 of their last 10, 9 of 10 and so on, on Polymarket US. Filter them, build combos from them, and see how this has done."/>
    <div class="jumps small">Jump to <a href="javascript:void 0" onClick=${() => document.getElementById('st-build')?.scrollIntoView({ behavior: 'smooth' })}>Build a combo</a> · <a href="javascript:void 0" onClick=${() => document.getElementById('st-find')?.scrollIntoView({ behavior: 'smooth' })}>How streaks have done</a></div>
    <section class="section">
      <div class="toolbar wrap">
        <${S.Seg} value=${f.rec} onChange=${(v) => set('rec', v)} options=${[['10', '10/10'], ['9', '9+/10'], ['8', '8+/10'], ['7', '7+/10'], ['6', '6+/10']]}/>
        <${S.Seg} value=${f.side} onChange=${(v) => set('side', v)} options=${[['all', 'Overs + Unders'], ['over', 'Overs'], ['under', 'Unders']]}/>
        <${S.Select} label="Stat" value=${f.stat} onChange=${(v) => set('stat', v)} options=${[['all', 'All stats'], ...stats.map((x) => [x, STAT_LABEL[x]])]}/>
        <${S.Select} label="Sort" value=${f.sort} onChange=${(v) => set('sort', v)} options=${[['streak', 'Sort: longest run'], ['record', 'Sort: best record'], ['payout', 'Sort: biggest payout'], ['chance', 'Sort: fair chance'], ['value', 'Sort: best price vs fair'], ['tip', 'Sort: tip time']]}/>
      </div>
      <details class="morefilters" open=${more}>
        <summary onClick=${(e) => { e.preventDefault(); setMore(!more); }}>More filters${nMore ? ` · ${nMore} on` : ''}</summary>
        <div class="toolbar wrap" style="margin-top:8px">
          <${S.Select} label="In a row" value=${f.run} onChange=${(v) => set('run', v)} options=${[['0', 'Any run'], ['5', '5+ in a row'], ['8', '8+ in a row'], ['10', '10+ in a row'], ['15', '15+ in a row']]}/>
          <${S.Select} label="Game" value=${f.game} onChange=${(v) => set('game', v)} options=${[['all', 'All games'], ...games.map((g) => [g.id, `${d.tri(g.away)} @ ${d.tri(g.home)} · ${F.timeET(g.tip)}`])]}/>
          <${S.Select} label="Price" value=${f.price} onChange=${(v) => set('price', v)} options=${[['any', 'Any price'], ['u90', 'Price under 90%'], ['u80', 'Price under 80%'], ['b6090', 'Price 60–90%'], ['b7090', 'Price 70–90%']]}/>
          <label class="sel"><span class="sr">Player</span><input class="input" type="search" placeholder="Player" value=${f.q} onInput=${(e) => set('q', e.target.value)}/></label>
        </div>
        <div class="toolbar wrap">
          <${S.Switch} checked=${f.agree} onChange=${(v) => set('agree', v)}>Our model agrees</${S.Switch}>
          <${S.Switch} checked=${f.l5} onChange=${(v) => set('l5', v)}>Last 5 all hit</${S.Switch}>
          <${S.Switch} checked=${f.season} onChange=${(v) => set('season', v)}>80%+ this season</${S.Switch}>
          <${S.Switch} checked=${f.starters} onChange=${(v) => set('starters', v)}>Starters (28+ min)</${S.Switch}>
          <${S.Switch} checked=${f.best} onChange=${(v) => set('best', v)}>One line per player & stat</${S.Switch}>
          <${S.Switch} checked=${f.real} onChange=${(v) => set('real', v)}>Checked prices only</${S.Switch}>
          <${S.Switch} checked=${f.started} onChange=${(v) => set('started', v)}>Include started games</${S.Switch}>
        </div>
      </details>
      ${dirty && html`<div style="margin-bottom:6px"><button class="btn ghost sm" onClick=${reset}>Reset filters</button></div>`}
      <div class="small ink2" style="margin:4px 0 10px">${shown.length.toLocaleString()} line${shown.length === 1 ? '' : 's'}${f.best ? ' (the biggest-paying rung per player and stat)' : ''} of ${lines.length.toLocaleString()}${data?.computed_at ? ` · updated ${F.ago(data.computed_at)}` : ''}${lines.some((x) => x.checked === false) ? ' · * price from a snapshot quote, confirm it in the app' : ''}</div>
      ${!data ? html`<div class="small muted">Loading…</div>` : shown.length
        ? html`<div class="srows">${shown.slice(0, n).map((lg) => html`<${Row} key=${lg.key} d=${d} lg=${lg}/>`)}</div>
          ${shown.length > n && html`<div class="row" style="margin-top:10px"><button class="btn ghost" onClick=${() => setN(n + 30)}>Show ${Math.min(30, shown.length - n)} more</button></div>`}`
        : html`<${S.Empty} title=${lines.length ? 'Nothing matches these filters' : 'No lines yet tonight'}>${lines.length
          ? html`<button class="btn ghost sm" onClick=${reset}>Reset filters</button>` : 'Lines appear as Polymarket US opens its markets; the list refreshes every few minutes.'}</${S.Empty}>`}
    </section>
    <section class="section" id="st-build"><div class="section-head"><h2>Build a combo from these</h2><span class="lede">Pick a size and how to spread it; the combos come from the lines above</span></div>
      <${Builder} d=${d} list=${shown} bt=${data?.backtest} rec=${f.rec}/></section>
    <section class="section" id="st-find"><div class="section-head"><h2>How streaks have done</h2><span class="lede">Every Kalshi player line since Nov 2025, real prices 20 minutes before tip</span></div>
      <${Findings} bt=${data?.backtest}/></section>
  </main>`;
}
