// Deterministic pseudo-random numbers so every demo dataset is reproducible.

export function createRng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = (mu = 0, sigma = 1) => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return mu + sigma * v;
    }
    let u = 0;
    let w = 0;
    while (u === 0) u = next();
    while (w === 0) w = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * w);
    return mu + sigma * r * Math.cos(2 * Math.PI * w);
  };
  return {
    next,
    normal,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
