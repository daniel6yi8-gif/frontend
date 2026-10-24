/**
 * Epoch-boundary pricing rules for vault share issuance and redemption.
 *
 * Deposits mint shares and withdrawals burn shares at a NAV that is only
 * partly realized at any moment: premium is credited and assignment losses are
 * recognized at epoch close. These rules fix which ledger state a deposit or
 * withdrawal is priced against so that entrants cannot capture premium that
 * has not yet been recognized, and exiters cannot leave before a known loss.
 *
 * See docs/vault-pricing.md for the economic rationale.
 */

/**
 * Per-vault parameters. Stored in the backend vault registry and changed only
 * through the governed parameter path, never by the frontend.
 */
export interface PricingParams {
  /** Ledgers before a close at which deposits and withdrawals stop reading that close. */
  cutoffLedgers: number;
  /** Ledgers before the next scheduled close during which deposits are disabled. */
  depositCutoffLedgers: number;
  /** Lot must be held for at least this many epochs before redemption. */
  minHoldEpochs: number;
  /** Early-exit fee in basis points, charged on a lot redeemed before `feeDecayEpochs`. */
  earlyExitFeeBps: number;
  /** Epochs over which the early-exit fee decays linearly to zero. */
  feeDecayEpochs: number;
  /**
   * Aggressive option. When true, entrants are priced without unrecognized
   * premium and exiters are paid with it, which lets a same-epoch round trip
   * capture premium. Default false (conservative).
   */
  captureUnrecognizedPremium: boolean;
}

/** Conservative defaults: no unrecognized premium capture, short hold, fee decays over 4 epochs. */
export const DEFAULT_PRICING_PARAMS: PricingParams = {
  cutoffLedgers: 100,
  depositCutoffLedgers: 100,
  minHoldEpochs: 1,
  earlyExitFeeBps: 100,
  feeDecayEpochs: 4,
  captureUnrecognizedPremium: false,
};

/** Vault NAV components at a point in time. All values are non-negative amounts. */
export interface NavSnapshot {
  /** NAV with all premium credited and all losses recognized as of the snapshot ledger. */
  recognizedNav: number;
  /** Premium earned but not yet credited on-chain. */
  pendingPremium: number;
  /** Assignment or exercise losses known but not yet recognized. */
  pendingLoss: number;
}

/**
 * Returns the ledger sequence whose closed-epoch state prices a deposit or
 * withdrawal made at `now`. It is the latest closed epoch ledger at or before
 * `now - cutoffLedgers`, so a close is only read after the cutoff window has
 * passed. Epoch ledgers may be closed late or skipped, so the function scans
 * all closed ledgers instead of assuming a fixed schedule. Returns 0 when no
 * epoch has closed yet, which means inception NAV.
 */
export function pricing_ledger_sequence(
  now: number,
  closedEpochLedgers: readonly number[],
  params: PricingParams = DEFAULT_PRICING_PARAMS
): number {
  const cutoff = now - params.cutoffLedgers;
  let sequence = 0;
  for (const ledger of closedEpochLedgers) {
    if (ledger <= cutoff && ledger > sequence) {
      sequence = ledger;
    }
  }
  return sequence;
}

/**
 * Whether deposits are accepted at `now`. Deposits close within
 * `depositCutoffLedgers` of the scheduled close. Once the scheduled close is
 * overdue, the window no longer applies, so a vault whose epoch fails to close
 * cannot be frozen indefinitely.
 */
export function isDepositWindowOpen(
  now: number,
  nextCloseLedger: number,
  params: PricingParams = DEFAULT_PRICING_PARAMS
): boolean {
  if (now > nextCloseLedger) {
    return true;
  }
  return nextCloseLedger - now > params.depositCutoffLedgers;
}

/**
 * NAV used to mint shares. Conservative: includes accrued premium so an entrant
 * cannot buy in below the value that existing holders are about to receive.
 * Known losses are not deducted, which also favours existing holders.
 */
export function mintNav(snapshot: NavSnapshot, params: PricingParams = DEFAULT_PRICING_PARAMS): number {
  return params.captureUnrecognizedPremium
    ? snapshot.recognizedNav
    : snapshot.recognizedNav + snapshot.pendingPremium;
}

/**
 * NAV used to burn shares. Conservative: excludes unrecognized premium and
 * deducts known losses, so an exiter cannot leave before a loss is recognized.
 */
export function burnNav(snapshot: NavSnapshot, params: PricingParams = DEFAULT_PRICING_PARAMS): number {
  return params.captureUnrecognizedPremium
    ? snapshot.recognizedNav + snapshot.pendingPremium
    : Math.max(0, snapshot.recognizedNav - snapshot.pendingLoss);
}

/**
 * Shares minted for a deposit of `assets`. The first deposit into an empty
 * vault mints 1:1 with assets.
 */
export function sharesForDeposit(
  assets: number,
  totalShares: number,
  snapshot: NavSnapshot,
  params: PricingParams = DEFAULT_PRICING_PARAMS
): number {
  const nav = mintNav(snapshot, params);
  if (totalShares === 0 || nav <= 0) {
    return assets;
  }
  return (assets * totalShares) / nav;
}

/**
 * Early-exit fee in basis points for a lot held for `epochsHeld` epochs.
 * Decays linearly from `earlyExitFeeBps` to zero over `feeDecayEpochs`.
 */
export function earlyExitFeeBpsFor(epochsHeld: number, params: PricingParams = DEFAULT_PRICING_PARAMS): number {
  if (params.feeDecayEpochs <= 0 || epochsHeld >= params.feeDecayEpochs) {
    return 0;
  }
  const remaining = (params.feeDecayEpochs - Math.max(0, epochsHeld)) / params.feeDecayEpochs;
  return params.earlyExitFeeBps * remaining;
}

/**
 * Assets paid out for burning `shares` from a single lot. Returns `null` when
 * the lot has not met `minHoldEpochs`. The fee is not paid out, so it stays in
 * the vault and accrues to the remaining holders. Lots are evaluated
 * individually so splitting a position across addresses does not change the
 * hold requirement or the fee.
 */
export function assetsForRedemption(
  shares: number,
  totalShares: number,
  snapshot: NavSnapshot,
  epochsHeld: number,
  params: PricingParams = DEFAULT_PRICING_PARAMS
): number | null {
  if (epochsHeld < params.minHoldEpochs || totalShares <= 0) {
    return null;
  }
  const gross = (shares * burnNav(snapshot, params)) / totalShares;
  const feeBps = earlyExitFeeBpsFor(epochsHeld, params);
  return gross - (gross * feeBps) / 10_000;
}
