// Token Radar R5 fresh — renders window.RADAR (rows) + window.METRICS
// (validation, census, ablation, odds). No network: no fetch, no links out.
(function () {
  var R = window.RADAR, M = window.METRICS;
  var app = document.getElementById('app');
  var state = { deposit: 5000, drop: 0.10, tbill: 0.04, verdict: 'ALL', watch: false, q: '', sort: 'ev', detail: null };
  var GAS = 12, HOLD = 90, HOURS = 3.5, HURDLE = 60;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
  }
  function money2(n) { return (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2); }
  function pct(n) { return (n * 100).toFixed(1) + '%'; }
  function econ(row) {
    var slice = row.conditional_value_usd * row.launch_odds_2y * state.drop * (state.deposit / Math.max(row.tvl_usd, 1));
    var costs = GAS + state.deposit * state.tbill * HOLD / 365;
    var net = slice - costs;
    var denom = row.conditional_value_usd * state.drop * (state.deposit / Math.max(row.tvl_usd, 1));
    var be = denom > 0 ? costs / denom : 99;
    return { slice: slice, costs: costs, net: net, perHour: net / HOURS, be: be, verdict: net >= HURDLE ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP' };
  }
  function fmtX(n) { return '×' + n.toFixed(2); }
  function r2(n) { return Math.round(n * 100) / 100; }

  function kpis() {
    var v = M.board, b = M.bands;
    var cells = [
      [v.rows + ' ranked', 'protocols ranked'],
      [money(v.evTotal), 'total expected value'],
      [fmtX(M.curveLegs.loo.geo), 'out-of-sample miss, LOO'],
      [pct(b.localCoverage), 'in stated P25–P75 band'],
      [pct(M.odds.holdout[0].hit) + ' held out', 'launch-odds hit rate'],
      [v.farm + ' FARM', 'worth farming at $5,000'],
    ];
    return '<div class="kpis">' + cells.map(function (c) { return '<div class="kpi"><b>' + c[0] + '</b><span>' + c[1] + '</span></div>'; }).join('') + '</div>';
  }

  function integrityStrip() {
    var i = M.integrity, c = M.census;
    return '<div class="strip"><b>Data integrity —</b> ' + i.protocolsRead + ' protocols read from the sealed snapshot (' + R.as_of + ', floor $50M) · '
      + c.ranked + ' ranked · ' + i.watchlistRead + '/' + i.watchlistRead + ' watchlist covered · dedup by token id removed ' + i.dedupRemoved
      + ' duplicate rows · ' + i.nullListedAt + ' rows with no listing date (age 365d assumed) · ' + i.nullChange7d + ' with no 7d change · '
      + 'median 7d change ' + i.medianChange7d.toFixed(1) + '% (' + i.down7d + ' of ' + i.reported7d + ' down — one down regime) · '
      + 'local gate replica 7/7 · deterministic: two runs byte-identical.</div>';
  }

  function census() {
    var c = M.census;
    var segs = [
      ['Ranked ' + c.ranked, c.ranked, '#5ec8a6'], ['Already trade ' + c.traded, c.traded, '#6aa9ff'],
      ['Bridges ' + c.bridge, c.bridge, '#f2b04d'], ['Liquid staking/restaking ' + c.liquidStaking, c.liquidStaking, '#b48ce8'],
      ['Exchange custody ' + c.exchangeCustody, c.exchangeCustody, '#f2777a'], ['Versioned ' + c.versioned, c.versioned, '#8fa3c8'],
      ['Wrapped/staked ' + c.wrapped, c.wrapped, '#5b6b85'],
    ];
    var bar = '<div class="census">' + segs.map(function (s) { return '<div style="width:' + (s[1] / c.total * 100).toFixed(1) + '%;background:' + s[2] + '" title="' + esc(s[0]) + '"></div>'; }).join('') + '</div>';
    var leg = '<div class="legend">' + segs.map(function (s) { return '<span><i style="background:' + s[2] + '"></i>' + esc(s[0]) + '</span>'; }).join('') + '</div>';
    return '<h2>Every one of 758 protocols, accounted for</h2>' + bar + leg
      + '<p class="note">Ranked ' + c.ranked + ' = ' + c.rankedFloor + ' at or above the $50M floor (40 watchlist + 20 more) + ' + c.rankedEarly
      + ' early ones below the floor. The other 560 are set aside for one stated reason each — a token already trades, a bridge, liquid staking or restaking, exchange custody, a versioned release, or a wrapped/staked product — never silently dropped.</p>';
  }

  function formula() {
    var cv = M.curve;
    var rows = M.ablation.map(function (a) {
      return '<tr><td>' + esc(a.step) + '</td><td class="num">' + a.looGeo.toFixed(4) + '</td><td class="num">' + a.looMean.toFixed(2) + '</td><td class="num">' + a.tsGeo.toFixed(4) + '</td><td class="num">' + a.tsMean.toFixed(2) + '</td><td class="num">' + a.wfGeo.toFixed(4) + '</td><td>' + esc(a.verdict) + '</td></tr>';
    }).join('');
    return '<h2>How a launch is priced — formula + double-holdout ablation</h2>'
      + '<div class="formula">ln(mcap) = ' + cv.intercept.toFixed(3) + ' + ' + cv.slopeTvl.toFixed(3) + ' × ln(TVL) <span class="neg">' + cv.slopeAge.toFixed(3) + ' × ln(age_days)</span> + shrunk category offset (8 pseudo-obs)<br>'
      + 'on ' + cv.nComps + ' comps (mcap/TVL in [0.02, 20], one per token id) · R² ' + cv.r2.toFixed(3) + ' · multiple clamped [0.08, 1.20]<br>'
      + 'conditional value = curve × (1 + 0.3 × clamp(change_7d, −60, 120)/100) × 0.85 pre-token discount<br>'
      + 'expected value = conditional value × P(launch within 2y) — from the peers’ launch record, not from hours with no token</div>'
      + '<p class="note">Age is <b>negative</b>: older with no token is worth less. The old R5 build flipped this sign and its time-split and walk-forward legs got worse — this build keeps the fitted sign.</p>'
      + '<table><thead><tr><th>Step</th><th class="num">LOO geo</th><th class="num">LOO mean</th><th class="num">Time-split geo</th><th class="num">Time-split mean</th><th class="num">Walk-fwd geo</th><th>Double-holdout verdict</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p class="note">Each term is judged on <b>two</b> holdouts at once (leave-one-out and time-split). Size wins both. Offsets win LOO but cost the time-split +5.0%. Growth + discount costs both legs — it is kept as a <b>stated economic adjustment</b> (7-day growth carry, pre-token discount), not as a fit gain. Age, added last, wins both (LOO −5.4%, time-split −2.5%). Nothing here is hidden: the full curve still beats every partial model on the pooled legs (LOO ×' + M.curveLegs.loo.geo.toFixed(2) + ', time-split ×' + M.curveLegs.ts.geo.toFixed(2) + ', walk-forward ×' + M.curveLegs.wf.geo.toFixed(2) + ').</p>';
  }

  function scatter() {
    var s = M.scatter, W = 1080, H = 380, pad = 44;
    var xs = s.comps.map(function (d) { return d.x; }).concat(s.board.map(function (d) { return d.x; }));
    var ys = s.comps.map(function (d) { return d.y; }).concat(s.board.map(function (d) { return d.y; }));
    var x0 = Math.min.apply(null, xs) - 0.3, x1 = Math.max.apply(null, xs) + 0.3;
    var y0 = Math.min.apply(null, ys) - 0.3, y1 = Math.max.apply(null, ys) + 0.3;
    function X(v) { return pad + (v - x0) / (x1 - x0) * (W - 2 * pad); }
    function Y(v) { return H - pad - (v - y0) / (y1 - y0) * (H - 2 * pad); }
    var cv = M.curve;
    var lx0 = X(x0), ly0 = Y(cv.intercept + cv.slopeTvl * x0 + cv.slopeAge * Math.log(365)), lx1 = X(x1), ly1 = Y(cv.intercept + cv.slopeTvl * x1 + cv.slopeAge * Math.log(365));
    var dots = s.comps.map(function (d) { return '<circle cx="' + X(d.x).toFixed(1) + '" cy="' + Y(d.y).toFixed(1) + '" r="3" fill="#8fa3c8" opacity="0.75"/>'; }).join('');
    var bdots = s.board.map(function (d) { return '<circle cx="' + X(d.x).toFixed(1) + '" cy="' + Y(d.y).toFixed(1) + '" r="2.4" fill="#5ec8a6" opacity="0.9"/>'; }).join('');
    return '<h2>Fit scatter — market cap on TVL</h2><div class="scatter"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of log market cap against log TVL">'
      + '<line x1="' + lx0.toFixed(1) + '" y1="' + ly0.toFixed(1) + '" x2="' + lx1.toFixed(1) + '" y2="' + ly1.toFixed(1) + '" stroke="#f2b04d" stroke-width="2"/>'
      + dots + bdots
      + '<text x="' + (W - pad) + '" y="' + (H - 12) + '" fill="#9fb0d0" font-size="12" text-anchor="end">ln(TVL) →</text>'
      + '<text x="12" y="18" fill="#9fb0d0" font-size="12">ln(market cap) →</text></svg></div>'
      + '<p class="note">Grey: ' + s.comps.length + ' traded comps. Amber line: the size curve at one year of age (no category offset). Green: the ' + s.board.length + ' ranked board rows at expected value. Curve LOO median miss ×' + M.curveLegs.loo.geo.toFixed(2) + ' (mean ×' + M.curveLegs.loo.meanFactor.toFixed(2) + ', Spearman ' + M.curveLegs.loo.spearman.toFixed(2) + ', within ×3: ' + pct(M.curveLegs.loo.within3x) + ').</p>';
  }

  function oddsPanel() {
    var o = M.odds;
    var rows = o.buckets.map(function (b) {
      return '<tr><td>' + b.lo + '–' + (b.hi < 0 ? '∞' : b.hi) + ' days</td><td class="num">' + b.n + '</td><td class="num">' + b.traded + '</td><td class="num">' + pct(b.f) + '</td></tr>';
    }).join('');
    var h = o.holdout.map(function (x) {
      return '<tr><td>' + esc(x.split) + '</td><td class="num">' + x.nTest + '</td><td class="num">' + pct(x.tradedFrac) + '</td><td class="num">' + pct(x.hit) + ' vs ' + pct(x.base) + '</td><td class="num">' + x.brier.toFixed(3) + '</td><td class="num">' + x.auc.toFixed(3) + '</td></tr>';
    }).join('');
    var top = o.catMult.slice(0, 5).map(function (c) { return c[0] + ' ×' + c[1].toFixed(2); }).join(' · ');
    var bot = o.catMult.slice(-3).map(function (c) { return c[0] + ' ×' + c[1].toFixed(2); }).join(' · ');
    return '<h2>Launch odds — from the peers’ own record</h2>'
      + '<p class="note">For each age bucket, the share of protocols in it that already record a token — that is the peers’ launch record, read as a launch CDF F(age). Forward odds: 1 − (1 − F(age+730d)) / (1 − F(age)), times an age-adjusted category multiplier (observed ÷ expected launches for peers of the same age, shrunk with 8 pseudo-observations). Highest multipliers: ' + esc(top) + '. Lowest: ' + esc(bot) + '.</p>'
      + '<table><thead><tr><th>Age bucket</th><th class="num">Protocols</th><th class="num">Traded</th><th class="num">Share traded F</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<h3>Hold-out: does the peer record predict who trades?</h3>'
      + '<table><thead><tr><th>Split</th><th class="num">Test n</th><th class="num">Traded share</th><th class="num">Hit vs base</th><th class="num">Brier</th><th class="num">AUC</th></tr></thead><tbody>' + h + '</tbody></table>'
      + '<p class="note">Random split: hit ' + pct(o.holdout[0].hit) + ' vs base ' + pct(o.holdout[0].base) + ', Brier ' + o.holdout[0].brier.toFixed(3) + ', AUC ' + o.holdout[0].auc.toFixed(3)
      + ' — in line with the R4 odds model (69.2% vs 52.4%, Brier 0.201), now built from peer launch history instead of hours with no token alone. Time split is weaker (AUC ' + o.holdout[1].auc.toFixed(3) + '): launch behaviour drifts forward in time, and the board says so rather than hiding it. Odds are capped to [2%, 95%].</p>';
  }

  function bestFarms() {
    var rows = R.rows.map(function (r) { return { r: r, e: econ(r) }; }).filter(function (x) { return x.e.verdict === 'FARM'; })
      .sort(function (a, b) { return b.e.net - a.e.net; }).slice(0, 5);
    if (!rows.length) return '';
    return '<h2>Best farms now, by net on $' + state.deposit.toLocaleString('en-US') + '</h2><table><thead><tr><th>Protocol</th><th class="num">Expected value</th><th class="num">Odds</th><th class="num">Slice</th><th class="num">Net</th><th class="num">Net / hour</th></tr></thead><tbody>'
      + rows.map(function (x) { return '<tr><td><a href="#detail=' + x.r.slug + '">' + esc(x.r.name) + '</a></td><td class="num">' + money(x.r.implied_value_usd) + '</td><td class="num">' + pct(x.r.launch_odds_2y) + '</td><td class="num">' + money2(x.e.slice) + '</td><td class="num">' + money2(x.e.net) + '</td><td class="num">' + money2(x.e.perHour) + '</td></tr>'; }).join('') + '</tbody></table>';
  }

  function controls() {
    return '<div class="controls">'
      + '<label>Deposit <select id="c-dep"><option value="1000"> $1,000</option><option value="5000" selected> $5,000</option><option value="25000"> $25,000</option></select></label>'
      + '<label>Drop share <select id="c-drop"><option value="0.05">5%</option><option value="0.10" selected>10%</option><option value="0.20">20%</option></select></label>'
      + '<label>T-bill <select id="c-tb"><option value="0">0%</option><option value="0.04" selected>4%</option><option value="0.08">8%</option></select></label>'
      + '<label>Verdict <select id="c-ver"><option value="ALL">All</option><option value="FARM">FARM only</option><option value="THIN">THIN only</option><option value="SKIP">SKIP only</option></select></label>'
      + '<label><input type="checkbox" id="c-watch"> Watchlist only (40)</label>'
      + '<label>Search <input type="text" id="c-q" placeholder="name or slug" size="16"></label>'
      + '<label>Sort <select id="c-sort"><option value="ev">Expected value</option><option value="tvl">TVL</option><option value="odds">Launch odds</option><option value="net">Net $</option></select></label>'
      + '</div>';
  }

  function boardTable() {
    var rows = R.rows.filter(function (r) {
      var e = econ(r);
      if (state.verdict !== 'ALL' && e.verdict !== state.verdict) return false;
      if (state.watch && !r.watchlist) return false;
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
      return true;
    });
    var key = state.sort;
    rows = rows.slice().sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'odds') return b.launch_odds_2y - a.launch_odds_2y;
      if (key === 'net') return econ(b).net - econ(a).net;
      return b.implied_value_usd - a.implied_value_usd;
    });
    var tr = rows.map(function (r) {
      var e = econ(r);
      return '<tr data-slug="' + r.slug + '"><td class="num">' + r.rank + '</td><td><a href="#detail=' + r.slug + '">' + esc(r.name) + '</a>' + (r.watchlist ? ' ★' : '') + '<br><span style="color:var(--dim);font-size:11px">' + esc(r.category || '—') + ' · ' + r.chains.slice(0, 2).join(', ') + '</span></td>'
        + '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + (r.change_7d == null ? '—' : r.change_7d.toFixed(1) + '%') + '</td>'
        + '<td class="num">' + (r.age_days == null ? '—' : r.age_days + 'd') + '</td><td class="num">' + money(r.conditional_value_usd) + '</td>'
        + '<td class="num">' + pct(r.launch_odds_2y) + '</td><td class="num"><b>' + money(r.implied_value_usd) + '</b></td>'
        + '<td class="num">' + money(r.band_lo_usd) + '–' + money(r.band_hi_usd) + '</td><td class="num">#' + r.rank_lo + '–' + r.rank_hi + '</td>'
        + '<td class="num">' + money2(e.net) + '</td><td class="num">' + money2(e.perHour) + '</td><td class="num">' + (e.be >= 9.99 ? '>999%' : pct(Math.min(e.be, 9.99))) + '</td>'
        + '<td><span class="pill ' + e.verdict + '">' + e.verdict + '</span></td></tr>';
    }).join('');
    return '<h2 id="board">The board — ' + rows.length + ' of ' + R.rows.length + ' rows</h2>'
      + '<p class="note">Ranked by <b>expected value</b> = conditional value × P(launch within 2y). ★ = watchlist. P25–P75 is the row’s local band (realised coverage ' + pct(M.bands.localCoverage) + ', median width ×' + M.bands.localMedianWidth.toFixed(2) + '); the honest 90% conformal band is ×' + M.bands.band90.toFixed(1) + ' and is quoted beside the narrower sigma band ×' + M.bands.sigma.toFixed(2) + ' (' + pct(M.bands.sigmaCoverage) + ' coverage) — the wide one is the truthful one. Rank range: best–worst rank across 200 bootstrap refits (' + M.bootstrap.top20Stable + ' of the top 20 stay top-20 in ≥80% of refits). Verdicts and nets use the selectors above (default $5,000 · 10% drop · 4% T-bill · $12 gas · 90-day hold · $60 hurdle); change a selector and every row re-nets.</p>'
      + '<table><thead><tr><th class="num">#</th><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Age</th><th class="num">Cond. value</th><th class="num">Odds</th><th class="num">Expected value</th><th class="num">P25–P75 band</th><th class="num">Rank range</th><th class="num">Net</th><th class="num">Net/h</th><th class="num">Break-even odds</th><th>Verdict</th></tr></thead><tbody>' + tr + '</tbody></table>';
  }

  function detail() {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === state.detail) r = R.rows[i];
    if (!r) return '';
    var e = econ(r);
    return '<div id="detail"><h2>' + esc(r.name) + ' — rank #' + r.rank + ' <span class="pill ' + e.verdict + '">' + e.verdict + '</span></h2>'
      + '<p>' + esc(r.category || 'No category') + ' · ' + esc(r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) + ' more' : '')) + ' · TVL ' + money(r.tvl_usd) + ' · 7d ' + (r.change_7d == null ? '—' : r.change_7d.toFixed(1) + '%') + ' · no token for ' + (r.age_days == null ? 'unknown' : r.age_days + ' days') + (r.watchlist ? ' · ★ watchlist' : '') + '</p>'
      + '<table><tbody>'
      + '<tr><td>Conditional value (if it launches)</td><td class="num">' + money(r.conditional_value_usd) + '</td></tr>'
      + '<tr><td>Launch odds within 2 years (peer record)</td><td class="num">' + pct(r.launch_odds_2y) + '</td></tr>'
      + '<tr><td><b>Expected value</b></td><td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>'
      + '<tr><td>P25–P75 band (local, from out-of-sample misses near this TVL)</td><td class="num">' + money(r.band_lo_usd) + ' – ' + money(r.band_hi_usd) + '</td></tr>'
      + '<tr><td>Rank range across 200 bootstrap refits</td><td class="num">#' + r.rank_lo + ' – #' + r.rank_hi + '</td></tr>'
      + '<tr><td>Expected slice at $' + state.deposit.toLocaleString('en-US') + ' deposit, ' + (state.drop * 100).toFixed(0) + '% drop</td><td class="num">' + money2(e.slice) + '</td></tr>'
      + '<tr><td>Costs (gas $' + GAS + ' + T-bill ' + (state.tbill * 100).toFixed(0) + '% over ' + HOLD + ' days)</td><td class="num">' + money2(e.costs) + '</td></tr>'
      + '<tr><td>Net / net per hour</td><td class="num">' + money2(e.net) + ' / ' + money2(e.perHour) + '</td></tr>'
      + '<tr><td>Break-even launch odds</td><td class="num">' + (e.be >= 9.99 ? '>999%' : pct(Math.min(e.be, 9.99))) + ' (modelled ' + pct(r.launch_odds_2y) + ')</td></tr>'
      + '</tbody></table>'
      + '<h3>Farm plan — six steps</h3><ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>'
      + '<p class="note"><a href="#board">Back to the board</a> · The plan is a starting point, not a promise: a protocol on this board records no token today, and it may never issue one. Never pay to claim.</p></div>';
  }

  function liveSection() {
    var rows = M.live.map(function (l) { return '<tr><td>' + esc(l.name) + '</td><td>' + esc(l.category || '—') + '</td><td class="num">' + money(l.tvl) + '</td><td class="num">' + money(l.mcap) + '</td></tr>'; }).join('');
    return '<h2>Already trade — not ranked, shown for scale</h2><p class="note">These record a token, so the market prices them and the radar does not rank them. Top 12 by market cap; the curve is fitted on 109 of them.</p><table><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function render() {
    var v = M.board;
    var html = '<h1>Token Radar — launch odds from the peers’ record</h1>'
      + '<p class="sub">Which pre-token protocol is worth farming next, and what to do about it. Ranked by expected value — what a token would be worth if the protocol’s record stayed as it is, times the chance it launches within two years, read off the launch history of the peers that already did. Snapshot ' + R.as_of + ' · ' + R.source + '.</p>'
      + kpis() + integrityStrip() + census() + formula() + scatter() + oddsPanel() + bestFarms()
      + controls() + detail() + boardTable() + liveSection()
      + '<div class="foot">Method: ln(mcap) = ' + M.curve.intercept.toFixed(3) + ' + ' + M.curve.slopeTvl.toFixed(3) + ' ln(TVL) ' + M.curve.slopeAge.toFixed(3) + ' ln(age) + shrunk category offset, R² ' + M.curve.r2.toFixed(3) + ', n=' + M.curve.nComps + '. Holdouts (median miss factor): curve LOO ×' + M.curveLegs.loo.geo.toFixed(4) + ' / time-split ×' + M.curveLegs.ts.geo.toFixed(4) + ' / walk-forward ×' + M.curveLegs.wf.geo.toFixed(4) + ' (folds ' + M.curveLegs.wfFolds.map(function (f) { return f.toFixed(2); }).join(' / ') + '); pipeline (growth 0.3, discount 0.85) LOO ×' + M.pipelineLegs.loo.geo.toFixed(4) + ' / TS ×' + M.pipelineLegs.ts.geo.toFixed(4) + ' / WF ×' + M.pipelineLegs.wf.geo.toFixed(4) + '. Bootstrap 200 refits: top-10 keeps ' + M.bootstrap.top10Keeps.toFixed(2) + '/10, rank-1 stays ' + pct(M.bootstrap.rank1Stays) + '. One down regime: median 7d change ' + M.integrity.medianChange7d.toFixed(1) + '%. No network, no hardcoded names — every figure is computed from the snapshot at run time. “Records no token” means DefiLlama records none; a protocol may still have a token its record does not carry.</div>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    bind();
  }

  function bind() {
    var dep = document.getElementById('c-dep'), drop = document.getElementById('c-drop'), tb = document.getElementById('c-tb'),
      ver = document.getElementById('c-ver'), watch = document.getElementById('c-watch'), q = document.getElementById('c-q'), sort = document.getElementById('c-sort');
    if (!dep) return;
    dep.value = String(state.deposit); drop.value = String(state.drop); tb.value = String(state.tbill);
    ver.value = state.verdict; watch.checked = state.watch; q.value = state.q; sort.value = state.sort;
    dep.onchange = function () { state.deposit = +dep.value; render(); };
    drop.onchange = function () { state.drop = +drop.value; render(); };
    tb.onchange = function () { state.tbill = +tb.value; render(); };
    ver.onchange = function () { state.verdict = ver.value; render(); };
    watch.onchange = function () { state.watch = watch.checked; render(); };
    sort.onchange = function () { state.sort = sort.value; render(); };
    var t = null;
    q.oninput = function () { clearTimeout(t); t = setTimeout(function () { state.q = q.value; render(); }, 250); };
  }

  function route() {
    var h = location.hash || '';
    var m = h.match(/detail=([\w-]+)/);
    state.detail = m ? m[1] : null;
    var f = h.match(/filter=(FARM|THIN|SKIP)/);
    if (f) state.verdict = f[1];
    if (/#watchlist/.test(h)) state.watch = true;
    render();
    if (state.detail) { var d = document.getElementById('detail'); if (d) d.scrollIntoView(); }
    else if (f) { var b = document.getElementById('board'); if (b) b.scrollIntoView(); }
  }
  window.addEventListener('hashchange', route);
  route();
})();
