// Token radar R5 fresh — value curve, launch odds from the peers' own record,
// and deposit-sized farm economics. Everything is derived from the sealed
// snapshot at run time: no protocol name is ever special-cased, no constant
// is tuned to a name, and every validation number the dashboard shows is
// recomputed here on every run, so the page can never disagree with the run.
//
// Model (fitted, not assumed):
//   ln(mcap) = b0 + b1*ln(TVL) + b2*ln(age_days) + shrunk category offset
//   on the 109 traded comps (mcap/TVL in [0.02, 20], one per token id).
//   Fitted on this snapshot: b0 ~ 5.637, b1 ~ 0.675, b2 ~ -0.161 (NEGATIVE:
//   age lowers value), R^2 ~ 0.470. Multiple clamped to [0.08, 1.20].
//   Pipeline: x (1 + 0.3*clamp(change_7d, -60, 120)/100) x 0.85 pre-token
//   discount. Growth weight 0.3, not 0.6: it wins all three holdout legs
//   against 0.6 (see validation.ts).
// Launch odds: P(launch within 2y) from the peers' own launch record — the
// traded share by age bucket (a current-status launch CDF), interpolated,
// times an age-adjusted category multiplier (observed/expected launches,
// shrunk with 8 pseudo-observations). NOT from hours-with-no-token alone.
// Board rank: expected value = conditional (pipeline) value x odds.

import { createHash } from 'node:crypto';

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
export const UNKNOWN_AGE = 365;
export const OFFSET_SHRINK = 8;
export const MULT_LOW = 0.08;
export const MULT_HIGH = 1.2;
export const GROWTH_WEIGHT = 0.3;
export const PRETOKEN_DISCOUNT = 0.85;
export const TS_CUT = '2024-02-06';
export const MODEL_VERSION = 'radar-r5-fresh';

export const ECON = {
  deposit: 5000,
  dropShare: 0.1,
  gasUsd: 12,
  tbill: 0.04,
  holdDays: 90,
  hours: 3.5,
  hurdle: 60,
} as const;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'traded';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'liquid-staking';
  if (p.category === 'CEX') return 'exchange-custody';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORD.test(p.name) || EXCHANGES.some((e) => p.name.startsWith(e))) return 'wrapped-or-staked';
  return null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return exclusionReason(p) === null;
}

/** One greatest-TVL protocol per token id, mcap/TVL in [0.02, 20]. */
export function compPool(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  const live = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.mcap_usd / p.tvl_usd >= 0.02 && p.mcap_usd / p.tvl_usd <= 20);
  const byToken = new Map<string, SnapshotProtocol>();
  for (const p of live) {
    const key = p.gecko_id ?? p.symbol ?? p.slug;
    const cur = byToken.get(key);
    if (cur === undefined || p.tvl_usd > cur.tvl_usd) byToken.set(key, p);
  }
  return [...byToken.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

// ------------------------------------------------------------------ maths

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const tmp = M[col]!;
    M[col] = M[piv]!;
    M[piv] = tmp;
    const d = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / d;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** OLS of ln(mcap) on [1, ln TVL, ln age] (+ optional extra columns). */
export function ols(rows: number[][], y: number[]): number[] {
  const k = rows[0]!.length;
  const XtX: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a]! += rows[i]![a]! * y[i]!;
      for (let b = 0; b < k; b++) XtX[a]![b]! += rows[i]![a]! * rows[i]![b]!;
    }
  }
  return solveLinear(XtX, Xty);
}

export interface CurveFit {
  beta: number[];
  offsets: Map<string, number>;
  n: number;
  r2: number;
}

export function designRow(p: SnapshotProtocol, asOf: string, extra?: (p: SnapshotProtocol) => number[]): number[] {
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE;
  const row = [1, Math.log(Math.max(p.tvl_usd, 1)), Math.log(Math.max(age, 1))];
  if (extra !== undefined) row.push(...extra(p));
  return row;
}

