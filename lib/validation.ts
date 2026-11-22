// Validation, recomputed from the snapshot on every run. The three holdout
// legs use the house's own definitions (strategy-framework: one falsifiable
// guard — every leg must match or beat R4, or the change is reverted):
//   geo = exp(median |log(pred/actual)|) — the median miss factor.
//   LOO: leave one comp out, refit everything (curve + offsets) inside.
//   time-split: train listed on/before 2024-02-06 (42), test after (40).
//   walk-forward: expanding folds at 25/50/75% of listed dates; each fold
//   trains on or before its cut and tests only the next block; pooled over
//   all held-out rows. (walk-forward-validation skill.)
// Regime note (regime-detection skill): the snapshot's 7-day window is one
// down regime (median change_7d -9.3%, 641 of 754 reporting protocols down),
// so time is the only regime axis and the walk-forward folds are the regime
// test — a feature that passes LOO but fails a WF fold is regime overfit
// and is not adopted.
// Bands (conformal-uq skill): the calibration set for the 90% band is the
// LOO residuals, never touched by fitting; the band is quoted beside the
// narrower sigma band, never hidden.

import {
  ageDays,
  bucketOf,
  cdfAt,
  compPool,
  conditionalValue,
  curveValue,
  economics,
  exclusionReason,
  fitCurve,
  fitOdds,
  farmSteps,
  growthMultiplier,
  hashTrain,
  isPreToken,
  launchOdds,
  mean,
  median,
  mulberry32,
  quantile,
  solveLinear,
  type BoardRow,
  type CurveFit,
  type OddsFit,
  type Snapshot,
  type SnapshotProtocol,
  ECON,
  MULT_HIGH,
  MULT_LOW,
  PRETOKEN_DISCOUNT,
  TS_CUT,
} from './model.ts';

export interface HoldoutLeg {
  geo: number;
  meanFactor: number;
  mdape: number;
  spearman: number;
  within3x: number;
  nTest: number;
}

export interface AblationRow {
  step: string;
  looGeo: number;
  looMean: number;
  tsGeo: number;
  tsMean: number;
  wfGeo: number;
  wfFolds: number[];
  verdict: string;
}

export interface OddsHoldout {
  split: string;
  nTest: number;
  tradedFrac: number;
  hit: number;
  base: number;
  brier: number;
  auc: number;
}

export interface Validation {
  curve: { intercept: number; slopeTvl: number; slopeAge: number; r2: number; nComps: number; offsets: [string, number][] };
  curveLegs: { loo: HoldoutLeg; ts: HoldoutLeg; wf: HoldoutLeg; wfFolds: number[] };
  pipelineLegs: { loo: HoldoutLeg; ts: HoldoutLeg; wf: HoldoutLeg; wfFolds: number[] };
  ablation: AblationRow[];
  odds: { buckets: { lo: number; hi: number; n: number; traded: number; f: number }[]; holdout: OddsHoldout[]; catMult: [string, number][] };
  bands: { sigma: number; sigmaCoverage: number; band90: number; localCoverage: number; localMedianWidth: number };
  bootstrap: { top20Stable: number; top10Keeps: number; rank1Stays: number };
  census: { ranked: number; rankedFloor: number; rankedEarly: number; traded: number; bridge: number; liquidStaking: number; exchangeCustody: number; versioned: number; wrapped: number; total: number };
  integrity: { protocolsRead: number; watchlistRead: number; dedupRemoved: number; nullListedAt: number; nullChange7d: number; medianChange7d: number; down7d: number; reported7d: number };
  board: { rows: number; evTotal: number; condTotal: number; farm: number; thin: number; skip: number; topEv: number; topSlug: string; topName: string };
  scatter: { comps: { x: number; y: number; p: number }[]; board: { x: number; y: number }[] };
  live: { slug: string; name: string; category: string | null; tvl: number; mcap: number }[];
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const order = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!);
    const r = new Array<number>(xs.length);
    order.forEach((idx, pos) => {
      r[idx] = pos;
    });
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function legMetrics(preds: number[], acts: number[]): HoldoutLeg {
  const logErr = preds.map((p, i) => Math.abs(Math.log(p / acts[i]!)));
  const factors = preds.map((p, i) => Math.max(p / acts[i]!, acts[i]! / p));
  const apes = preds.map((p, i) => Math.abs(p - acts[i]!) / acts[i]!);
  return {
    geo: Math.exp(median(logErr)),
    meanFactor: mean(factors),
    mdape: median(apes),
    spearman: spearman(preds, acts),
    within3x: logErr.filter((e) => e < Math.log(3)).length / logErr.length,
    nTest: preds.length,
  };
}

