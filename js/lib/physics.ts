// Plunger physics for a die-casting shot sleeve, used as a "virtual sensor".
//
// Equation of motion for the plunger:  m·a = Ph·Ah − Pm·Am − F
// Every shot payload carries displacement, velocity, hydraulic and metal
// pressure. Solving for F gives the friction the plunger saw on that shot,
// which nobody can measure directly but which rises before a seizure.

import { createRng, type Rng } from './rng.ts';
import { median, mad } from './stats.ts';
import type {
  Detection,
  DowntimeEvent,
  FrictionAlert,
  PlungerSpec,
  ScoredEvent,
  ShotHistory,
  ShotPayload,
  ShotRecord,
} from './types.ts';

export const PLUNGER: PlungerSpec = {
  mass: 42, // kg, plunger + rod
  hydraulicArea: 0.0079, // m², hydraulic piston
  metalArea: 0.0028, // m², plunger tip
  samples: 80,
  dt: 0.005, // s between samples
};

const BAR = 1e5; // Pa per bar

function velocityProfile(i: number): number {
  // Slow phase to fill the sleeve, then the fast shot, then intensification.
  if (i < 30) return 0.35 * Math.min(1, i / 8);
  if (i < 55) return 0.35 + (4.2 - 0.35) * Math.min(1, (i - 30) / 6);
  return Math.max(0.05, 4.2 * Math.exp(-(i - 55) / 3));
}

// Generate one shot payload for a given true friction force (N).
export function simulateShot(friction: number, rng: Rng, p: PlungerSpec = PLUNGER): ShotPayload {
  const shot: ShotPayload = { t: [], x: [], v: [], ph: [], pm: [] };
  let pos = 0;
  for (let i = 0; i < p.samples; i++) {
    const vel = velocityProfile(i);
    const prev = i ? velocityProfile(i - 1) : 0;
    const acc = (vel - prev) / p.dt;
    pos += vel * p.dt;
    const metal = (i < 55 ? 8 + 30 * (i / 55) ** 2 : 38 + 260 * (1 - Math.exp(-(i - 55) / 6))) * BAR;
    const fr = friction * (1 + 0.04 * rng.normal());
    const hyd = (p.mass * acc + metal * p.metalArea + fr) / p.hydraulicArea;
    shot.t.push(i * p.dt);
    shot.x.push(pos);
    shot.v.push(vel * (1 + 0.01 * rng.normal()));
    shot.ph.push((hyd / BAR) * (1 + 0.002 * rng.normal()));
    shot.pm.push((metal / BAR) * (1 + 0.002 * rng.normal()));
  }
  return shot;
}

// Estimate friction for one shot from its payload: robust median of the
// per-sample residual of the equation of motion.
export function estimateFriction(shot: ShotPayload, p: PlungerSpec = PLUNGER): number {
  const residuals: number[] = [];
  for (let i = 1; i < shot.t.length; i++) {
    const dt = shot.t[i]! - shot.t[i - 1]!;
    if (dt <= 0) continue; // a repeated or out-of-order timestamp: no acceleration to speak of
    const acc = (shot.v[i]! - shot.v[i - 1]!) / dt;
    const force = shot.ph[i]! * BAR * p.hydraulicArea - shot.pm[i]! * BAR * p.metalArea - p.mass * acc;
    residuals.push(force);
  }
  return median(residuals);
}

// A history of shots on one machine with a few seizure episodes: friction
// creeps up over the episode, then the machine goes down.
export function generateShotHistory({ seed = 7, shots = 1600, cycleSeconds = 95 } = {}): ShotHistory {
  const rng = createRng(seed);
  const episodes = [
    { start: 420, end: 560 },
    { start: 980, end: 1090 },
    { start: 1380, end: 1500 },
  ];
  const downtime: DowntimeEvent[] = episodes.map((e, k) => ({
    id: `DT-${101 + k}`,
    shot: e.end,
    code: k === 1 ? 'DT-LUBRICATION' : 'DT-SEIZURE',
    durationMin: rng.int(50, 180),
  }));
  const baseline = 1800;
  const history: ShotRecord[] = [];
  for (let i = 0; i < shots; i++) {
    let friction = baseline + 60 * Math.sin(i / 90) + rng.normal(0, 40);
    for (const e of episodes) {
      if (i >= e.start && i < e.end) {
        const f = (i - e.start) / (e.end - e.start);
        friction += 2200 * f ** 2.2;
      }
    }
    const shot = simulateShot(friction, rng);
    history.push({
      index: i,
      time: i * cycleSeconds,
      trueFriction: friction,
      friction: estimateFriction(shot),
    });
  }
  return { history, downtime, cycleSeconds };
}

// Threshold against the previous `window` shots; alert after `persist`
// consecutive shots over `k` robust sigmas.
export function detectFrictionAlerts(
  history: readonly ShotRecord[],
  { window = 200, k = 4, persist = 3 } = {},
): Detection {
  const flags: boolean[] = new Array<boolean>(history.length).fill(false);
  const thresholds: (number | null)[] = new Array<number | null>(history.length).fill(null);
  const alerts: FrictionAlert[] = [];
  let run = 0;
  let open: FrictionAlert | null = null;
  for (let i = window; i < history.length; i++) {
    const past = history.slice(i - window, i).map((s) => s.friction);
    const base = median(past);
    const spread = mad(past) || 1;
    const limit = base + k * spread;
    const friction = history[i]!.friction;
    thresholds[i] = limit;
    if (friction > limit) {
      run++;
      if (run >= persist) {
        flags[i] = true;
        if (!open) {
          open = { firstShot: i, lastShot: i, peak: friction };
          alerts.push(open);
        }
        open.lastShot = i;
        open.peak = Math.max(open.peak, friction);
      }
    } else {
      run = 0;
      open = null;
    }
  }
  return { flags, thresholds, alerts };
}

// Pair alerts with downtime events and compute warning lead time.
export function scoreAlerts(
  alerts: readonly FrictionAlert[],
  downtime: readonly DowntimeEvent[],
  cycleSeconds: number,
): ScoredEvent[] {
  return downtime.map((dt) => {
    const first = alerts.find((a) => a.firstShot <= dt.shot && dt.shot - a.firstShot < 300) ?? null;
    return {
      ...dt,
      predicted: Boolean(first),
      leadShots: first ? dt.shot - first.firstShot : 0,
      leadHours: first ? ((dt.shot - first.firstShot) * cycleSeconds) / 3600 : 0,
    };
  });
}