export function fitCurve(train: SnapshotProtocol[], asOf: string, extra?: (p: SnapshotProtocol) => number[]): CurveFit {
  const X = train.map((p) => designRow(p, asOf, extra));
  const y = train.map((p) => Math.log(p.mcap_usd!));
  const beta = ols(X, y);
  const resid = y.map((v, i) => v - X[i]!.reduce((s, x, j) => s + x * beta[j]!, 0));
  const byCat = new Map<string, number[]>();
  train.forEach((p, i) => {
    const c = p.category ?? '__null';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(resid[i]!);
  });
  const offsets = new Map<string, number>();
  for (const [c, rs] of byCat) offsets.set(c, (rs.length / (rs.length + OFFSET_SHRINK)) * mean(rs));
  const yMean = mean(y);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  // R^2 of the full curve: OLS part plus the shrunk category offsets.
  const ssRes = y.reduce((s, v, i) => {
    const pred = X[i]!.reduce((t, x, j) => t + x * beta[j]!, 0) + (offsets.get(train[i]!.category ?? '__null') ?? 0);
    return s + (v - pred) ** 2;
  }, 0);
  return { beta, offsets, n: train.length, r2: 1 - ssRes / ssTot };
}

/** Curve-implied market cap (multiple clamped to [0.08, 1.20]). */
export function curveValue(fit: CurveFit, p: SnapshotProtocol, asOf: string, extra?: (p: SnapshotProtocol) => number[]): number {
  const row = designRow(p, asOf, extra);
  const lp = row.reduce((s, x, j) => s + x * fit.beta[j]!, 0) + (fit.offsets.get(p.category ?? '__null') ?? 0);
  const mult = Math.min(MULT_HIGH, Math.max(MULT_LOW, Math.exp(lp) / p.tvl_usd));
  return p.tvl_usd * mult;
}

export function growthMultiplier(p: SnapshotProtocol): number {
  const ch7 = p.change_7d ?? 0;
  const c = Math.min(120, Math.max(-60, ch7));
  return 1 + (c / 100) * GROWTH_WEIGHT;
}

/** Full pipeline conditional value: curve x growth carry (w 0.3) x 0.85. */
export function conditionalValue(fit: CurveFit, p: SnapshotProtocol, asOf: string): number {
  return Math.max(1, curveValue(fit, p, asOf) * growthMultiplier(p) * PRETOKEN_DISCOUNT);
}

// ------------------------------------------------------------------ odds
//
// The peers' launch record, read as a current-status launch CDF: for each
// age bucket, the share of protocols in that bucket that already record a
// token. F(a) is that share interpolated on bucket midpoints, forced
// non-decreasing. P(launch within 2y | survived to age a) =
// 1 - (1 - F(a+730)) / (1 - F(a)). The category multiplier is the
// age-adjusted observed/expected launch ratio, shrunk with 8 pseudo-counts:
// a category whose protocols launch less often than peers of the same age
// gets odds below the age curve, and vice versa. Both parts are fitted on
// the training set alone inside every holdout.

export const ODDS_BUCKETS: [number, number][] = [
  [0, 365],
  [365, 730],
  [730, 1095],
  [1095, 1460],
  [1460, Number.POSITIVE_INFINITY],
];

export function bucketOf(age: number): number {
  for (let i = 0; i < ODDS_BUCKETS.length; i++) {
    if (age >= ODDS_BUCKETS[i]![0] && age < ODDS_BUCKETS[i]![1]) return i;
  }
  return ODDS_BUCKETS.length - 1;
}

export interface OddsFit {
  bucketF: number[];
  bucketMids: number[];
  catMult: Map<string, number>;
  globalRate: number;
}

export function fitOdds(train: SnapshotProtocol[], asOf: string): OddsFit {
  const dated = train.filter((p) => ageDays(asOf, p.listed_at) !== null);
  const bucketF: number[] = [];
  for (let b = 0; b < ODDS_BUCKETS.length; b++) {
    const members = dated.filter((p) => bucketOf(ageDays(asOf, p.listed_at)!) === b);
    const traded = members.filter((p) => !isPreToken(p)).length;
    bucketF.push(members.length > 0 ? traded / members.length : 0);
  }
  for (let i = 1; i < bucketF.length; i++) bucketF[i] = Math.max(bucketF[i]!, bucketF[i - 1]!);
  const bucketMids = ODDS_BUCKETS.map(([lo, hi]) => (lo + Math.min(hi, 2920)) / 2);
  const globalRate = train.filter((p) => !isPreToken(p)).length / Math.max(1, train.length);
  const catMult = new Map<string, number>();
  const cats = new Set(train.map((p) => p.category ?? '__null'));
  for (const c of cats) {
    let observed = 0;
    let expected = 0;
    for (const p of dated) {
      if ((p.category ?? '__null') !== c) continue;
      expected += bucketF[bucketOf(ageDays(asOf, p.listed_at)!)]!;
      if (!isPreToken(p)) observed += 1;
    }
    catMult.set(c, (observed + OFFSET_SHRINK) / (expected + OFFSET_SHRINK));
  }
  return { bucketF, bucketMids, catMult, globalRate };
}