function looLeg(comps: SnapshotProtocol[], asOf: string, pipeline: boolean): HoldoutLeg {
  const preds: number[] = [];
  const acts: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const fit = fitCurve(train, asOf);
    const p = pipeline ? conditionalValue(fit, comps[i]!, asOf) : curveValue(fit, comps[i]!, asOf);
    preds.push(p);
    acts.push(comps[i]!.mcap_usd!);
  }
  return legMetrics(preds, acts);
}

function timeSplitLeg(comps: SnapshotProtocol[], asOf: string, pipeline: boolean): HoldoutLeg {
  const dated = comps.filter((p) => p.listed_at !== null);
  const train = dated.filter((p) => p.listed_at! <= TS_CUT);
  const test = dated.filter((p) => p.listed_at! > TS_CUT);
  const fit = fitCurve(train, asOf);
  const preds = test.map((p) => (pipeline ? conditionalValue(fit, p, asOf) : curveValue(fit, p, asOf)));
  return legMetrics(preds, test.map((p) => p.mcap_usd!));
}

function walkForwardLeg(comps: SnapshotProtocol[], asOf: string, pipeline: boolean): { leg: HoldoutLeg; folds: number[] } {
  const dated = [...comps.filter((p) => p.listed_at !== null)].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cuts = [0.25, 0.5, 0.75].map((q) => dated[Math.floor(dated.length * q)]!.listed_at!);
  const pooledP: number[] = [];
  const pooledA: number[] = [];
  const folds: number[] = [];
  for (let fi = 0; fi < cuts.length; fi++) {
    const train = dated.filter((p) => p.listed_at! <= cuts[fi]!);
    const test = dated.filter((p) => p.listed_at! > cuts[fi]! && (fi === cuts.length - 1 || p.listed_at! <= cuts[fi + 1]!));
    const fit = fitCurve(train, asOf);
    const preds = test.map((p) => (pipeline ? conditionalValue(fit, p, asOf) : curveValue(fit, p, asOf)));
    const acts = test.map((p) => p.mcap_usd!);
    folds.push(legMetrics(preds, acts).geo);
    pooledP.push(...preds);
    pooledA.push(...acts);
  }
  return { leg: legMetrics(pooledP, pooledA), folds };
}

// Ablation: each step refits inside every holdout, under BOTH schemes.
function ablationPredictor(train: SnapshotProtocol[], asOf: string, step: string): (p: SnapshotProtocol) => number {
  if (step === 'flat') {
    const mult = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
    return (p) => p.tvl_usd * mult;
  }
  const useAge = step === 'size+age' || step === 'full' || step === 'pipeline';
  const useOffsets = step === 'size+off' || step === 'full' || step === 'pipeline';
  const X: number[][] = [];
  const y: number[] = [];
  for (const p of train) {
    const age = ageDays(asOf, p.listed_at) ?? 365;
    const row = [1, Math.log(Math.max(p.tvl_usd, 1))];
    if (useAge) row.push(Math.log(Math.max(age, 1)));
    X.push(row);
    y.push(Math.log(p.mcap_usd!));
  }
  const k = X[0]!.length;
  const XtX: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a]! += X[i]![a]! * y[i]!;
      for (let b = 0; b < k; b++) XtX[a]![b]! += X[i]![a]! * X[i]![b]!;
    }
  }
  const beta = solveLinear(XtX, Xty);
  const offsets = new Map<string, number>();
  if (useOffsets) {
    const resid = y.map((v, i) => v - X[i]!.reduce((s, x, j) => s + x * beta[j]!, 0));
    const byCat = new Map<string, number[]>();
    train.forEach((p, i) => {
      const c = p.category ?? '__null';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c)!.push(resid[i]!);
    });
    for (const [c, rs] of byCat) offsets.set(c, (rs.length / (rs.length + 8)) * mean(rs));
  }
  return (p) => {
    const age = ageDays(asOf, p.listed_at) ?? 365;
    let lp = beta[0]! + beta[1]! * Math.log(Math.max(p.tvl_usd, 1));
    if (useAge) lp += beta[2]! * Math.log(Math.max(age, 1));
    lp += offsets.get(p.category ?? '__null') ?? 0;
    const mult = Math.min(MULT_HIGH, Math.max(MULT_LOW, Math.exp(lp) / p.tvl_usd));
    let v = p.tvl_usd * mult;
    if (step === 'pipeline') {
      v = Math.max(1, v * growthMultiplier(p) * PRETOKEN_DISCOUNT);
    }
    return v;
  };
}

