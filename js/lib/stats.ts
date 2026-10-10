// Small statistics toolkit used by the analysis tools.

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export const mean = (xs: readonly number[]): number => (xs.length ? sum(xs) / xs.length : NaN);

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Median absolute deviation, scaled to be comparable with a standard deviation.
export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

// The last values of a series, kept sorted as values come and go (U3.07): the median and MAD of a
// rolling window without sorting each window again, exactly as median() and mad() give them.
export class SortedWindow {
  private readonly s: number[] = [];
  private nan = 0; // NaNs in the window: not sortable, so counted apart (the median is NaN meanwhile)

  // The first place x could go in the sorted values.
  private place(x: number): number {
    let lo = 0;
    let hi = this.s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(x: number): void {
    if (Number.isNaN(x)) this.nan++;
    else this.s.splice(this.place(x), 0, x);
  }

  // Takes out one value equal to x (one added before).
  remove(x: number): void {
    if (Number.isNaN(x)) {
      this.nan = Math.max(0, this.nan - 1);
      return;
    }
    const i = this.place(x);
    if (this.s[i] === x) this.s.splice(i, 1);
  }

  median(): number {
    const s = this.s;
    if (!s.length || this.nan) return NaN;
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  // The deviations from the median grow outwards from it on both sides: merged, the middle ones
  // are the median deviation.
  mad(): number {
    const s = this.s;
    if (!s.length || this.nan) return NaN;
    const m = this.median();
    let left = this.place(m) - 1;
    let right = left + 1;
    const mid = s.length >> 1;
    let previous = NaN;
    let current = NaN;
    for (let i = 0; i <= mid; i++) {
      const l = left >= 0 ? Math.abs(s[left]! - m) : Infinity;
      const r = right < s.length ? Math.abs(s[right]! - m) : Infinity;
      previous = current;
      if (l <= r) {
        current = l;
        left--;
      } else {
        current = r;
        right++;
      }
    }
    return 1.4826 * (s.length % 2 ? current : (previous + current) / 2);
  }
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// Cohen's d between two groups (pooled standard deviation).
export function cohensD(a: readonly number[], b: readonly number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const pooled = Math.sqrt(((a.length - 1) * std(a) ** 2 + (b.length - 1) * std(b) ** 2) / (a.length + b.length - 2));
  return pooled ? (mean(a) - mean(b)) / pooled : 0;
}

export function linreg(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number } {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
