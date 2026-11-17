// Forecast launch-day Twitch viewers, hour by hour (hours 2..24), from the
// hour-1 print and the release-day curves of past big game launches.
//
// Method, in log space:
//  1. For each usable comparable launch, take its release-day curve as ratios
//     to its own hour 1: r_h = ln(viewers_h / viewers_1), h = 2..24.
//  2. Weight comparables by similarity to this case: a log-normal kernel on
//     hour-1 size, upweighting console-only launches and rolling-midnight
//     unlocks (the target is console-only with a rolling midnight unlock),
//     downweighting early-access-contaminated and weak analogues.
//  3. Per hour, take weighted empirical quantiles of r_h at the five levels,
//     then shrink the weighted median toward the pooled (equal-weight) median
//     curve: logMed = 0.85 * weighted + 0.15 * pooled.
//  4. Keep the band honest: the log spread implied by the outer quantiles is
//     floored at the baseline random-walk width 0.15 * sqrt(h - 1) and capped
//     at 1.2 log units, by rescaling the quantile offsets around the median.
//  5. Lightly smooth every log-quantile curve across neighbouring hours, then
//     q_tau(h) = p1 * exp(logQ_tau(h)), rounded to 2 decimals, clamped to
//     (0, 1e9], strictly increasing within each hour.
//
// Node 22, standard library only, no network, fully deterministic: the same
// input always produces the same output bytes.
import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const SIGMA_SCALE = 0.8; // log-scale bandwidth for hour-1 size similarity
const POOLED_WEIGHT = 0.15; // shrink of the weighted median toward the pooled median
const FLOOR_RATE = 0.15; // random-walk log width per sqrt(hour - 1)
const SIGMA_CAP = 1.2; // widest log spread allowed (outer-quantile sigma)
const HOURS = Array.from({ length: 23 }, (_, i) => i + 2);

type CaseFile = {
  id: string;
  day_start: string;
  known?: Array<{ hour: number; viewers: number }>;
  comparables?: Array<{
    name: string;
    day_start: string;
    platforms?: string;
    unlock?: string;
    hourly?: Array<{ from: string; viewers: number }>;
  }>;
};

type WeightedPoint = { v: number; w: number };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function weightedQuantile(points: WeightedPoint[], tau: number): number {
  const sorted = [...points].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((acc, p) => acc + p.w, 0);
  if (total <= 0 || sorted.length === 0) return 0;
  const target = tau * total;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prevCum = cum;
    cum += sorted[i].w;
    if (cum >= target) {
      if (i === 0) return sorted[0].v;
      const f = (target - prevCum) / sorted[i].w;
      return sorted[i - 1].v + f * (sorted[i].v - sorted[i - 1].v);
    }
  }
  return sorted[sorted.length - 1].v;
}

// Similarity weight of one comparable launch against this case's hour-1 print.
function compWeight(comp: NonNullable<CaseFile["comparables"]>[number], logP1: number, v1: number): number {
  let w = Math.exp(-((Math.log(v1) - logP1) ** 2) / (2 * SIGMA_SCALE * SIGMA_SCALE));
  const platforms = comp.platforms ?? "";
  const unlock = comp.unlock ?? "";
  if (!/PC/i.test(platforms)) w *= 1.5; // console-only, like the target
  if (/midnight local|rolling/i.test(unlock)) w *= 1.5; // rolling-midnight unlock
  if (/early-access-contaminated/i.test(unlock)) w *= 0.5; // distorted release day
  if (/Tier:\s*weak/i.test(unlock)) w *= 0.5; // weak analogue
  return w;
}

// Release-day log-ratio curves, one per usable comparable: ratios[h] = r_h.
function comparableCurves(c: CaseFile): Array<{ ratios: Map<number, number>; w: number }> {
  const known = (c.known ?? []).find((k) => k.hour === 1) ?? (c.known ?? [])[0];
  const p1 = Math.max(1, known?.viewers ?? 1);
  const logP1 = Math.log(p1);
  const out: Array<{ ratios: Map<number, number>; w: number }> = [];
  for (const comp of c.comparables ?? []) {
    // The target game's own pre-release category history is not a launch curve.
    if (/Grand Theft Auto VI/i.test(comp.name)) continue;
    if (/Not a launch/i.test(comp.unlock ?? "")) continue;
    const t0 = Date.parse(comp.day_start);
    if (!Number.isFinite(t0)) continue;
    const byHour = new Map<number, number>();
    for (const pt of comp.hourly ?? []) {
      const t = Date.parse(pt.from);
      if (!Number.isFinite(t)) continue;
      const dh = (t - t0) / 3_600_000;
      if (dh >= 0 && dh < 24 && Math.abs(dh - Math.round(dh)) < 1e-9) {
        const h = Math.round(dh) + 1;
        if (typeof pt.viewers === "number" && Number.isFinite(pt.viewers)) byHour.set(h, pt.viewers);
      }
    }
    const v1 = byHour.get(1);
    if (v1 === undefined || v1 < 1 || byHour.size < 20) continue;
    const ratios = new Map<number, number>();
    for (const [h, v] of byHour) {
      if (h >= 2 && v > 0) ratios.set(h, Math.log(v / v1));
    }
    out.push({ ratios, w: compWeight(comp, logP1, v1) });
  }
  return out;
}