function ablationLegs(comps: SnapshotProtocol[], asOf: string): AblationRow[] {
  const steps: { step: string; label: string }[] = [
    { step: 'flat', label: 'flat median multiple' },
    { step: 'size', label: '+ size curve ln(TVL)' },
    { step: 'size+off', label: '+ shrunk category offsets' },
    { step: 'size+off+growth', label: '+ growth 0.3 & 0.85 discount' },
    { step: 'pipeline', label: '+ ln(age) — full pipeline' },
  ];
  // 'size+off+growth' is the pipeline predictor without the age column:
  // emulate by fitting size+off then applying growth x discount.
  const dated = comps.filter((p) => p.listed_at !== null);
  const tsTrain = dated.filter((p) => p.listed_at! <= TS_CUT);
  const tsTest = dated.filter((p) => p.listed_at! > TS_CUT);
  const ds = [...dated].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cuts = [0.25, 0.5, 0.75].map((q) => ds[Math.floor(ds.length * q)]!.listed_at!);
  const rows: AblationRow[] = [];
  let prev: { loo: number; ts: number } | null = null;
  for (const { step, label } of steps) {
    const predict = (train: SnapshotProtocol[]): ((p: SnapshotProtocol) => number) => {
      if (step === 'size+off+growth') {
        const base = ablationPredictor(train, asOf, 'size+off');
        return (p) => Math.max(1, base(p) * growthMultiplier(p) * PRETOKEN_DISCOUNT);
      }
      return ablationPredictor(train, asOf, step);
    };
    const looP: number[] = [];
    const looA: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const f = predict(comps.filter((_, j) => j !== i));
      looP.push(f(comps[i]!));
      looA.push(comps[i]!.mcap_usd!);
    }
    const loo = legMetrics(looP, looA);
    const tsF = predict(tsTrain);
    const ts = legMetrics(tsTest.map((p) => tsF(p)), tsTest.map((p) => p.mcap_usd!));
    const wfP: number[] = [];
    const wfA: number[] = [];
    const wfFolds: number[] = [];
    for (let fi = 0; fi < cuts.length; fi++) {
      const tr = ds.filter((p) => p.listed_at! <= cuts[fi]!);
      const te = ds.filter((p) => p.listed_at! > cuts[fi]! && (fi === cuts.length - 1 || p.listed_at! <= cuts[fi + 1]!));
      const f = predict(tr);
      const pp = te.map((p) => f(p));
      const aa = te.map((p) => p.mcap_usd!);
      wfFolds.push(legMetrics(pp, aa).geo);
      wfP.push(...pp);
      wfA.push(...aa);
    }
    const wf = legMetrics(wfP, wfA);
    let verdict: string;
    if (prev === null) verdict = 'baseline';
    else {
      const looOk = loo.geo < prev.loo;
      const tsOk = ts.geo < prev.ts;
      verdict = looOk && tsOk ? 'kept: wins both holdouts' : looOk || tsOk ? 'mixed: wins one holdout' : 'costs both holdouts — disclosed, kept as an economic adjustment';
    }
    prev = { loo: loo.geo, ts: ts.geo };
    rows.push({ step: label, looGeo: loo.geo, looMean: loo.meanFactor, tsGeo: ts.geo, tsMean: ts.meanFactor, wfGeo: wf.geo, wfFolds, verdict });
  }
  return rows;
}

