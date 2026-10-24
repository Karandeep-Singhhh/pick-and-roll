// Small SVG chart components (Preact + htm). Colors come from CSS variables so light/dark both work.
import { html, useState } from '../vendor/preact-htm.mjs';
import { pct, isNum } from './fmt.js';

const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const step = v <= 10 ? 2 : v <= 25 ? 5 : v <= 50 ? 10 : 20;
  return Math.ceil(v / step) * step;
};
const ticks = (max, n = 4) => {
  const step = niceMax(max / n) || 1;
  const out = [];
  for (let t = 0; t <= max + 1e-9; t += step) out.push(t);
  return out;
};

function Tip({ tip, W, H }) {
  if (!tip) return null;
  return html`<div class="tt" style=${`left:${(tip.x / W) * 100}%;top:${(tip.y / H) * 100}%`}>${tip.text}</div>`;
}

// ---------------------------------------------------------------- mini projection range (cards)
export function MiniRange({ q, line, side }) {
  if (!q || !isNum(q[2])) return null;
  const W = 260, H = 34;
  const max = Math.max(q[4], line || 0) * 1.12 + 2;
  const x = lin(0, max, 6, W - 6);
  const color = side === 'over' ? 'var(--over)' : 'var(--under)';
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label=${`Projection ${q[2]} points, 80% range ${q[0]} to ${q[4]}, line ${line}`}>
    <line x1="6" x2=${W - 6} y1="20" y2="20" stroke="var(--line)" stroke-width="2" stroke-linecap="round" />
    <line x1=${x(q[0])} x2=${x(q[4])} y1="20" y2="20" stroke=${color} stroke-opacity=".45" stroke-width="2.5" stroke-linecap="round" />
    <rect x=${x(q[1])} y="15" width=${Math.max(2, x(q[3]) - x(q[1]))} height="10" rx="5" fill=${color} fill-opacity=".28" />
    <circle cx=${x(q[2])} cy="20" r="5" fill=${color} stroke="var(--surface)" stroke-width="2" />
    ${isNum(line) && html`<g>
      <line x1=${x(line)} x2=${x(line)} y1="9" y2="31" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round" />
      <text x=${x(line)} y="7" text-anchor="middle" style="font-size:10px;fill:var(--ink-2);font-weight:600">${line}</text>
    </g>`}
  </svg>`;
}

// ---------------------------------------------------------------- ladder: P(over) by line, fair vs model vs market
export function Ladder({ rows, sel }) {
  const [tip, setTip] = useState(null);
  if (!rows?.length) return null;
  const W = 560, H = 250, L = 40, R = 14, T = 12, B = 30;
  const x = (i) => L + ((i + 0.5) / rows.length) * (W - L - R);
  const y = lin(0, 1, H - B, T);
  const path = (key) => rows.map((r, i) => (isNum(r[key]) ? `${i && isNum(rows[i - 1][key]) ? 'L' : 'M'}${x(i)},${y(r[key])}` : '')).join('');
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Chance of going over each line">
      <g class="grid">${[0, 0.25, 0.5, 0.75, 1].map((t) => html`<line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} />`)}</g>
      ${[0, 0.5, 1].map((t) => html`<text x=${L - 6} y=${y(t) + 4} text-anchor="end">${pct(t)}</text>`)}
      ${rows.map((r, i) => r.line === sel && html`<rect x=${x(i) - 16} y=${T} width="32" height=${H - B - T} rx="8" fill="var(--sunken)" />`)}
      <path d=${path('model')} fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="4 4" />
      <path d=${path('fair')} fill="none" stroke="var(--over)" stroke-width="2.4" stroke-linejoin="round" />
      ${rows.map((r, i) => html`<g>
        ${isNum(r.bid) && isNum(r.ask) && html`<line x1=${x(i)} x2=${x(i)} y1=${y(r.bid)} y2=${y(r.ask)} stroke="var(--ink-2)" stroke-width="1.5" />`}
        ${isNum(r.mid) && html`<rect x=${x(i) - 5} y=${y(r.mid) - 5} width="10" height="10" transform=${`rotate(45 ${x(i)} ${y(r.mid)})`} fill="var(--ink-2)" stroke="var(--surface)" stroke-width="1.5" />`}
        ${isNum(r.fair) && html`<circle cx=${x(i)} cy=${y(r.fair)} r="5" fill="var(--over)" stroke="var(--surface)" stroke-width="2" />`}
        <rect x=${x(i) - 18} y=${T} width="36" height=${H - B - T} fill="transparent"
          onMouseEnter=${() => setTip({ x: x(i), y: y(Math.max(r.fair || 0, r.mid || 0)) - 8, text: `Over ${r.line}: fair ${pct(r.fair)} · market ${pct(r.mid)} · model alone ${pct(r.model)}` })}
          onMouseLeave=${() => setTip(null)} />
        <text x=${x(i)} y=${H - 10} text-anchor="middle" style=${r.line === sel ? 'fill:var(--ink);font-weight:700' : ''}>${r.line}</text>
      </g>`)}
    </svg>
    <${Tip} tip=${tip} W=${W} H=${H} />
    <div class="legend"><span><i style="background:var(--over)"></i>Fair chance</span><span><i style="background:var(--ink-2);transform:rotate(45deg)"></i>Market (bar = bid–ask)</span><span><i style="background:transparent;border:1.5px dashed var(--muted)"></i>Model alone</span></div>
  </div>`;
}

