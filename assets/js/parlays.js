// "Your style" parlays: 5-7 Over/Under legs from 1-3 games paying 4-7x, and a safer tier of 2-4 legs from 1-2 games
// paying 3-5x; consistent players (data/parlays.json,
// built by app/picks/parlays.py). Shared components come from app.js through init() (no circular imports).
import { html, useState, useEffect, useMemo } from '../vendor/preact-htm.mjs';
import * as F from './fmt.js';
import * as C from './charts.js';
import { setSlip, toggleLeg, useSlip } from './games.js';

const { isNum } = F;
let S = {};
export const init = (shared) => { S = shared; };

const UNIT = { pts: 'pts', reb: 'reb', ast: 'ast', fg3m: '3PM', pra: 'PRA', stl: 'stl', blk: 'blk' };
const SRC = { us: 'fair (Polymarket US book)', kalshi: 'fair (Kalshi book)' };
const PAY = { any: [0, 99], z: [3, 4], a: [4, 5], b: [5, 6], c: [6, 7.01] };
const TIER = { main: '5–7 legs', safer: '2–4 legs' };
const tierOf = (c) => c.tier || (c.k <= 4 ? 'safer' : 'main');
const SORT = {
  value: (c) => -c.ev,
  likely: (c) => -c.p_bt,
  form: (c) => -(c.p_form ?? c.p_bt) * c.payout,
};
const PAGE = 15;
const sideOf = (lg) => lg.side || 'over';
const SIDE = (lg) => (sideOf(lg) === 'under' ? 'Under' : 'Over');
const won = (lg, v) => (sideOf(lg) === 'under' ? v < lg.thr : v >= lg.thr);  // did this past game win the leg's side
const SIMILAR = 3;  // parlays sharing this many identical legs or more are variations of one another
// look-alikes: same tier, sharing SIMILAR+ legs (all but one of the smaller one's for 2-4 legs; app/picks/parlay_record.py)
const similar = (a, b) => tierOf(a) === tierOf(b)
  && a.legs.filter((l) => b.legs.includes(l)).length >= Math.min(SIMILAR, Math.min(a.legs.length, b.legs.length) - 1);

