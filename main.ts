// Token radar R5 fresh — entrypoint (Node 22 stdlib only, no network).
//
// Reads /input/snapshot.json, fits the value curve + peer-record launch
// odds, writes /output/board.json + /output/data.js, copies dashboard/ and
// screenshots/ to /output, writes the generated dashboard/metrics.js (the
// cover's numbers, so the dossier's source text carries them), and writes
// /output/dossier.json with buildDossier from vendor/makefun-board.ts.
//
// Outside the grader: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// --input <kit>/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, parseSnapshot, MODEL_VERSION } from './lib/model.ts';
import { validate } from './lib/validation.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { validation, board } = validate(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

const radar = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  model_version: MODEL_VERSION,
  watchlist_size: snapshot.watchlist.length,
  board_size: board.length,
  rows: board,
  validation,
};
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The cover's numbers, generated from this run's validation, so the
// dossier's source text (dashboard/) carries the same figures the page shows.
writeFileSync(join(out, 'dashboard', 'metrics.js'), `window.METRICS=${JSON.stringify(validation)};\n`);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored\n` +
    `token radar: curve ln(mcap) = ${validation.curve.intercept.toFixed(3)} + ${validation.curve.slopeTvl.toFixed(3)} ln(TVL) ${validation.curve.slopeAge.toFixed(3)} ln(age), R2 ${validation.curve.r2.toFixed(3)}, n=${validation.curve.nComps}\n` +
    `token radar: curve LOO x${validation.curveLegs.loo.geo.toFixed(4)} / TS x${validation.curveLegs.ts.geo.toFixed(4)} / WF x${validation.curveLegs.wf.geo.toFixed(4)}; pipeline LOO x${validation.pipelineLegs.loo.geo.toFixed(4)} / TS x${validation.pipelineLegs.ts.geo.toFixed(4)} / WF x${validation.pipelineLegs.wf.geo.toFixed(4)}\n` +
    `token radar: verdicts ${validation.board.farm} FARM / ${validation.board.thin} THIN / ${validation.board.skip} SKIP; top EV $${validation.board.topEv.toLocaleString('en-US')} (${validation.board.topSlug})\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