export function cdfAt(fit: OddsFit, age: number): number {
  const mids = fit.bucketMids;
  const f = fit.bucketF;
  if (age <= mids[0]!) return f[0]!;
  if (age >= mids[mids.length - 1]!) return f[f.length - 1]!;
  for (let i = 0; i < mids.length - 1; i++) {
    if (age >= mids[i]! && age < mids[i + 1]!) {
      const t = (age - mids[i]!) / (mids[i + 1]! - mids[i]!);
      return f[i]! + t * (f[i + 1]! - f[i]!);
    }
  }
  return f[f.length - 1]!;
}

/** P(launch within 2 years | age, category), from the peers' record. */
export function launchOdds(fit: OddsFit, p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE;
  const fa = cdfAt(fit, age);
  const fb = cdfAt(fit, age + 730);
  let o = 1 - (1 - fb) / Math.max(1 - fa, 1e-9);
  o *= fit.catMult.get(p.category ?? '__null') ?? 1;
  return Math.min(0.95, Math.max(0.02, o));
}

// ------------------------------------------------------------------ economics

export interface Economics {
  sliceUsd: number;
  costsUsd: number;
  netUsd: number;
  netPerHourUsd: number;
  breakEvenOdds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

export function economics(
  conditional: number,
  odds: number,
  tvl: number,
  deposit = ECON.deposit,
  dropShare = ECON.dropShare,
  tbill = ECON.tbill,
): Economics {
  const sliceUsd = conditional * odds * dropShare * (deposit / Math.max(tvl, 1));
  const costsUsd = ECON.gasUsd + (deposit * tbill * ECON.holdDays) / 365;
  const netUsd = sliceUsd - costsUsd;
  const denom = conditional * dropShare * (deposit / Math.max(tvl, 1));
  const breakEvenOdds = denom > 0 ? costsUsd / denom : 99;
  return {
    sliceUsd,
    costsUsd,
    netUsd,
    netPerHourUsd: netUsd / ECON.hours,
    breakEvenOdds,
    verdict: netUsd >= ECON.hurdle ? 'FARM' : netUsd >= 0 ? 'THIN' : 'SKIP',
  };
}

// ------------------------------------------------------------------ farm steps

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export function farmSteps(p: SnapshotProtocol, asOf: string, econ: Economics, odds: number): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const age = ageDays(asOf, p.listed_at);
  const hold = holdDaysFor(age);
  const steps = [
    `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas. Time: 15 minutes to set up.`,
    `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `At a $${ECON.deposit.toLocaleString('en-US')} deposit the expected slice is ${money(econ.sliceUsd)} against ${money(econ.costsUsd)} of costs, net ${econ.netUsd >= 0 ? '+' : '−'}${money(Math.abs(econ.netUsd))} (${econ.verdict}); the launch odds this needs to break even are ${(Math.min(econ.breakEvenOdds, 9.99) * 100).toFixed(0)}% against modelled odds ${(odds * 100).toFixed(0)}%. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
    `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes, then log the wallet, dates and every transaction. Cost: nothing but the log. Time: 5 minutes.`,
  ];
  return steps.map((s) => {
    if (s.length > 600) return `${s.slice(0, 596)}...`;
    return s;
  });
}

// ------------------------------------------------------------------ board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  watchlist: boolean;
  conditional_value_usd: number;
  launch_odds_2y: number;
  implied_value_usd: number;
  band_lo_usd: number;
  band_hi_usd: number;
  rank_lo: number;
  rank_hi: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  net_usd: number;
  net_per_hour_usd: number;
  break_even_odds: number;
  farm_steps: string[];
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** Slug-hash split (deterministic, no RNG): sha256(slug) < 0.7 trains. */
export function hashTrain(slug: string): boolean {
  const h = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return parseInt(h, 16) / 0xffffffff < 0.7;
}

/** Seeded PRNG (mulberry32) — deterministic bootstrap, same bytes every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