let cache = null;
function useParlays(stamp) {
  const [st, setSt] = useState(cache);
  useEffect(() => {
    let alive = true;
    fetch(`data/parlays.json?m=${encodeURIComponent(stamp || Date.now())}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) { cache = j; setSt(j); } })
      .catch(() => { if (alive && !cache) setSt({ list: [], legs: {}, error: true }); });
    return () => { alive = false; };
  }, [stamp]);
  return st;
}

const gameName = (d, gid) => {
  const g = d.gameById?.[gid];
  return g ? `${d.tri(g.away)} @ ${d.tri(g.home)}` : gid;
};
const tipOf = (d, gid) => d.gameById?.[gid]?.tip;
const spanMin = (d, games) => {
  const t = games.map((g) => new Date(tipOf(d, g)).getTime()).filter(Number.isFinite);
  return t.length ? (Math.max(...t) - Math.min(...t)) / 60000 : 0;
};

function slipLeg(d, lg) {
  const g = d.gameById?.[lg.game_id] || {};
  const line = lg.thr - 0.5;
  const side = sideOf(lg);
  return { id: `${lg.game_id}|${lg.family}|${lg.player_id}|${line}|${side}`, key: `${lg.game_id}:${lg.player_id}:${lg.stat}`,
    kind: 'player', g: lg.game_id, stat: lg.stat, fam: lg.family, pid: lg.player_id, team: lg.team_id,
    home: lg.team_id === g.home, min: lg.mu_min, side, line,
    label: `${lg.name} ${SIDE(lg)} ${line} ${UNIT[lg.stat]}`, p: lg.p,
    flo: side === 'over' ? 1 - lg.p : 0, fhi: side === 'over' ? 1 : lg.p,
    us: { px: lg.price, combo: true }, k: null };
}

// his last 10 games at this line, oldest left: filled = his side won (cleared it / stayed under), darker = this season
function Dots({ lg }) {
  const vals = (lg.recent || []).map((v, i) => ({ v, cur: lg.recent_cur?.[i] })).filter((x) => x.v !== null).reverse();
  return html`<span class="hitdots" title=${`Last ${vals.length} games (oldest first): ${vals.map((x) => x.v).join(', ')} · line ${lg.thr - 0.5}`}>
    ${vals.map((x) => html`<i class=${`${won(lg, x.v) ? 'hit' : 'miss'}${x.cur ? ' cur' : ''}`}></i>`)}</span>`;
}

function Leg({ d, lg, weakest }) {
  const tri = d.teams?.[lg.team_id]?.tri || '';
  return html`<div class="leg click" onClick=${() => S.goStat(lg.game_id, lg.player_id, lg.stat, lg.thr - 0.5)}>
    <div><div class="who">${lg.name} <span class=${sideOf(lg)}>${SIDE(lg)} ${lg.thr - 0.5} ${UNIT[lg.stat]}</span>${weakest ? html` <span class="chip warn tiny">weakest</span>` : ''}</div>
      <div class="what">${tri} · ${sideOf(lg) === 'under' ? 'No' : 'Yes'} on ${lg.thr}+ at ${F.odds(lg.price)} · ${sideOf(lg) === 'under' ? 'under' : 'hit'} ${lg.l10_hits}/${lg.l10_n} last ${lg.l10_n}${lg.season_n ? `, ${lg.season_hits}/${lg.season_n} this season` : ', none this season yet'} <${Dots} lg=${lg}/></div></div>
    <div class=${`pp ${sideOf(lg)}`} title=${`${SRC[lg.p_src] || 'fair'} · model alone ${F.pct(lg.model)} · form-weighted ${F.pct(lg.p_form)}`}>${F.pct(lg.p)}</div></div>`;
}

const legName = (lg) => `${lg.name} ${SIDE(lg)} ${lg.thr - 0.5} ${UNIT[lg.stat]}`;

// a variation of the card's parlay: only the legs it swaps, its numbers, and a load button
function Variation({ d, c, head, legs }) {
  const H = new Set(head.legs), V = new Set(c.legs);
  const add = c.legs.filter((k) => !H.has(k)).map((k) => legs[k]).filter(Boolean);
  const drop = head.legs.filter((k) => !V.has(k)).map((k) => legs[k]).filter(Boolean);
  const L = c.legs.map((k) => legs[k]).filter(Boolean);
  return html`<div class="variation">
    <div class="small">${drop.length > 0 && html`<div><span class="bad">− </span>${drop.map(legName).join(', ')}</div>`}
      ${add.length > 0 && html`<div><span class="good">+ </span>${add.map(legName).join(', ')}</div>`}</div>
    <div class="row wrap tiny ink2" style="gap:8px;margin-top:4px"><span>${c.k} legs · ${c.games.length} game${c.games.length > 1 ? 's' : ''}</span>
      <span>pays <b>${F.x1(c.payout)}</b></span><span>backtested <b>${F.pct(c.p_bt)}</b></span>
      <span>value <b class=${c.ev >= 0 ? 'good' : 'bad'}>${F.signedPct(c.ev, 0)}</b></span><span class="spacer"></span>
      <button class="btn ghost sm" onClick=${() => setSlip(L.map((lg) => slipLeg(d, lg)))}>Load</button></div>
  </div>`;
}

function Card({ d, c, legs, rank, vars = [] }) {
  const [open, setOpen] = useState(false);
  const [nv, setNv] = useState(10);
  const L = c.legs.map((k) => legs[k]).filter(Boolean);
  const games = c.games.map((g) => gameName(d, g)).join(' · ');
  const tips = [...new Set(c.games.map((g) => F.timeET(tipOf(d, g))))].join(' / ');
  const minP = Math.min(...L.map((l) => l.p));
  return html`<article class="card combo parlay">
    <div class="combo-head"><span class="rank">${rank}</span>
      <div class="grow"><div style="font-weight:650">${c.k} legs · ${c.games.length} game${c.games.length > 1 ? 's' : ''}${tierOf(c) === 'safer' ? html` <span class="chip ghost tiny" title="The safer tier: 2–4 legs paying 3–5× (a 2–4× profit)">Safer</span>` : ''}</div>
        <div class="tiny muted">${games} · ${tips}</div></div>
      <span class="chip good">Pays ${F.x1(c.payout)}</span></div>
    <div class="pstats">
      <div class="bigstat" title="Correlated chance times the small extra factor from past seasons (how much more often parlays like these hit than the joint model expected, pooled over 2024-26)"><div class="k">Backtested</div><div class="v">${F.pct(c.p_bt)}</div></div>
      <div class="bigstat" title="The joint model: legs in the same game move together (teammates share shots, a fast game lifts everyone)"><div class="k">Correlated</div><div class="v">${F.pct(c.p_corr)}</div></div>
      <div class="bigstat" title="Every leg's chance multiplied, as if the legs had nothing to do with each other"><div class="k">Simple</div><div class="v">${F.pct(c.p_simple)}</div></div>
      <div class="bigstat" title="Chance that at most one leg misses. A parlay one leg short still pays $0; this shows how close it tends to run."><div class="k">≤ 1 miss</div><div class="v">${F.pct(c.p_one_away)}</div></div>
    </div>
    <div class="legs">${L.map((lg) => html`<${Leg} d=${d} lg=${lg} weakest=${L.length > 1 && lg.p === minP}/>`)}</div>
    <div class="payout-line">$10 returns <b>${F.money(10 * c.payout)}</b> if all ${c.k} hit · est. price ${F.odds(c.cost, 1)} incl. fee ·
      value at the backtested chance <b class=${c.ev >= 0 ? 'good' : 'bad'}>${F.signedPct(c.ev, 0)}</b>${isNum(c.p_form) ? ` · form-weighted chance ${F.pct(c.p_form)}` : ''}</div>
    <div class="row wrap" style="gap:8px"><button class="btn ghost sm" onClick=${() => setSlip(L.map((lg) => slipLeg(d, lg)))}>Load into combo slip</button>
      <span class="tiny muted">replaces what's in your slip; the slip checks the price on each venue</span></div>
    ${vars.length > 0 && html`<button class="btn ghost sm" style="align-self:flex-start" onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'} ${vars.length} similar variation${vars.length > 1 ? 's' : ''}</button>
      ${open && html`<div class="variations"><div class="tiny muted">Each shares ${c.k <= 4 ? 'all but one leg' : `${SIMILAR}+ legs`} with the parlay above; ranked the same way. Only the swapped legs are listed.</div>
        ${vars.slice(0, nv).map((v) => html`<${Variation} d=${d} c=${v} head=${c} legs=${legs}/>`)}
        ${vars.length > nv && html`<button class="btn ghost sm" onClick=${() => setNv(nv + 10)}>${Math.min(10, vars.length - nv)} more of ${vars.length - nv}</button>`}</div>`}`}
  </article>`;
}

function BacktestTable({ bt }) {
  const rows = (bt?.by || []).filter((r) => r.k !== 'all').concat((bt?.by || []).filter((r) => r.k === 'all'));
  if (!rows.length) return html`<div class="small muted">The backtest hasn't run yet.</div>`;
  return html`<div class="tablewrap flowt"><table class="t">
    <thead><tr><th>Season</th><th>Legs</th><th>Parlays</th><th>Actually hit</th><th>Simple</th><th class="hide-sm">Correlated</th><th>+ calibrated legs</th><th class="hide-sm">+ dependence</th><th class="hide-sm">≤ 1 miss (actual / predicted)</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr style=${r.k === 'all' ? 'font-weight:650' : ''}><td>${r.season}</td><td>${r.k === 'all' ? 'All' : r.k}</td>
      <td>${r.n.toLocaleString()} <span class="muted tiny hide-sm">(${r.dates} days)</span></td>
      <td><b>${F.pct(r.hit, 1)}</b> <span class="muted tiny hide-sm">${F.pct(r.hit_ci[0], 0)}–${F.pct(r.hit_ci[1], 0)}</span></td>
      <td>${F.pct(r.p_simple, 1)}</td><td class="hide-sm">${F.pct(r.p_corr, 1)}</td><td>${F.pct(r.p_legcal, 1)}</td><td class="hide-sm">${F.pct(r.p_bt, 1)}</td>
      <td class="hide-sm">${F.pct(r.one_away, 0)} / ${F.pct(r.p_one_away, 0)}</td></tr>`)}</tbody></table></div>`;
}

function Method({ data }) {
  const R = data.rules || {};
  const pr = (t, i, dflt) => R.tiers?.[t]?.payout?.[i] ?? dflt;
  const bt = data.backtest || {};
  const fe = data.form || {};
  const fit = bt.by?.find((r) => r.season === '2024-25' && r.k === 'all');
  const test = bt.by?.find((r) => r.season === '2025-26' && r.k === 'all');
  return html`<div style="margin-top:12px"><${S.Info} title="How these are built, and how well the chances held up">
    <ul style="margin:6px 0 0;padding-left:18px">
      <li><b>Two sizes.</b> <b>5–7 legs</b> from 1–3 games paying ${pr('main', 0, 4)}–${pr('main', 1, 7)}× (a ${pr('main', 0, 4) - 1}–${pr('main', 1, 7) - 1}× profit), your usual parlay. <b>Safer: 2–4 legs</b> from 1–2 games paying ${pr('safer', 0, 3)}–${pr('safer', 1, 5)}× (a ${pr('safer', 0, 3) - 1}–${pr('safer', 1, 5) - 1}× profit): the big ones tend to miss by a leg or two (see "≤ 1 miss"), and the safer tier is what's left when you drop those legs. Prices are the real Polymarket US prices plus the combo fee.</li>
      <li><b>Legs:</b> Overs and Unders you can put in a Polymarket US combo (an Under only where that market sells the No side in combos), each with a fair chance of ${F.pct(R.p_min)}–${F.pct(R.p_max)}, from a player whose side won in at least ${F.pct(R.form_min)} of his last 10 games (and has ${R.form_n}+ of them): cleared the line for an Over, stayed under it for an Under. A line under ${F.pct(R.low_p)} gets in only on a strong record, ${F.pct(R.low_form)}+ of his last 10. One rung and one side per player and stat (the 5–7 leg pool aims for about ${F.pct(R.tiers?.main?.target ?? 0.72)} a leg, the safer one about ${F.pct(R.tiers?.safer?.target ?? 0.66)}), at most two legs per player, and never PRA with its own points, rebounds or assists.</li>
      <li><b>Games:</b> every single game, every pair and (5–7 legs only) every triple on the slate, and each parlay uses all of its games. In a three-game parlay, one game gives at most 2 legs, each ${F.pct(R.anchor_p)}+ with an ${F.pct(R.anchor_form)}+ hit rate: the third game only gets in on legs you'd really like.</li>
      <li><b>Nothing hand-picked:</b> every combination of each group's best legs is scored; each group keeps up to ${R.per_k} per leg count that share at most all-but-two legs. Look-alikes (3+ identical legs, or all but one for 2–4 legs) fold under the best one.</li>
      <li><b>Ranking:</b> "Best value" sorts by expected return at the backtested chance; "Most likely" by the backtested chance; "Form-weighted" by expected return if the legs' form chances are right.</li>
      <li><b>Each leg's chance</b> is the site's fair chance: the model anchored on a real order book (Polymarket US, else Kalshi). Legs with no real book yet are left out, so the list grows through the afternoon as books fill.</li>
    </ul>
    <div style="font-weight:650;margin:14px 0 6px">Why not just multiply the legs?</div>
    <div class="small ink2">A parlay pays only if every leg hits, so a leg that misses by one rebound still loses it. Multiplying is right only if each leg's chance is right <i>and</i> the legs are unrelated. Two things break that, and the other chances fix them.
      <b>Correlated</b> lets legs in the same game move together. <b>Backtested</b> then scales it by how much more often parlays this builder picked in past seasons hit than the joint model expected${bt.dep_live ? ` (×${Object.entries(bt.dep_live).map(([k, v]) => `${v.toFixed(2)} at ${k} legs`).join(', ')})` : ''}. Tonight's legs use the fair chance, which is already fit to outcomes, so the per-leg correction found below isn't applied again. <b>≤ 1 miss</b> is how often it lands within one leg, which pays nothing but tells you how close it runs.</div>
    <div style="font-weight:650;margin:14px 0 6px">Backtest: did the chances hold up?</div>
    <div class="small ink2" style="margin-bottom:6px">The same builder on every past slate: out-of-sample model chances at Polymarket-style rungs${bt.proxy_margin ? `; old games have no Polymarket prices, so the payout band used each leg's chance + ${F.pct(bt.proxy_margin, 1)} as its price` : ''}. It checks how often the parlays hit, not profit. Parlays on the same night share legs, so the ranges resample whole game days.
      ${fit && test ? html` <b>Multiplying was too low</b>: in 2025-26 these parlays hit ${F.pct(test.hit, 1)} of the time against ${F.pct(test.p_simple, 1)} simple (n=${test.n.toLocaleString()} over ${test.dates} days). Most of the gap was the legs themselves: the model's chances ran low per leg (3–4% on Overs, less on Unders), and that compounds across 5–7 legs. With the legs calibrated (fit on 2024-25) the correlated chance was ${F.pct(test.p_legcal, 1)}, close to what happened. An extra "dependence" factor fit on 2024-25 (×${Object.values(bt.dep || {}).map((v) => v.toFixed(2)).join('/')}) overshot in 2025-26, so it didn't hold up; tonight's "Backtested" uses the small pooled factor only.` : ''}</div>
    <${BacktestTable} bt=${bt}/>
    ${(bt.by_mix || []).length > 0 && html`<div class="small ink2" style="margin-top:8px">2025-26 by side: ${bt.by_mix.map((m) => `${m.mix} hit ${F.pct(m.hit, 1)} vs ${F.pct(m.p_simple, 1)} simple and ${F.pct(m.p_legcal, 1)} with calibrated legs (n=${m.n.toLocaleString()})`).join('; ')}.</div>`}
    <div style="font-weight:650;margin:14px 0 6px">This season vs older games</div>
    <div class="small ink2">${fe.params ? html`Fit on 2023-25: a game's weight halves every ${fe.params.h} games and games from earlier seasons count ${F.pct(fe.params.lam)} as much as this season's; his record moves the chance at most ~${F.pct(1 / (1 + fe.params.A / 7.7), 0)}. On held-out 2025-26 it helped early in the season (log loss ${fe.early ? fe.early.d_ll.toFixed(4) : '—'}, range ${fe.early ? `${fe.early.ci[0].toFixed(4)} to ${fe.early.ci[1].toFixed(4)}` : '—'}, n=${fe.early?.n?.toLocaleString()}), but not clearly over the whole season (${fe.all ? `${fe.all.d_ll.toFixed(4)}, range up to ${fe.all.ci[1] >= 0 ? '+' : ''}${fe.all.ci[1].toFixed(4)}` : '—'}). The rule set before the test needed both, so leg chances stay the fair chance; the "form-weighted" chance and sort are there if you want to lean on it. There are no preseason games in the data.` : 'The form test hasn\'t run yet.'}</div>
  </${S.Info}></div>`;
}

export function YourStyle({ d }) {
  const data = useParlays(d.parlays?.computed_at || d.generated_at);
  const [grp, setGrp] = useState('all');
  const [k, setK] = useState('any');
  const [tier, setTier] = useState('all');
  const [ng, setNg] = useState('any');
  const [pay, setPay] = useState('any');
  const [near, setNear] = useState(false);
  const [sort, setSort] = useState('value');
  const [side, setSide] = useState('any');
  const [n, setN] = useState(PAGE);
  const list = data?.list || [];
  const groups = useMemo(() => {
    const seen = new Map();
    for (const c of list) {
      const key = [...c.games].sort((a, b) => String(tipOf(d, a)).localeCompare(String(tipOf(d, b)))).join(',');
      if (!seen.has(key)) seen.set(key, key.split(','));
    }
    return [...seen.entries()].sort((a, b) => a[1].length - b[1].length || String(tipOf(d, a[1][0])).localeCompare(String(tipOf(d, b[1][0]))));
  }, [list]);
  const shown = useMemo(() => {
    const [lo, hi] = PAY[pay];
    const rows = list.filter((c) => (grp === 'all' || [...c.games].sort().join(',') === grp.split(',').sort().join(','))
      && (tier === 'all' || tierOf(c) === tier) && (k === 'any' || c.k === +k) && (ng === 'any' || c.games.length === +ng)
      && c.payout >= lo && c.payout < hi && (!near || spanMin(d, c.games) <= 60)
      && (side === 'any' || c.legs.every((key) => sideOf(data.legs[key] || {}) === side)))
      .sort((a, b) => SORT[sort](a) - SORT[sort](b));
    // condense: the best parlay of each family of look-alikes (SIMILAR+ identical legs) leads, the rest sit under it
    const heads = [];
    for (const c of rows) {
      const h = heads.find((x) => similar(c, x.c));
      if (h) h.vars.push(c); else heads.push({ c, vars: [] });
    }
    return heads;
  }, [list, grp, k, ng, pay, near, sort, side, tier]);
  const nRows = shown.reduce((a, h) => a + 1 + h.vars.length, 0);
  useEffect(() => setN(PAGE), [grp, k, ng, pay, near, sort, side, tier]);
  const ks = tier === 'safer' ? [2, 3, 4] : tier === 'main' ? [5, 6, 7] : [2, 3, 4, 5, 6, 7];
  const pays = tier === 'safer' ? ['z', 'a'] : tier === 'main' ? ['a', 'b', 'c'] : ['z', 'a', 'b', 'c'];
  const PAYL = { z: '3–4×', a: '4–5×', b: '5–6×', c: '6–7×' };
  if (!data) return html`<div class="small muted">Loading…</div>`;
  return html`<div>
    <${StyleRecord} d=${d} compact=${true}/>
    <div class="toolbar wrap">
      <${S.Select} label="Games" value=${grp} onChange=${setGrp} options=${[['all', 'All game combos'], ...groups.map(([key, gs]) => [key, gs.map((g) => gameName(d, g)).join(' + ')])]}/>
      <${S.Seg} value=${ng} onChange=${setNg} options=${[['any', 'Any games'], ['1', '1'], ['2', '2'], ['3', '3']]}/>
      <${S.Seg} value=${tier} onChange=${(v) => { setTier(v); setK('any'); setPay('any'); }} options=${[['all', 'All sizes'], ['main', '5–7 legs'], ['safer', 'Safer 2–4']]}/>
      <${S.Seg} value=${k} onChange=${setK} options=${[['any', 'Any legs'], ...ks.map((x) => [String(x), String(x)])]}/>
      <${S.Seg} value=${pay} onChange=${setPay} options=${[['any', 'Any payout'], ...pays.map((x) => [x, PAYL[x]])]}/>
      <${S.Seg} value=${side} onChange=${setSide} options=${[['any', 'Overs + Unders'], ['over', 'Overs only'], ['under', 'Unders only']]}/>
      <${S.Switch} checked=${near} onChange=${setNear}>Same or back-to-back tips</${S.Switch}>
      <${S.Seg} value=${sort} onChange=${setSort} options=${[['value', 'Best value'], ['likely', 'Most likely'], ['form', 'Form-weighted']]}/>
    </div>
    <div class="small ink2" style="margin:4px 0 10px">${shown.length.toLocaleString()} distinct parlay${shown.length === 1 ? '' : 's'} (${nRows.toLocaleString()} with their variations${nRows !== list.length ? ` of ${list.length.toLocaleString()}` : ''})${data.computed_at ? ` · built ${F.ago(data.computed_at)}` : ''}</div>
    ${shown.length
      ? html`<div class="grid g3">${shown.slice(0, n).map((h, i) => html`<${Card} key=${h.c.id} d=${d} c=${h.c} vars=${h.vars} legs=${data.legs} rank=${i + 1}/>`)}</div>
        ${shown.length > n && html`<div class="row" style="margin-top:10px"><button class="btn ghost" onClick=${() => setN(n + PAGE)}>Show ${Math.min(PAGE, shown.length - n)} more</button></div>`}`
      : html`<${S.Empty} title=${list.length ? 'Nothing matches these filters' : 'No parlays of this kind right now'}>${list.length
        ? 'Try all sizes, more games, any leg count, or any payout.'
        : 'Each leg needs a fair chance from a real order book, and Polymarket US books fill up through the afternoon before tip. The list refreshes every few minutes.'}</${S.Empty}>`}
    <${Method} data=${data}/>
  </div>`;
}

// ===================================================================================== home: parlay-ready legs
const READY_SORT = {
  best: (a, b) => b.score - a.score,
  likely: (a, b) => b.p - a.p,
  steady: (a, b) => b.l10_hits / b.l10_n - a.l10_hits / a.l10_n || b.score - a.score,
  price: (a, b) => (b.p - b.price) - (a.p - a.price),
  tip: (a, b) => String(a.tip).localeCompare(String(b.tip)) || b.score - a.score,
};
const STAT_LABEL = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', fg3m: 'Threes', pra: 'Pts+Reb+Ast', stl: 'Steals', blk: 'Blocks' };

function ReadyCard({ d, lg, inParlays }) {
  const s = useSlip();
  const leg = slipLeg(d, lg);
  const on = s.some((x) => x.id === leg.id);
  const g = d.gameById?.[lg.game_id] || {};
  const tri = d.teams?.[lg.team_id]?.tri || '';
  const home = lg.team_id === g.home;
  const opp = d.tri ? d.tri(home ? g.away : g.home) : '';
  const go = () => S.goStat(lg.game_id, lg.player_id, lg.stat, lg.thr - 0.5);
  const over = lg.price - lg.p;
  const u = sideOf(lg) === 'under';
  return html`<article class=${`card click pick pick-${sideOf(lg)}`} onClick=${go} tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && go()}>
    <div class="pick-top"><span class="chip good">Parlay-ready</span>${lg.p < 0.65 ? html`<span class="chip ghost" title="Fair chance under 65%: in on his record (8+ of his last 10). Fits 2–4 leg combos.">Longer line · strong record</span>` : ''}<span class="spacer"></span><${S.VenueChip} v="us"/></div>
    <div><div class="pick-name">${lg.name} <span class="chip ghost">${UNIT[lg.stat]}</span></div>
      <div class="row small ink2" style="gap:6px;margin-top:4px"><${S.TeamChip} tri=${tri}/> ${home ? 'vs' : '@'} ${opp} · ${F.timeET(g.tip || lg.tip)}</div></div>
    <div class="bet"><span class="bet-side">${u ? 'UNDER' : 'OVER'} ${lg.thr - 0.5}</span> <span class="small ink2">${STAT_LABEL[lg.stat]}</span></div>
    <div class="bet-how">Buy ${u ? 'No' : 'Yes'} on ${lg.thr}+ on Polymarket US at ${F.odds(lg.price)} or better</div>
    <div class="stats3">
      <div class="stat" title=${`${SRC[lg.p_src] || 'fair'} · model alone ${F.pct(lg.model)}`}><div class="k">${F.oddsMode() === 'us' ? 'Fair line' : 'Fair chance'}</div><div class="v side"><${S.OddsV} p=${lg.p}/></div></div>
      <div class="stat"><div class="k">${F.oddsMode() === 'us' ? 'Price' : 'Price implies'}</div><div class="v"><${S.OddsV} p=${lg.price}/></div></div>
      <div class="stat" title=${u ? 'Games of his last 10 in which he stayed under this line' : 'Games of his last 10 in which he cleared this line'}><div class="k">Last 10</div><div class="v good">${lg.l10_hits}/${lg.l10_n}</div></div>
    </div>
    <div class="small ink2"><${Dots} lg=${lg}/> ${lg.season_n ? `${lg.season_hits}/${lg.season_n} this season` : 'no games this season yet'} · form-weighted ${F.pct(lg.p_form)}</div>
    <div class="pick-foot"><span>${over > 0.005 ? `costs ${F.pct(over, 1)} more than fair` : over < -0.005 ? `priced ${F.pct(-over, 1)} under fair` : 'priced at fair'}</span>
      ${inParlays > 0 && html`<span>· in ${inParlays} of tonight's Your-style parlays</span>`}<span class="spacer"></span>
      <button class=${`addbtn${on ? ' on' : ''}`} title=${on ? 'Remove from your combo slip' : 'Add to your combo slip'} onClick=${(e) => { e.stopPropagation(); toggleLeg(leg); }}>${on ? '✓' : '+ slip'}</button></div>
  </article>`;
}

export function ReadyLegs({ d }) {
  const data = useParlays(d.parlays?.computed_at || d.generated_at);
  const [game, setGame] = useState('all');
  const [stat, setStat] = useState('all');
  const [side, setSide] = useState('all');
  const [sort, setSort] = useState('best');
  const [n, setN] = useState(12);
  const ready = data?.ready || [];
  const uses = useMemo(() => {
    const c = {};
    for (const p of data?.list || []) for (const k of p.legs) c[k] = (c[k] || 0) + 1;
    return c;
  }, [data]);
  if (!data) return html`<div class="small muted">Loading…</div>`;
  const games = (d.games || []).filter((g) => ready.some((x) => x.game_id === g.id));
  const stats = [...new Set(ready.map((x) => x.stat))];
  const shown = ready.filter((x) => (game === 'all' || x.game_id === game) && (stat === 'all' || x.stat === stat)
    && (side === 'all' || sideOf(x) === side)).sort(READY_SORT[sort]);
  const R = data.ready_rules || {};
  const chk = data.ready_check?.rows || [];
  const row = (grp, season, early, sd = 'both') => chk.find((r) => r.group === grp && r.season === season && r.early === early
    && (r.side || 'both') === sd);
  const pO = row('passes the bar', '2025-26', false, 'over');
  const pU = row('passes the bar', '2025-26', false, 'under');
  const pass = row('passes the bar', '2025-26', false);
  const passE = row('passes the bar', '2025-26', true);
  const weak = row('same band, 5 or fewer of last 10', '2025-26', false);
  const pLow = row('passes, under 65%', '2025-26', false);
  const wLow = row('under 65%, 5 or fewer of last 10', '2025-26', false);
  return html`<div>
    ${ready.length > 0 && html`<div class="filters">
      <${S.Seg} value=${side} onChange=${setSide} options=${[['all', 'Overs + Unders'], ['over', 'Overs'], ['under', 'Unders']]}/>
      <${S.Select} label="Game" value=${game} onChange=${setGame} options=${[['all', 'All games'], ...games.map((g) => [g.id, `${d.tri(g.away)} @ ${d.tri(g.home)} · ${F.timeET(g.tip)}`])]}/>
      <${S.Select} label="Stat" value=${stat} onChange=${setStat} options=${[['all', 'All stats'], ...stats.map((x) => [x, STAT_LABEL[x]])]}/>
      <${S.Select} label="Sort" value=${sort} onChange=${setSort} options=${[['best', 'Sort: best for parlays'], ['likely', 'Sort: fair chance'], ['steady', 'Sort: most consistent'], ['price', 'Sort: best price'], ['tip', 'Sort: tip time']]}/>
      <span class="small muted">${shown.length} of ${ready.length}</span></div>`}
    ${shown.length
      ? html`<div class="grid g3">${shown.slice(0, n).map((lg) => html`<${ReadyCard} key=${lg.key} d=${d} lg=${lg} inParlays=${uses[lg.key] || 0}/>`)}</div>
        ${shown.length > n && html`<div class="row" style="margin-top:10px"><button class="btn ghost" onClick=${() => setN(n + 12)}>Show ${Math.min(12, shown.length - n)} more</button></div>`}`
      : html`<${S.Empty} title=${ready.length ? 'Nothing matches these filters' : 'No line passes the parlay-ready bar right now'}>${ready.length
        ? 'Try all games or all stats.'
        : 'Each line needs a fair chance from a real order book, and Polymarket US books fill up through the afternoon before tip. The list refreshes every few minutes; the Model picks tab is still there.'}</${S.Empty}>`}
    <div style="margin-top:12px"><${S.Info} title="The parlay-ready bar, and how lines like these did">
      <ul style="margin:6px 0 0;padding-left:18px">
        <li><b>Overs and Unders on Polymarket US</b> (an Under only where that market sells the No side in combos), with a fair chance from a real order book (the model anchored on the market). One side per player and stat.</li>
        <li><b>Fair chance ${F.pct(R.p_min)}–${F.pct(R.p_max)}</b>: from the 50s (a 2–3 leg combo needs legs like these to pay 3×+) to about 85%, past which a leg adds almost nothing to the payout.</li>
        <li><b>Consistent:</b> his side won (cleared the line for an Over, stayed under for an Under) in ${R.l10_min}+ of his last 10 games (${R.l10_n}+ played), and in ${F.pct(R.season_min)}+ of this season's games once he has ${R.season_n}. A line under ${F.pct(R.low_p)} needs ${R.low_l10_min}+ of 10: a near coin-flip price only earns a spot on a strong record.</li>
        <li><b>Fair price:</b> no more than ${F.pct(R.max_overpay)} above the fair chance. Overpaying compounds with every leg.</li>
        <li>Expected to play (not Questionable, Doubtful or Out), 15+ projected minutes. One line per player and stat: the one that scores best.</li>
        <li><b>Sorted by</b> his form-weighted chance (the fair chance nudged by his record, this season counting most) minus any overpay.</li>
      </ul>
      ${pass && html`<div class="small ink2" style="margin-top:10px"><b>Backtest</b> (every 2025-26 game, out-of-sample model chances at Polymarket-style rungs; the price check needs live books, so it's left out): lines passing this bar hit <b>${F.pct(pass.hit, 1)}</b> when the model said ${F.pct(pass.pred, 1)} (n=${pass.n.toLocaleString()}; range ${F.pct(pass.ci[0], 1)}–${F.pct(pass.ci[1], 1)})${passE ? `, and ${F.pct(passE.hit, 1)} vs ${F.pct(passE.pred, 1)} in the first 10 games of a season (n=${passE.n.toLocaleString()})` : ''}.${weak ? ` The same chance range from players who cleared it 5 or fewer times in 10 hit ${F.pct(weak.hit, 1)} vs ${F.pct(weak.pred, 1)} (n=${weak.n.toLocaleString()}): consistency carries information the model doesn't fully price.` : ''}${pO && pU ? ` By side: Overs ${F.pct(pO.hit, 1)} vs ${F.pct(pO.pred, 1)} (n=${pO.n.toLocaleString()}), Unders ${F.pct(pU.hit, 1)} vs ${F.pct(pU.pred, 1)} (n=${pU.n.toLocaleString()}).` : ''}${pLow ? ` The 55–65% lines that pass (8+ of 10) hit ${F.pct(pLow.hit, 1)} vs ${F.pct(pLow.pred, 1)} (n=${pLow.n.toLocaleString()})${wLow ? `; the same chances with 5 or fewer of 10 hit ${F.pct(wLow.hit, 1)} vs ${F.pct(wLow.pred, 1)}` : ''}.` : ''} That's hit rate, not profit, and it isn't proof of an edge against Polymarket's prices.</div>`}
    </${S.Info}></div>
  </div>`;
}

// ===================================================================================== track record of "your style"
const tierLine = (s) => ((s.by_tier || []).length > 1
  ? ` · ${s.by_tier.map((t) => `${TIER[t.tier]} ${t.wins}–${t.n - t.wins}`).join(', ')}` : '');
const RES = { win: ['good', 'Hit'], loss: ['bad', 'Missed'], void: ['ghost', 'Not counted'] };

// cumulative wins vs the wins the backtested chances expected, by slate day
function CumChart({ rows }) {
  const [tip, setTip] = useState(null);
  if (!rows?.length) return null;
  const W = 420, H = 220, L = 34, R = 74, T = 12, B = 30;
  const n = rows.length;
  const top = Math.max(1, ...rows.map((r) => Math.max(r.cum_wins, r.cum_expected)));
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => H - B - (v / top) * (H - B - T);
  const path = (k) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`).join(' ');
  const last = rows[n - 1];
  const ticks = [0, top / 2, top].map((v) => Math.round(v * 10) / 10);
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative hits versus expected hits">
      <g class="grid">${ticks.map((t) => html`<line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} />`)}</g>
      ${ticks.map((t) => html`<text x=${L - 6} y=${y(t) + 4} text-anchor="end">${t}</text>`)}
      <text x=${x(0)} y=${H - 10} text-anchor="start">${F.shortDate(F.dateKeyET(rows[0].date))}</text>
      ${n > 1 && html`<text x=${x(n - 1)} y=${H - 10} text-anchor="end">${F.shortDate(F.dateKeyET(last.date))} ${F.timeET(last.date)}</text>`}
      <path d=${path('cum_expected')} fill="none" stroke="var(--chart-axis)" stroke-width="2" stroke-dasharray="5 4" />
      <path d=${path('cum_wins')} fill="none" stroke="var(--brand)" stroke-width="2" />
      ${rows.map((r, i) => html`<circle cx=${x(i)} cy=${y(r.cum_wins)} r="4" fill="var(--brand)" stroke="var(--surface)" stroke-width="2" />`)}
      ${rows.map((r, i) => html`<rect x=${x(i) - 12} y=${T} width="24" height=${H - B - T} fill="transparent"
        onMouseEnter=${() => setTip({ x: x(i), y: y(r.cum_wins) - 10, text: `${F.shortDate(F.dateKeyET(r.date))} ${F.timeET(r.date)} tips: ${r.wins} of ${r.n} hit (expected ${r.expected.toFixed(1)}) · total ${r.cum_wins} vs ${r.cum_expected.toFixed(1)} expected` })}
        onMouseLeave=${() => setTip(null)} />`)}
      <text x=${x(n - 1) + 6} y=${y(last.cum_wins) + 4} style="fill:var(--ink)">Hits ${last.cum_wins}</text>
      <text x=${x(n - 1) + 6} y=${y(last.cum_expected) + (Math.abs(y(last.cum_expected) - y(last.cum_wins)) < 12 ? 16 : 4)} style="fill:var(--ink-2)">Expected ${last.cum_expected.toFixed(1)}</text>
    </svg>
    ${tip && html`<div class="tt" style=${`left:${(100 * tip.x) / W}%;top:${(100 * tip.y) / H}%`}>${tip.text}</div>`}
  </div>`;
}