// ---------------------------------------------------------------- points distribution
export function Dist({ cdf, line, q }) {
  const [tip, setTip] = useState(null);
  if (!cdf?.length) return null;
  const pmf = cdf.map((c, k) => c - (k ? cdf[k - 1] : 0));
  const W = 560, H = 250, L = 40, R = 10, T = 12, B = 30;
  const n = pmf.length;
  const ymax = Math.max(...pmf) * 1.12;
  const x = lin(-0.5, n - 0.5, L, W - R);
  const y = lin(0, ymax, H - B, T);
  const bw = Math.max(1, (W - L - R) / n - 2);
  const pOver = 1 - (cdf[Math.floor(line)] ?? 1);
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Points distribution">
      <rect x=${x(q[0] - 0.5)} y=${T} width=${x(q[4] + 0.5) - x(q[0] - 0.5)} height=${H - B - T} fill="var(--sunken)" />
      ${pmf.map((v, k) => html`<rect x=${x(k) - bw / 2} y=${y(v)} width=${bw} height=${Math.max(0, H - B - y(v))} rx="1.5"
          fill=${k > line ? 'var(--over)' : 'var(--neutral-bar)'}
          onMouseEnter=${() => setTip({ x: x(k), y: y(v) - 6, text: `${k} pts: ${pct(v, 1)}` })} onMouseLeave=${() => setTip(null)} />`)}
      <line x1=${x(line)} x2=${x(line)} y1=${T} y2=${H - B} stroke="var(--ink)" stroke-width="2" />
      <text x=${x(line) + 5} y=${T + 10} style="fill:var(--ink);font-weight:600">line ${line}</text>
      <line class="axis" x1=${L} x2=${W - R} y1=${H - B} y2=${H - B} />
      ${ticks(n - 1, 5).map((t) => html`<text x=${x(t)} y=${H - 10} text-anchor="middle">${t}</text>`)}
    </svg>
    <${Tip} tip=${tip} W=${W} H=${H} />
    <div class="legend"><span><i style="background:var(--neutral-bar)"></i>${line} or fewer: ${pct(1 - pOver)}</span><span><i style="background:var(--over)"></i>Over ${line}: ${pct(pOver)}</span><span><i style="background:var(--sunken);border:1px solid var(--line-2)"></i>80% range ${q[0]}–${q[4]}</span></div>
  </div>`;
}

// ---------------------------------------------------------------- recent games vs tonight's line
export function Recent({ games, line, q }) {
  const [tip, setTip] = useState(null);
  if (!games?.length) return null;
  const W = 1000, H = 260, L = 34, R = 10, T = 14, B = 40;
  const items = [...games.map((g) => ({ label: g[1], date: g[0], pts: g[2], min: g[3] })), { tonight: true, pts: q[2] }];
  const ymax = niceMax(Math.max(line, q[4], ...games.map((g) => g[2] || 0)) * 1.08);
  const x = (i) => L + ((i + 0.5) / items.length) * (W - L - R);
  const y = lin(0, ymax, H - B, T);
  const bw = Math.min(34, ((W - L - R) / items.length) * 0.66);
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Points in recent games versus tonight's line">
      <g class="grid">${ticks(ymax, 4).map((t) => html`<line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} />`)}</g>
      ${ticks(ymax, 4).map((t) => html`<text x=${L - 6} y=${y(t) + 4} text-anchor="end">${t}</text>`)}
      ${items.map((it, i) => it.tonight
        ? html`<g>
            <rect x=${x(i) - bw / 2} y=${y(it.pts)} width=${bw} height=${H - B - y(it.pts)} rx="4" fill="var(--brand)" fill-opacity=".22" stroke="var(--brand)" stroke-dasharray="3 3" />
            <line x1=${x(i)} x2=${x(i)} y1=${y(q[4])} y2=${y(q[0])} stroke="var(--brand)" stroke-width="2" />
            <text x=${x(i)} y=${H - 22} text-anchor="middle" style="fill:var(--ink);font-weight:600">Tonight</text>
            <text x=${x(i)} y=${H - 8} text-anchor="middle">proj</text>
            <rect x=${x(i) - bw / 2 - 3} y=${T} width=${bw + 6} height=${H - B - T} fill="transparent"
              onMouseEnter=${() => setTip({ x: x(i), y: y(q[4]) - 6, text: `Tonight: median ${q[2]} (80%: ${q[0]}–${q[4]})` })} onMouseLeave=${() => setTip(null)} />
          </g>`
        : html`<g>
            <rect x=${x(i) - bw / 2} y=${y(it.pts)} width=${bw} height=${Math.max(0, H - B - y(it.pts))} rx="4"
              fill=${it.pts > line ? 'var(--over)' : 'var(--neutral-bar)'} />
            <text x=${x(i)} y=${H - 22} text-anchor="middle">${it.date.slice(5).replace('-', '/')}</text>
            <text x=${x(i)} y=${H - 8} text-anchor="middle">${it.label}</text>
            <rect x=${x(i) - bw / 2 - 3} y=${T} width=${bw + 6} height=${H - B - T} fill="transparent"
              onMouseEnter=${() => setTip({ x: x(i), y: y(it.pts) - 6, text: `${it.date} ${it.label}: ${it.pts} pts in ${Math.round(it.min)} min` })} onMouseLeave=${() => setTip(null)} />
          </g>`)}
      <line x1=${L} x2=${W - R} y1=${y(line)} y2=${y(line)} stroke="var(--ink)" stroke-width="1.6" stroke-dasharray="6 5" />
      <text x=${L + 4} y=${y(line) - 5} style="fill:var(--ink);font-weight:600">line ${line}</text>
    </svg>
    <${Tip} tip=${tip} W=${W} H=${H} />
    <div class="legend"><span><i style="background:var(--over)"></i>Over ${line}</span><span><i style="background:var(--neutral-bar)"></i>Under ${line}</span><span><i style="background:var(--brand);opacity:.6"></i>Tonight: median & 80% range</span></div>
  </div>`;
}

