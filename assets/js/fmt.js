// Formatting helpers + small static tables (team colors, glossary).

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const pct = (p, d = 0) => (isNum(p) ? `${(100 * p).toFixed(d)}%` : '—');
export const american = (p) => {
  if (!isNum(p) || p <= 0 || p >= 1) return '—';
  return p >= 0.5 ? `${Math.round((-100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`;
};
// ---------------------------------------------------------------- odds display (each viewer picks one)
// 'pct' = the chance a price implies (54%), 'us' = American odds (−117), 'both'. Edges are in percentage points of
// chance in % mode and shown as the fair line next to the price in US-odds mode.
const ODDS_KEY = 'pr_odds_v1';
let ODDS = (() => {
  try { const v = JSON.parse(localStorage.getItem(ODDS_KEY)); return ['pct', 'us', 'both'].includes(v) ? v : 'both'; } catch { return 'both'; }
})();
export const ODDS_OPTIONS = [['pct', '%'], ['us', 'US odds'], ['both', 'Both']];
export const oddsMode = () => ODDS;
export const setOddsMode = (m) => { ODDS = m; try { localStorage.setItem(ODDS_KEY, JSON.stringify(m)); } catch { /* private mode */ } };
const chance = (p, d) => pct(p, d ?? (p < 0.1 || p > 0.9 ? 1 : 0));
/** a price (or any probability) in the viewer's format: 54% · −117 */
export const odds = (p, d) => {
  if (!isNum(p)) return '—';
  if (ODDS === 'pct') return chance(p, d);
  if (ODDS === 'us') return american(p);
  return `${chance(p, d)} · ${american(p)}`;
};
export const price = (p) => odds(p);
/** fair chance minus the all-in price: +1.5% (points of chance), or the fair line in US-odds mode */
export const edge = (e, fair, d = 1) => {
  if (!isNum(e)) return '—';
  const pts = `${e >= 0 ? '+' : '−'}${Math.abs(100 * e).toFixed(d)}%`;
  const line = isNum(fair) && fair > 0 && fair < 1 ? `fair ${american(fair)}` : null;
  if (ODDS === 'pct' || !line) return pts;
  return ODDS === 'us' ? line : `${pts} · ${line}`;
};
/** parse what a viewer types as a quote: 52 / 52% (chance), −110 / +120 (American), 0.52 */
export const parseOdds = (s) => {
  const t = String(s ?? '').trim().replace('−', '-').replace('%', '');
  if (!t) return null;
  const x = Number(t);
  if (!Number.isFinite(x)) return null;
  if (/^[+-]/.test(t) || Math.abs(x) >= 100) return x < 0 ? -x / (-x + 100) : (x > 0 ? 100 / (x + 100) : null);
  if (x > 0 && x < 1) return x;
  return x > 0 && x < 100 ? x / 100 : null;
};
export const signedPct = (x, d = 1) => {
  if (!isNum(x)) return '—';
  const t = Math.abs(100 * x).toFixed(d);
  return `${+t === 0 ? '' : x > 0 ? '+' : '−'}${t}%`;  // a value that rounds to zero shows as 0.0%, not −0.0%
};
export const money = (x) => (isNum(x) ? `$${x.toFixed(2)}` : '—');
export const money0 = (x) => (isNum(x) ? `$${Math.round(x).toLocaleString()}` : '—');
export const x1 = (x) => (isNum(x) ? `${x.toFixed(x >= 10 ? 0 : 1)}×` : '—');
export const sideWord = (s) => (s === 'over' ? 'Over' : 'Under');
export const SIDE_UP = (s) => (s === 'over' ? 'OVER' : 'UNDER');

const ET = 'America/New_York';
export const timeET = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }) : '—';
export const dayET = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric' }) : '—';
export const longDayET = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: ET, weekday: 'long', month: 'long', day: 'numeric' }) : '—';
export const dateKeyET = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: ET });
export const minsSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : null);
export const ago = (iso) => {
  const m = minsSince(iso);
  if (m == null) return 'never';
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};
export const shortDate = (d) => {
  const t = new Date(`${String(d).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(t.getTime())) return String(d ?? '—');
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// Team colors (primary), used only for small identity chips.
export const TEAM_COLORS = {
  ATL: '#c8102e', BOS: '#007a33', BKN: '#111111', CHA: '#1d1160', CHI: '#ce1141', CLE: '#860038', DAL: '#00538c',
  DEN: '#0e2240', DET: '#c8102e', GSW: '#1d428a', HOU: '#ce1141', IND: '#002d62', LAC: '#1d428a', LAL: '#552583',
  MEM: '#5d76a9', MIA: '#98002e', MIL: '#00471b', MIN: '#0c2340', NOP: '#0c2340', NYK: '#006bb6', OKC: '#007ac1',
  ORL: '#0077c0', PHI: '#006bb6', PHX: '#1d1160', POR: '#c8102e', SAC: '#5a2d81', SAS: '#3f4448', TOR: '#ce1141',
  UTA: '#002b5c', WAS: '#002b5c',
};
export const teamColor = (tri) => TEAM_COLORS[tri] || '#555';

// edge size (how far the fair chance is from the price), not a quality rating: not yet shown to pick winners
export const STRENGTH_WORD = ['', 'Small edge', 'Small edge', 'Medium edge', 'Large edge', 'Largest edge'];

export const FLAG_TEXT = {
  wide: 'Wide spread', stale: 'Old price', 'one-sided': 'One-sided book', crossed: 'Price glitch',
  tail: 'Long shot / heavy favorite', OUT: 'Listed OUT',
};

export const GLOSSARY = [
  ['Line', "The points threshold. In the Polymarket US app, '25+ points' is the same bet as Over 24.5; buying No on it is Under 24.5."],
  ['Fair chance', "Our best estimate that a side wins, assuming the player plays. It starts from the market price and adjusts it with the model and a known market bias (Overs tend to be overpriced). This is the number every pick and combo is built on."],
  ['Model alone', "What the model would say ignoring the price. Shown for transparency; on its own it's overconfident exactly where it disagrees with the market."],
  ['Price', "What a bet costs, shown as the chance it implies (40% is the same as +150 in US odds; 60% is −150). Switch between %, US odds or both at the top of the page. Prices include the venue's fee."],
  ['Edge', 'Fair chance minus the chance the price implies (fee included), in percentage points: +2% means the bet should win 2 points more often than its price assumes. In US-odds mode it shows the fair line next to the price instead. Small, but that is what real edges look like.'],
  ['Strength', 'How much a pick is worth to a bankroll over time (expected growth at the Kelly stake), on a 1–5 scale. It weighs both the edge and how likely the bet is to win.'],
  ['Projection & range', "The model's median points, and the range it expects 8 times out of 10 (10th–90th percentile)."],
  ['Chance he plays', 'From the official injury report: how often players with that status have actually played.'],
  ['Combo', "A parlay: every leg must win, and any losing leg pays $0. Combos multiply the chances AND the house's margin, so they need legs with real value. If a player doesn't take part, that leg settles at its last fair price and the payout shrinks."],
  ['Pays', 'What a winning combo returns per $1 staked (before fees are taken from the price).'],
  ['Stake', 'A suggested bet size as a % of your bankroll: a quarter of the Kelly formula for singles, an eighth for combos. Never more than 2%.'],
  ['CLV', 'Closing line value: did the price move your way before tip-off? Beating the closing price is the best early sign of a real edge.'],
  ['Backtest', 'Replaying past games using only what was known at lock time (shortly before tip), against the real prices on the board at that time.'],
];