function Tile({ k, v, sub, cls = '' }) {
  return html`<div class="bigstat"><div class="k">${k}</div><div class=${`v ${cls}`}>${v}</div>${sub && html`<div class="tiny muted">${sub}</div>`}</div>`;
}

function RecordDay({ d, date, rows }) {
  const [open, setOpen] = useState(null);
  const w = rows.filter((r) => r.result === 'win').length, l = rows.filter((r) => r.result === 'loss').length;
  const pend = rows.filter((r) => !r.result).length;
  return html`<div class="card pad" style="margin-top:10px">
    <div class="row wrap" style="gap:8px"><b>${F.shortDate(date)}</b><span class="small ink2">${rows.length} main combo${rows.length > 1 ? 's' : ''} · ${w}–${l}${pend ? ` · ${pend} pending` : ''}</span>${rows.some((r) => r.rebuilt) && html`<span class="chip ghost" title="Rebuilt from the lines frozen at each lock: same builder, Overs only as it ran then, only games locking in that batch">Rebuilt from lock-time lines</span>`}</div>
    <div class="tablewrap flowt" style="margin-top:8px;box-shadow:none"><table class="t"><thead><tr><th>Tip</th><th>Combo</th><th class="r hide-sm">Chance</th><th class="r hide-sm">Pays</th><th>Result</th><th class="r" title="How many of its similar variations (3+ shared legs) hit">Strength</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class="click" onClick=${() => setOpen(open === r.id ? null : r.id)}>
        <td class="small" style="white-space:normal">${F.timeET(r.first_tip)}<div class="tiny muted">#${r.rank}</div></td><td style="white-space:normal">${r.k} legs · ${r.n_games} game${r.n_games > 1 ? 's' : ''}${tierOf(r) === 'safer' ? html` <span class="chip ghost tiny">Safer</span>` : ''}<div class="tiny muted">${r.legs.filter((x) => x.result === 'win').length}/${r.k} legs won · ${F.pct(r.p_bt)} · pays ${F.x1(r.payout)}</div></td>
        <td class="r hide-sm">${F.pct(r.p_bt)}</td><td class="r hide-sm">${F.x1(r.payout)}</td>
        <td>${r.result ? html`<span class=${`chip ${RES[r.result][0]}`}>${RES[r.result][1]}</span>` : html`<span class="chip ghost">Pending</span>`}</td>
        <td class="r">${r.n_variations ? (r.var_graded ? html`<b>${r.var_hits}/${r.var_graded}</b> <span class="tiny muted">${F.pct(r.strength)}</span>` : html`<span class="muted">${r.n_variations} pending</span>`) : html`<span class="muted">no variations</span>`}</td></tr>
        ${open === r.id && html`<tr><td colspan="6"><div class="legs">${r.legs.map((x) => html`<div class="leg"><div><div class="who">${x.name} <span class=${x.side}>${x.side === 'under' ? 'Under' : 'Over'} ${x.thr - 0.5} ${UNIT[x.stat]}</span></div>
          <div class="what">fair ${F.pct(x.p)}${isNum(x.actual) ? ` · had ${x.actual}` : ''}</div></div>
          <div>${x.result ? html`<span class=${`chip ${RES[x.result][0]}`}>${x.result === 'win' ? 'Won' : x.result === 'loss' ? 'Lost' : 'Did not play'}</span>` : html`<span class="chip ghost">Pending</span>`}</div></div>`)}</div></td></tr>`}`)}</tbody></table></div>
  </div>`;
}

export function StyleRecord({ d, compact = false }) {
  const data = useParlays(d.parlays?.computed_at || d.generated_at);
  const s = data?.record;
  if (!data) return html`<div class="small muted">Loading…</div>`;
  if (!s || !s.n_logged) {
    return html`<div class="note">Tracking starts with the next slate. When a combo's first game reaches its lock (${d.settings?.decision_lead_min ?? 20} minutes before tip), every Your-style combo for it is frozen: the best of each group of look-alikes as a <b>main combo</b>, the rest as its variations. Each main combo is then graded from the box score.</div>`;
  }
  const g = s.n_graded > 0;
  const hve = s.hits_vs_expected;
  if (compact) {
    return html`<div class="note" style="margin-bottom:10px"><b>Track record so far:</b> ${g ? html`${s.wins}–${s.losses} on main combos (${F.pct(s.hit_rate, 1)} hit vs ${F.pct(s.expected, 1)} expected; ${hve.toFixed(2)}× the expected hits)${isNum(s.strength) ? ` · variations hit ${F.pct(s.strength)} on average` : ''}${tierLine(s)}` : `${s.n_logged} main combos logged, none graded yet`}${s.pending ? ` · ${s.pending} pending` : ''}. <a href="#/record">Full record →</a></div>`;
  }
  const byDay = {};
  for (const r of s.recent || []) (byDay[r.date] ||= []).push(r);
  return html`<div>
    ${g ? html`<div class="pstats rec">
      <${Tile} k="Main combos" v=${`${s.wins}–${s.losses}`} sub=${`${s.n_graded} graded${s.pending ? ` · ${s.pending} pending` : ''}${s.void ? ` · ${s.void} not counted` : ''}${s.n_rebuilt ? ` · ${s.n_rebuilt} rebuilt` : ''}`}/>
      <${Tile} k="Hits vs expected" v=${`${hve.toFixed(2)}×`} sub=${`${s.wins} hits, ${s.expected_wins.toFixed(1)} expected`} cls=${hve >= 1 ? 'good' : ''}/>
      <${Tile} k="Hit rate" v=${F.pct(s.hit_rate, 1)} sub=${`predicted ${F.pct(s.expected, 1)}${s.hit_ci ? ` · range ${F.pct(s.hit_ci[0], 0)}–${F.pct(s.hit_ci[1], 0)}` : ''}`}/>
      <${Tile} k="Strength" v=${isNum(s.strength) ? F.pct(s.strength) : '—'} sub=${`variations that hit, avg over ${s.strength_n} mains`}/>
      <${Tile} k="Beats multiplying?" v=${isNum(s.skill_vs_simple) ? F.signedPct(s.skill_vs_simple, 0) : '—'} sub="Brier skill of the backtested chance vs the simple product" cls=${s.skill_vs_simple > 0 ? 'good' : s.skill_vs_simple < 0 ? 'bad' : ''}/>
      <${Tile} k="Legs" v=${F.pct(s.legs_hit, 1)} sub=${`won, vs ${F.pct(s.legs_p, 1)} predicted (n=${s.legs_n})`}/>
      <${Tile} k="≤ 1 miss" v=${F.pct(s.one_away)} sub=${`predicted ${F.pct(s.p_one_away)}`}/>
      <${Tile} k="Return per $1" v=${F.signedPct(s.roi, 0)} sub=${`at the estimated price · avg pays ${F.x1(s.avg_payout)}`} cls=${s.roi >= 0 ? 'good' : 'bad'}/>
    </div>
    <div class="grid g2" style="margin-top:12px">
      <div class="card chartcard"><h3>Hits vs expected, cumulative</h3><p class="cap">Main combos that hit (solid) against the sum of their backtested chances (dashed), one step per lock. Tracking each other means the chances are honest; a line above means better than predicted.</p><${CumChart} rows=${s.cumulative}/></div>
      <div class="card chartcard"><h3>Are the leg chances honest?</h3><p class="cap">Every leg of the graded main combos, by its fair chance.</p>${(s.leg_calibration || []).length ? html`<${C.Reliability} rows=${s.leg_calibration} xLabel="Fair chance" yLabel="Won"/>` : html`<div class="small muted">Needs a few more graded legs.</div>`}</div>
    </div>
    ${(s.by_tier || []).length > 1 && html`<div class="small ink2" style="margin-top:8px">By size: ${s.by_tier.map((t) => `${TIER[t.tier]} ${t.wins}–${t.n - t.wins} (${F.pct(t.hit_rate, 0)} hit vs ${F.pct(t.expected, 0)} expected, return ${F.signedPct(t.roi, 0)})`).join(' · ')}</div>`}` : html`<div class="note">${s.n_logged} main combos logged${s.pending ? `, ${s.pending} waiting for their games to finish` : ''}. Numbers appear once the first ones are graded.</div>`}
    ${Object.entries(byDay).map(([date, rows]) => html`<${RecordDay} d=${d} date=${date} rows=${rows}/>`)}
    <div class="small muted" style="margin-top:8px">How it's measured:
      <ul style="margin:4px 0 0;padding-left:18px">
        <li><b>Frozen at lock</b>: when a combo's first game is ${d.settings?.decision_lead_min ?? 20} minutes from tip, every Your-style combo for it is saved as it stood, never edited. The best of each group of look-alikes (3+ identical legs) is the <b>main combo</b>; only mains count in the record, so a night with many near-copies counts each idea once.</li>
        <li><b>Graded</b> from the box score: a leg wins or loses by its side. If a player doesn't play the combo is "not counted" (Polymarket settles that leg at its last price, so the payout changes).</li>
        <li><b>Strength</b> of a main combo: the share of its variations that also hit. A miss with a strong family was a near idea; a hit with a weak family was a lucky pick of legs.</li>
        <li><b>Hits vs expected</b>: actual hits divided by the sum of the backtested chances (1.00× = honest chances). <b>Beats multiplying</b>: how much smaller the backtested chance's squared error is than the simple product's. <b>Return</b> uses the estimated combo price; the app's real quote can differ.</li>
        ${s.n_rebuilt > 0 && html`<li><b>Rebuilt</b> nights (marked): the combo lists weren't saved at lock yet, so they were rebuilt from every line frozen at each lock, with the same builder as it ran then (Overs only), using only the games locking in that batch (no later prices or injury news) and the logged quotes. Live freezing takes over from Oct 29.</li>`}
        <li>Combos are long shots (about 1 in 5), so a few weeks of slates are needed before any of this means much. The ranges resample whole slate days.</li>
      </ul></div>
  </div>`;
}