// ---------------------------------------------------------------- waterfall: how the projection is built
export function Waterfall({ base, groups, total, unit = 'pts' }) {
  const [tip, setTip] = useState(null);
  if (!isNum(base) || !groups) return null;
  const items = Object.entries(groups).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const rows = [{ name: 'Typical player', v: base, kind: 'total', start: 0 }];
  let run = base;
  for (const [k, v] of items) { rows.push({ name: k, v, kind: 'step', start: run }); run += v; }
  rows.push({ name: 'Projection', v: total, kind: 'total', start: 0 });
  const W = 560, rowH = 28, L = 210, R = 46, T = 6;
  const H = T + rows.length * rowH + 22;
  const max = niceMax(Math.max(...rows.map((r) => (r.kind === 'total' ? r.v : r.start + Math.max(0, r.v)))) * 1.05);
  const x = lin(0, max, L, W - R);
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="How the projection is built">
      <g class="grid">${ticks(max, 4).map((t) => html`<line x1=${x(t)} x2=${x(t)} y1=${T} y2=${H - 22} />`)}</g>
      ${ticks(max, 4).map((t) => html`<text x=${x(t)} y=${H - 6} text-anchor="middle">${t}</text>`)}
      ${rows.map((r, i) => {
        const y0 = T + i * rowH + 5;
        const a = r.kind === 'total' ? x(0) : x(Math.min(r.start, r.start + r.v));
        const b = r.kind === 'total' ? x(r.v) : x(Math.max(r.start, r.start + r.v));
        const fill = r.kind === 'total' ? 'var(--neutral-bar)' : r.v >= 0 ? 'var(--over)' : 'var(--under)';
        const label = r.kind === 'total' ? r.v.toFixed(1) : `${r.v >= 0 ? '+' : '−'}${Math.abs(r.v).toFixed(1)}`;
        return html`<g onMouseEnter=${() => setTip({ x: b, y: y0, text: `${r.name}: ${label} ${unit}` })} onMouseLeave=${() => setTip(null)}>
          <text x=${L - 8} y=${y0 + 13} text-anchor="end" style=${r.kind === 'total' ? 'fill:var(--ink);font-weight:600' : 'fill:var(--ink-2)'}>${r.name.replace(' (pace, total, blowout)', '')}</text>
          <rect x=${a} y=${y0} width=${Math.max(1.5, b - a)} height=${rowH - 10} rx="3" fill=${fill} />
          <text x=${b + 5} y=${y0 + 13} style="fill:var(--ink-2)">${label}</text>
        </g>`;
      })}
    </svg>
    <${Tip} tip=${tip} W=${W} H=${H} />
  </div>`;
}

// ---------------------------------------------------------------- reliability (predicted vs actual)
export function Reliability({ rows, xLabel = 'Predicted', yLabel = 'Actually happened' }) {
  const [tip, setTip] = useState(null);
  if (!rows?.length) return null;
  const W = 420, H = 300, L = 44, R = 12, T = 12, B = 40;
  const x = lin(0, 1, L, W - R), y = lin(0, 1, H - B, T);
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted versus actual">
      <g class="grid">${[0, 0.25, 0.5, 0.75, 1].map((t) => html`<g><line x1=${x(t)} x2=${x(t)} y1=${T} y2=${H - B} /><line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} /></g>`)}</g>
      ${[0, 0.5, 1].map((t) => html`<g><text x=${x(t)} y=${H - B + 16} text-anchor="middle">${pct(t)}</text><text x=${L - 6} y=${y(t) + 4} text-anchor="end">${pct(t)}</text></g>`)}
      <line x1=${x(0)} y1=${y(0)} x2=${x(1)} y2=${y(1)} stroke="var(--chart-axis)" stroke-width="1.5" stroke-dasharray="5 5" />
      ${rows.map((r) => isNum(r.lo) && html`<line x1=${x(r.p)} x2=${x(r.p)} y1=${y(r.lo)} y2=${y(r.hi)} stroke="var(--over)" stroke-width="1.5" />`)}
      ${rows.map((r) => html`<circle cx=${x(r.p)} cy=${y(r.h)} r=${Math.max(4, Math.min(9, Math.sqrt(r.n || 1) / 3))} fill="var(--over)" stroke="var(--surface)" stroke-width="2"
          onMouseEnter=${() => setTip({ x: x(r.p), y: y(r.h) - 10, text: `said ${pct(r.p)} → happened ${pct(r.h)} (n=${r.n ?? '?'})` })} onMouseLeave=${() => setTip(null)} />`)}
      <text x=${(L + W - R) / 2} y=${H - 6} text-anchor="middle" style="fill:var(--ink-2)">${xLabel}</text>
      <text transform=${`translate(12 ${(T + H - B) / 2}) rotate(-90)`} text-anchor="middle" style="fill:var(--ink-2)">${yLabel}</text>
    </svg>
    <${Tip} tip=${tip} W=${W} H=${H} />
  </div>`;
}

