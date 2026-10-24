// Black-Scholes helpers for the vault backtest harness.
// src/lib/pricing.ts is not present in this repo, so this is a self-contained copy.

const SQRT_2 = Math.SQRT2;

// Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7)
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

export function normCdf(x) {
  return 0.5 * (1 + erf(x / SQRT_2));
}

function d1(spot, strike, t, rate, iv) {
  return (Math.log(spot / strike) + (rate + 0.5 * iv * iv) * t) / (iv * Math.sqrt(t));
}

export function callPrice({ spot, strike, t, rate, iv }) {
  if (t <= 0 || iv <= 0) return Math.max(0, spot - strike);
  const d = d1(spot, strike, t, rate, iv);
  return spot * normCdf(d) - strike * Math.exp(-rate * t) * normCdf(d - iv * Math.sqrt(t));
}

export function callDelta({ spot, strike, t, rate, iv }) {
  if (t <= 0 || iv <= 0) return spot > strike ? 1 : 0;
  return normCdf(d1(spot, strike, t, rate, iv));
}