function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const known = (c.known ?? []).find((k) => k.hour === 1) ?? (c.known ?? [])[0];
  const p1 = Math.max(1, known?.viewers ?? 1);
  const curves = comparableCurves(c);

  // Fallback: no usable comparable (should not happen) -> persistence baseline.
  const baseline = (h: number): number[] =>
    Z.map((z) => p1 * Math.exp(z * FLOOR_RATE * Math.sqrt(h - 1)));

  if (curves.length < 3) {
    return { hours: HOURS.map((h) => ({ hour: h, q: finishRow(baseline(h)) })) };
  }

  // Per-hour weighted quantiles of r_h, plus the pooled (equal-weight) median.
  const logRows: number[][] = [];
  for (const h of HOURS) {
    const points: WeightedPoint[] = [];
    const pooled: number[] = [];
    for (const cur of curves) {
      const r = cur.ratios.get(h);
      if (r !== undefined) {
        points.push({ v: r, w: cur.w });
        pooled.push(r);
      }
    }
    if (points.length < 3) {
      logRows.push(Z.map((z) => median(pooled) + z * FLOOR_RATE * Math.sqrt(h - 1)));
      continue;
    }
    const wq = LEVELS.map((tau) => weightedQuantile(points, tau));
    const pooledMed = median(pooled);
    const med = (1 - POOLED_WEIGHT) * wq[2] + POOLED_WEIGHT * pooledMed;
    // Rescale the quantile offsets around the weighted median so the implied
    // log spread sits between the random-walk floor and the cap.
    const sigmaW = (wq[4] - wq[0]) / (2 * 1.6448536269514722);
    const floor = FLOOR_RATE * Math.sqrt(h - 1);
    const sigma = Math.min(Math.max(sigmaW, floor), SIGMA_CAP);
    let row: number[];
    if (sigmaW > 1e-9) {
      const scale = sigma / sigmaW;
      row = wq.map((v, i) => med + (v - wq[2]) * scale);
    } else {
      row = Z.map((z) => med + z * sigma);
    }
    logRows.push(row);
  }

  // Light 3-point smoothing of every log-quantile curve (keeps the unlock
  // rise and evening peak, damps quantile noise hour to hour; without it the
  // outer quantiles jump incoherently between neighbouring hours).
  for (let j = 0; j < LEVELS.length; j++) {
    const col = logRows.map((row) => row[j]);
    const smooth = col.map((v, i) =>
      i === 0 || i === col.length - 1 ? v : 0.25 * col[i - 1] + 0.5 * v + 0.25 * col[i + 1],
    );
    for (let i = 0; i < HOURS.length; i++) logRows[i][j] = smooth[i];
  }

  return {
    hours: HOURS.map((h, i) => ({
      hour: h,
      q: finishRow(logRows[i].map((lr) => p1 * Math.exp(lr))),
    })),
  };
}

// Round to 2 decimals, clamp to (0, 1e9], enforce strictly increasing quantiles.
function finishRow(q: number[]): number[] {
  const out = q.map((v) => {
    if (!Number.isFinite(v) || v <= 0) return 0.01;
    return Math.min(1e9, Math.round(v * 100) / 100);
  });
  for (let i = 1; i < out.length; i++) {
    const min = Math.ceil(out[i - 1] * 1.001 * 100) / 100;
    if (out[i] < min) out[i] = Math.min(1e9, min);
  }
  if (out[0] <= 0) out[0] = 0.01;
  return out;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.replace(/\.in$/, "");
    const c = JSON.parse(fs.readFileSync(path.join(inputDir, file), "utf8")) as CaseFile;
    const out = forecastCase(c);
    fs.writeFileSync(path.join(outputDir, `${id}.out`), JSON.stringify(out));
  }
}

main();