// ---------------------------------------------------------------- bars with confidence intervals (ROI etc.)
export function BarsCI({ rows, fmt = (v) => pct(v, 1), zero = true }) {
  const [tip, setTip] = useState(null);
  if (!rows?.length) return null;
  const W = 520, H = 230, L = 46, R = 10, T = 12, B = 34;
  const vals = rows.flatMap((r) => [r.v, r.lo, r.hi].filter(isNum));
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.1 || 0.05;
  const y = lin(lo - pad, hi + pad, H - B, T);
  const x = (i) => L + ((i + 0.5) / rows.length) * (W - L - R);
  const bw = Math.min(46, ((W - L - R) / rows.length) * 0.55);
  const tk = [lo - pad, 0, hi + pad].filter((v, i, a) => a.indexOf(v) === i);
  return html`<div class="relpos">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
      <g class="grid">${tk.map((t) => html`<line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} />`)}</g>
      ${tk.map((t) => html`<text x=${L - 6} y=${y(t) + 4} text-anchor="end">${fmt(t)}</text>`)}
      ${zero && html`<line x1=${L} x2=${W - R} y1=${y(0)} y2=${y(0)} stroke="var(--ink-2)" stroke-width="1.2" />`}
      ${rows.map((r, i) => html`<g onMouseEnter=${() => setTip({ x: x(i), y: y(Math.max(r.v, r.hi ?? r.v)) - 8, text: `${r.label}: ${fmt(r.v)}${isNum(r.lo) ? ` (95% CI ${fmt(r.lo)} to ${fmt(r.hi)})` : ''}${r.n ? `, n=${r.n}` : ''}` })} onMouseLeave=${() => setTip(null)}>
        <rect x=${x(i) - bw / 2} y=${Math.min(y(0), y(r.v))} width=${bw} height=${Math.abs(y(0) - y(r.v))} rx="3" fill=${r.v >= 0 ? 'var(--good)' : 'var(--neutral-bar)'} />
        ${isNum(r.lo) && html`<line x1=${x(i)} x2=${x(i)} y1=${y(r.lo)} y2=${y(r.hi)} stroke="var(--ink-2)" stroke-width="1.4" />`}
        <text x=${x(i)} y=${H - 12} text-anchor="middle">${r.label}</text>
      </g>`)}
    </svg>
    <${Tip} tip=${tip} W=${W} H=${H} />
  </div>`;
}
