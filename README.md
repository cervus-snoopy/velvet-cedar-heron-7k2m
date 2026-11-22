[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/cervus-snoopy/velvet-cedar-heron-7k2m/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/cervus-snoopy/velvet-cedar-heron-7k2m/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — launch odds from the peers' record (R5 fresh)

A token launch radar built from scratch for [token-radar-01](https://make.fun/bounty/token-radar-01).
It reads the sealed DefiLlama snapshot (758 protocols, 2026-11-14), fits a
value curve on the 109 traded comps, prices every pre-token protocol by
**expected value = conditional value × P(launch within 2 years)**, and gives
each one a costed six-step farm plan with deposit-sized economics.

## The model

- **Value curve** (fitted, not assumed): `ln(mcap) = 5.637 + 0.675·ln(TVL) − 0.161·ln(age_days) + shrunk category offset`, R² 0.470, n=109 comps (mcap/TVL in [0.02, 20], one per token id). Multiple clamped [0.08, 1.20]. Age is **negative** — older with no token is worth less. The previous R5 build flipped this sign and its time-split and walk-forward legs got worse; this build keeps the fitted sign.
- **Pipeline**: curve × (1 + 0.3·clamp(change_7d, −60, 120)/100) × 0.85 pre-token discount. Growth weight 0.3 beats 0.6 on all three holdout legs.
- **Launch odds — new in R5**: P(launch within 2y) from the peers' own launch record. For each age bucket, the share of protocols in it that already record a token is the launch CDF F(age); forward odds = 1 − (1 − F(age+730d)) / (1 − F(age)), times an age-adjusted category multiplier (observed ÷ expected launches for peers of the same age, shrunk with 8 pseudo-observations). Hold-out: hit 69% vs 54% base, Brier 0.203, AUC 0.748 on a slug-hash split; AUC 0.603 on the time split — launch behaviour drifts forward in time, and the board says so.
- **Double-holdout ablation**: every term is judged on leave-one-out AND time-split side by side. Size wins both; offsets win LOO but cost the time-split +5.0%; growth + discount costs both legs and is kept as a stated economic adjustment, not a fit gain; age, added last, wins both.

## Holdouts (median miss factor, recomputed every run)

| | LOO | Time-split | Walk-forward |
|---|---|---|---|
| Curve | ×2.6325 | ×2.3596 | ×2.5151 (folds 2.52 / 2.58 / 2.41) |
| Pipeline (growth 0.3) | ×2.7464 | ×2.5668 | ×2.6374 |

Identical to R4's validated curve — the guard holds on all three legs. The
snapshot's 7-day window is one down regime (median change −9.3%), so time is
the only regime axis and the walk-forward folds are the regime test.

## The board

- 198 ranked protocols (40/40 watchlist + 20 more at/above the $50M floor + 138 early below it), every one of 758 protocols accounted for on the cover (416 already trade · 43 bridges · 43 liquid staking/restaking · 42 exchange custody · 11 versioned · 5 wrapped/staked).
- Per-row local P25–P75 bands (realised coverage 51%) and rank ranges from 200 bootstrap refits (13 of the top 20 stay top-20 in ≥80% of refits). The honest 90% conformal band is ×11.8, quoted beside the narrower sigma band ×4.71 — the wide one is the truthful one.
- Deposit-sized farm economics: deposit $1K/$5K/$25K, drop share, T-bill yield — every row re-nets to net, net/hour and break-even odds. Verdicts at the $5,000 default: 24 FARM / 103 THIN / 71 SKIP (hurdle $60, gas $12, 90-day hold). Top expected value: Steakhouse Financial, $96.6M at 38% launch odds. Expected-value total $1.49B against $3.65B conditional.
- Data-integrity strip on the cover: 758 protocols read, dedup by token id, exclusion audit, local gate replica 7/7, deterministic byte-identical rebuilds.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Node 22 stdlib only, no network. `main.ts` writes `board.json`, `data.js`,
`dashboard/` (with generated `metrics.js`), `screenshots/` and `dossier.json`
via `vendor/makefun-board.ts`.

## What did not work (tested, rejected by the 3-leg guard)

- Flipping the age coefficient positive (old R5): time-split and walk-forward both worse.
- Widening the comp pool, adding chain count as a feature, fitted momentum, growth in the odds model, category multipliers in the odds model: each fails at least one leg.
- Per-category slopes, quadratic size/age, fitted 7-day momentum as a regression feature: all fail the guard (see the ablation table on the dashboard).

## License

MIT — see [LICENSE](LICENSE).
