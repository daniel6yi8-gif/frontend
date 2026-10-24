// Deterministic covered-call epoch loop over a historical option-chain dataset.
// stepEpoch is a pure function of (state, snapshot, nextSpot, params).
//
// Fallbacks (explicit, never silent):
//   no_quote   - snapshot has no calls: epoch runs unhedged, counted in noQuoteEpochs
//   off_target - best available delta is further than DELTA_TOLERANCE from target:
//                the nearest-delta call is still sold, counted in offTargetEpochs

import { callDelta, callPrice } from './pricing.mjs';

export const DEFAULT_PARAMS = {
  targetDelta: 0.3,
  feeBps: 0,
  rate: 0,
  assignmentPolicy: 'deliver', // 'deliver': hand over units and hold cash; 'rebuy': repurchase units at next spot
};

export const DELTA_TOLERANCE = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;

export function selectCall(snapshot, { targetDelta, rate }) {
  const t = snapshot.tenorDays / 365;
  const ranked = [...snapshot.calls]
    .sort((a, b) => a.strike - b.strike)
    .map((c) => ({ ...c, delta: callDelta({ spot: snapshot.spot, strike: c.strike, t, rate, iv: c.iv }) }))
    .sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta));

  if (ranked.length === 0) return { call: null, fallback: 'no_quote' };
  const best = ranked[0];
  const fallback = Math.abs(best.delta - targetDelta) > DELTA_TOLERANCE ? 'off_target' : null;
  return { call: best, fallback };
}

export function stepEpoch(state, snapshot, nextSpot, params) {
  const { rate, feeBps, assignmentPolicy } = params;
  const t = snapshot.tenorDays / 365;
  const spot = snapshot.spot;

  const { call, fallback } = state.units > 0 ? selectCall(snapshot, params) : { call: null, fallback: null };

  let premiumGross = 0;
  let fee = 0;
  let assigned = false;
  let assignmentLoss = 0;
  let units = state.units;
  let cash = state.cash;

  if (call) {
    premiumGross = callPrice({ spot, strike: call.strike, t, rate, iv: call.iv }) * units;
    fee = (premiumGross * feeBps) / 10000;
    assigned = nextSpot > call.strike;
    if (assigned) {
      assignmentLoss = units * (nextSpot - call.strike);
      cash += call.strike * units;
      units = 0;
    }
  }

  cash += premiumGross - fee;

  if (assigned && assignmentPolicy === 'rebuy') {
    units = cash / nextSpot;
    cash = 0;
  }

  const underlyingPnl = state.units * (nextSpot - spot);
  const navStart = state.units * spot + state.cash;
  const navEnd = units * nextSpot + cash;

  return {
    state: { units, cash },
    events: {
      written: call !== null,
      assigned,
      fallback,
      strike: call ? call.strike : null,
      premiumNet: premiumGross - fee,
      fee,
      underlyingPnl,
      assignmentLoss,
      navStart,
      navEnd,
    },
  };
}

function maxDrawdown(series) {
  let peak = series[0];
  let worst = 0;
  for (const nav of series) {
    peak = Math.max(peak, nav);
    worst = Math.min(worst, nav / peak - 1);
  }
  return worst;
}

export function validateDataset(dataset) {
  if (!dataset || typeof dataset.revision !== 'string' || !Array.isArray(dataset.snapshots)) {
    throw new Error('dataset must have a string revision and a snapshots array');
  }
  if (dataset.snapshots.length < 2) {
    throw new Error('dataset needs at least two snapshots to run one epoch');
  }
  dataset.snapshots.forEach((s, i) => {
    if (!(s.spot > 0) || !(s.tenorDays > 0) || !Array.isArray(s.calls) || Number.isNaN(Date.parse(s.date))) {
      throw new Error(`snapshot ${i} is missing date, spot, tenorDays or calls`);
    }
  });
}

export function runBacktest(dataset, overrides = {}) {
  validateDataset(dataset);
  const params = { ...DEFAULT_PARAMS, ...overrides };
  if (!['deliver', 'rebuy'].includes(params.assignmentPolicy)) {
    throw new Error(`unknown assignmentPolicy: ${params.assignmentPolicy}`);
  }
  const { snapshots } = dataset;
  const first = snapshots[0];

  // Start fully invested in one unit of notional so NAV-per-share begins at 1
  let state = { units: 1 / first.spot, cash: 0 };
  const navSeries = [{ date: first.date, navPerShare: 1 }];
  const totals = { premiumRealized: 0, underlyingPnl: 0, assignmentLoss: 0, fees: 0 };
  const counts = { epochs: 0, rollovers: 0, assignments: 0, noQuoteEpochs: 0, offTargetEpochs: 0 };
  let navPerShare = 1;

  for (let i = 0; i < snapshots.length - 1; i++) {
    const { state: next, events } = stepEpoch(state, snapshots[i], snapshots[i + 1].spot, params);
    state = next;
    counts.epochs++;
    if (events.written) counts.rollovers++;
    if (events.assigned) counts.assignments++;
    if (events.fallback === 'no_quote') counts.noQuoteEpochs++;
    if (events.fallback === 'off_target') counts.offTargetEpochs++;
    totals.premiumRealized += events.premiumNet;
    totals.underlyingPnl += events.underlyingPnl;
    totals.assignmentLoss += events.assignmentLoss;
    totals.fees += events.fee;
    navPerShare *= events.navEnd / events.navStart;
    navSeries.push({ date: snapshots[i + 1].date, navPerShare });
  }

  const navEnd = navPerShare;
  const days = (Date.parse(snapshots[snapshots.length - 1].date) - Date.parse(first.date)) / DAY_MS;
  const apy = days > 0 ? Math.pow(navEnd, 365 / days) - 1 : 0;

  return {
    disclaimer: 'Historical simulation, not a forecast.',
    dataset: { underlying: dataset.underlying ?? null, revision: dataset.revision },
    params,
    navSeries,
    apy,
    maxDrawdown: maxDrawdown(navSeries.map((p) => p.navPerShare)),
    counts,
    totals,
  };
}