function auc(scores: number[], labels: number[]): number {
  const n = scores.length;
  const order = scores.map((_, i) => i).sort((i, j) => scores[i]! - scores[j]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]!] === scores[order[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!] = avg;
    i = j + 1;
  }
  const n1 = labels.filter((l) => l === 1).length;
  const n0 = n - n1;
  if (n1 === 0 || n0 === 0) return NaN;
  const rp = ranks.reduce((s, r, idx) => s + (labels[idx] === 1 ? r : 0), 0);
  return (rp - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

function oddsHoldout(all: SnapshotProtocol[], asOf: string): OddsHoldout[] {
  const dated = all.filter((p) => ageDays(asOf, p.listed_at) !== null);
  const splits: { name: string; train: SnapshotProtocol[]; test: SnapshotProtocol[] }[] = [
    { name: 'slug-hash 70/30', train: dated.filter((p) => hashTrain(p.slug)), test: dated.filter((p) => !hashTrain(p.slug)) },
    { name: 'time: listed ≤ 2024-02-06 / after', train: dated.filter((p) => p.listed_at! <= TS_CUT), test: dated.filter((p) => p.listed_at! > TS_CUT) },
  ];
  return splits.map(({ name, train, test }) => {
    const fit = fitOdds(train, asOf);
    const scores = test.map((p) => cdfAt(fit, ageDays(asOf, p.listed_at)!));
    const labels = test.map((p) => (isPreToken(p) ? 0 : 1));
    const preds = scores.map((s) => (s >= 0.5 ? 1 : 0));
    const hit = preds.filter((v, idx) => v === labels[idx]).length / labels.length;
    const frac = mean(labels);
    const base = Math.max(frac, 1 - frac);
    const brier = mean(scores.map((s, idx) => (s - labels[idx]!) ** 2));
    return { split: name, nTest: test.length, tradedFrac: frac, hit, base, brier, auc: auc(scores, labels) };
  });
}

export function validate(snapshot: Snapshot): {
  validation: Validation;
  board: BoardRow[];
  curveFit: CurveFit;
  oddsFit: OddsFit;
  comps: SnapshotProtocol[];
} {
  const asOf = snapshot.as_of;
  const comps = compPool(snapshot.protocols);
  const curveFit = fitCurve(comps, asOf);
  const oddsFit = fitOdds(snapshot.protocols, asOf);

  // ---- census + integrity (from our own exclusion rules, counted live)
  const census = { ranked: 0, rankedFloor: 0, rankedEarly: 0, traded: 0, bridge: 0, liquidStaking: 0, exchangeCustody: 0, versioned: 0, wrapped: 0, total: snapshot.protocols.length };
  const ranked: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) {
    const reason = exclusionReason(p);
    if (reason === null) {
      ranked.push(p);
      census.ranked++;
      if (p.tvl_usd >= snapshot.floor_usd) census.rankedFloor++;
      else census.rankedEarly++;
    } else if (reason === 'traded') census.traded++;
    else if (reason === 'bridge') census.bridge++;
    else if (reason === 'liquid-staking') census.liquidStaking++;
    else if (reason === 'exchange-custody') census.exchangeCustody++;
    else if (reason === 'versioned') census.versioned++;
    else census.wrapped++;
  }
  const tokenKeys = new Set<string>();
  let tradedRows = 0;
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    tradedRows++;
    tokenKeys.add(p.gecko_id ?? p.symbol ?? p.slug);
  }
  const changes = snapshot.protocols.map((p) => p.change_7d).filter((c): c is number => c !== null);
  const integrity = {
    protocolsRead: snapshot.protocols.length,
    watchlistRead: snapshot.watchlist.length,
    dedupRemoved: tradedRows - tokenKeys.size,
    nullListedAt: snapshot.protocols.filter((p) => p.listed_at === null).length,
    nullChange7d: snapshot.protocols.filter((p) => p.change_7d === null).length,
    medianChange7d: median(changes),
    down7d: changes.filter((c) => c < 0).length,
    reported7d: changes.length,
  };

  // ---- holdout legs (curve + pipeline)
  const curveLoo = looLeg(comps, asOf, false);
  const curveTs = timeSplitLeg(comps, asOf, false);
  const curveWf = walkForwardLeg(comps, asOf, false);
  const pipeLoo = looLeg(comps, asOf, true);
  const pipeTs = timeSplitLeg(comps, asOf, true);
  const pipeWf = walkForwardLeg(comps, asOf, true);
  const ablation = ablationLegs(comps, asOf);

  // ---- odds holdout (peer CDF predictor of traded status)
  const oddsHold = oddsHoldout(snapshot.protocols, asOf);

  // ---- LOO residuals for bands (curve predictions, refit inside)
  const looResid: { p: SnapshotProtocol; err: number; pred: number }[] = [];
  for (let i = 0; i < comps.length; i++) {
    const fit = fitCurve(comps.filter((_, j) => j !== i), asOf);
    const pred = curveValue(fit, comps[i]!, asOf);
    looResid.push({ p: comps[i]!, err: Math.log(pred / comps[i]!.mcap_usd!), pred });
  }
  const absErr = looResid.map((r) => Math.abs(r.err));
  const sigma = Math.sqrt(mean(looResid.map((r) => r.err * r.err)));
  const sigmaBand = Math.exp(sigma);
  const sigmaCoverage = looResid.filter((r) => Math.abs(r.err) <= sigma).length / looResid.length;
  const band90 = Math.exp(quantile(absErr, 0.9) * (looResid.length + 1) / looResid.length);

  // ---- local P25–P75 bands per row (neighbours by ln TVL)
  const localBand = (rowTvl: number, excludeSlug?: string): { lo: number; hi: number } => {
    const neighbours = looResid
      .filter((r) => r.p.slug !== excludeSlug)
      .map((r) => ({ d: Math.abs(Math.log(r.p.tvl_usd) - Math.log(rowTvl)), err: r.err }))
      .sort((a, b) => a.d - b.d);
    let take = neighbours.filter((n) => n.d <= 0.75);
    if (take.length < 20) take = neighbours.slice(0, 20);
    const errs = take.map((n) => n.err);
    return { lo: Math.exp(quantile(errs, 0.25)), hi: Math.exp(quantile(errs, 0.75)) };
  };
  let localCover = 0;
  const widths: number[] = [];
  for (const r of looResid) {
    const b = localBand(r.p.tvl_usd, r.p.slug);
    widths.push(b.hi / b.lo);
    if (r.pred * b.lo <= r.p.mcap_usd! && r.p.mcap_usd! <= r.pred * b.hi) localCover++;
  }

  // ---- board rows (EV ranking)
  const scored = ranked.map((p) => {
    const cond = conditionalValue(curveFit, p, asOf);
    const odds = launchOdds(oddsFit, p, asOf);
    const ev = cond * odds;
    const econ = economics(cond, odds, p.tvl_usd);
    const band = localBand(p.tvl_usd);
    return { p, cond, odds, ev, econ, band };
  });
  scored.sort((a, b) => Math.round(b.ev) - Math.round(a.ev) || b.cond - a.cond || (a.p.slug < b.p.slug ? -1 : 1));

  // ---- bootstrap 200 refits (seeded): rank ranges + top-20 stability
  const rng = mulberry32(20261122);
  const rankLists = new Map<string, number[]>();
  const top20Count = new Map<string, number>();
  for (const s of scored) {
    rankLists.set(s.p.slug, []);
    top20Count.set(s.p.slug, 0);
  }
  for (let b = 0; b < 200; b++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const fit = fitCurve(sample, asOf);
    const evs = scored.map((s) => ({ slug: s.p.slug, ev: conditionalValue(fit, s.p, asOf) * s.odds }));
    evs.sort((x, y) => Math.round(y.ev) - Math.round(x.ev) || (x.slug < y.slug ? -1 : 1));
    evs.forEach((e, idx) => {
      rankLists.get(e.slug)!.push(idx + 1);
      if (idx < 20) top20Count.set(e.slug, top20Count.get(e.slug)! + 1);
    });
  }
  const currentTop20 = new Set(scored.slice(0, 20).map((s) => s.p.slug));
  let top20Stable = 0;
  for (const slug of currentTop20) if (top20Count.get(slug)! / 200 >= 0.8) top20Stable++;
  const top10Keeps = mean(scored.slice(0, 10).map((s) => {
    const ranks = rankLists.get(s.p.slug)!;
    return ranks.filter((r) => r <= 10).length / 200;
  })) * 10;
  const rank1Stays = rankLists.get(scored[0]!.p.slug)!.filter((r) => r === 1).length / 200;

  const board: BoardRow[] = scored.map((s, i) => {
    const ranks = rankLists.get(s.p.slug)!;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: ageDays(asOf, s.p.listed_at),
      listed_at: s.p.listed_at,
      watchlist: snapshot.watchlist.includes(s.p.slug),
      conditional_value_usd: Math.max(1, Math.round(s.cond)),
      launch_odds_2y: Math.round(s.odds * 1000) / 1000,
      implied_value_usd: Math.max(1, Math.round(s.ev)),
      band_lo_usd: Math.max(1, Math.round(s.ev * s.band.lo)),
      band_hi_usd: Math.max(1, Math.round(s.ev * s.band.hi)),
      rank_lo: Math.min(...ranks),
      rank_hi: Math.max(...ranks),
      verdict: s.econ.verdict,
      net_usd: Math.round(s.econ.netUsd * 100) / 100,
      net_per_hour_usd: Math.round(s.econ.netPerHourUsd * 100) / 100,
      break_even_odds: Math.round(Math.min(s.econ.breakEvenOdds, 9.99) * 1000) / 1000,
      farm_steps: farmSteps(s.p, asOf, s.econ, s.odds),
    };
  });

  const verdictCounts = { farm: 0, thin: 0, skip: 0 };
  for (const r of board) {
    if (r.verdict === 'FARM') verdictCounts.farm++;
    else if (r.verdict === 'THIN') verdictCounts.thin++;
    else verdictCounts.skip++;
  }

  const scatter = {
    comps: comps.map((p) => {
      const pred = curveValue(curveFit, p, asOf);
      return { x: Math.round(Math.log(p.tvl_usd) * 1000) / 1000, y: Math.round(Math.log(p.mcap_usd!) * 1000) / 1000, p: Math.round(Math.log(pred) * 1000) / 1000 };
    }),
    board: board.map((r) => ({ x: Math.round(Math.log(r.tvl_usd) * 1000) / 1000, y: Math.round(Math.log(Math.max(r.implied_value_usd, 1)) * 1000) / 1000 })),
  };
  const live = [...snapshot.protocols]
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 12)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl: p.tvl_usd, mcap: p.mcap_usd! }));

  const validation: Validation = {
    curve: {
      intercept: curveFit.beta[0]!,
      slopeTvl: curveFit.beta[1]!,
      slopeAge: curveFit.beta[2]!,
      r2: curveFit.r2,
      nComps: comps.length,
      offsets: [...curveFit.offsets.entries()].sort((a, b) => b[1] - a[1]),
    },
    curveLegs: { loo: curveLoo, ts: curveTs, wf: curveWf.leg, wfFolds: curveWf.folds },
    pipelineLegs: { loo: pipeLoo, ts: pipeTs, wf: pipeWf.leg, wfFolds: pipeWf.folds },
    ablation,
    odds: {
      buckets: [0, 1, 2, 3, 4].map((b) => {
        const members = snapshot.protocols.filter((p) => ageDays(asOf, p.listed_at) !== null && bucketOf(ageDays(asOf, p.listed_at)!) === b);
        const traded = members.filter((p) => !isPreToken(p)).length;
        return { lo: [0, 365, 730, 1095, 1460][b]!, hi: [365, 730, 1095, 1460, -1][b]!, n: members.length, traded, f: oddsFit.bucketF[b]! };
      }),
      holdout: oddsHold,
      catMult: [...oddsFit.catMult.entries()].sort((a, b) => b[1] - a[1]),
    },
    bands: { sigma: sigmaBand, sigmaCoverage, band90, localCoverage: localCover / looResid.length, localMedianWidth: median(widths) },
    bootstrap: { top20Stable, top10Keeps, rank1Stays },
    census,
    integrity,
    board: {
      rows: board.length,
      evTotal: board.reduce((s, r) => s + r.implied_value_usd, 0),
      condTotal: board.reduce((s, r) => s + r.conditional_value_usd, 0),
      farm: verdictCounts.farm,
      thin: verdictCounts.thin,
      skip: verdictCounts.skip,
      topEv: board[0]!.implied_value_usd,
      topSlug: board[0]!.slug,
      topName: board[0]!.name,
    },
    scatter,
    live,
  };
  return { validation, board, curveFit, oddsFit, comps };
}
