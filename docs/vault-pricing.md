# Vault Epoch-Boundary Pricing

This document records the pricing rule for deposits and withdrawals in an
option-writing vault. The implementation is `src/lib/pricing.ts`. Parameters
are stored per vault in the backend registry and changed only through the
governed parameter path.

## Problem

A vault's NAV steps at each epoch close, when collected premium is credited and
assignment or exercise losses are recognized. Those amounts are known before
they are recognized. If shares are minted or burned at a stale NAV, an entrant
can buy just before a premium credit, or an exiter can leave just before a
known loss is recognized, and take the difference from existing holders.

## Ledger state used for pricing

`pricing_ledger_sequence(now)` returns the latest closed epoch ledger at or
before `now - cutoffLedgers`. Every mint and burn is priced against that
sequence, and the sequence should be stored with each share issuance so a
disputed mint can be re-derived from indexed history. Epoch ledgers may be
closed late or skipped, so the function scans the closed-epoch list instead of
assuming a fixed schedule. If no epoch has closed, it returns `0` (inception NAV).

## Pricing NAV (conservative default)

The vault keeps three components per snapshot: `recognizedNav`, `pendingPremium`,
and `pendingLoss`.

- **Mint** uses `recognizedNav + pendingPremium`. An entrant cannot buy in
  below the value that existing holders are about to receive.
- **Burn** uses `max(0, recognizedNav - pendingLoss)`. Unrecognized premium is
  excluded, and known losses are deducted, so an exiter cannot leave before a
  loss is recognized.

The mint and burn prices bracket the recognized NAV. A deposit followed by an
immediate withdrawal in the same epoch therefore returns at most the deposited
amount (`burnNav <= mintNav`), before any configured fee.

The aggressive option `captureUnrecognizedPremium` reverses the bracket: mints
use `recognizedNav` and burns use `recognizedNav + pendingPremium`. Under that
setting, a same-epoch round trip can capture premium, so it is off by default and
must be explicitly enabled per vault.

## Hold period and early-exit fee

- **Minimum hold:** `minHoldEpochs` applies per vault-share lot, not per address.
  Splitting a position across accounts does not shorten the hold.
- **Early-exit fee:** a lot redeemed before `feeDecayEpochs` pays
  `earlyExitFeeBps`, decaying linearly to zero. The fee is not paid out, so it
  stays in the vault and accrues to the remaining holders. This routing is
  deterministic and must be disclosed in the deposit flow.
- **Deposit cutoff:** deposits close within `depositCutoffLedgers` of the
  scheduled close. Once the scheduled close is overdue, the window no longer
  applies, so a vault whose epoch fails to close cannot be frozen.

## Withdrawal queue

Queued withdrawals must use the same `burnNav` and `pricing_ledger_sequence`
as immediate redemption. Otherwise the queue becomes the bypass.

## Default parameters

| Parameter                       | Default | Meaning                                     |
| ------------------------------- | ------- | ------------------------------------------- |
| `cutoffLedgers`                 | 100     | Ledgers before a close that stop reading it |
| `depositCutoffLedgers`          | 100     | Deposit freeze window before scheduled close |
| `minHoldEpochs`                 | 1       | Minimum epochs a lot must be held           |
| `earlyExitFeeBps`               | 100     | Early-exit fee (1%) at zero epochs held     |
| `feeDecayEpochs`                | 4       | Epochs over which the fee decays to zero    |
| `captureUnrecognizedPremium`    | false   | Aggressive option, off by default           |

## Status

The pure functions are implemented in `src/lib/pricing.ts`. The frontend does
not hold vault state, so nothing here is wired to a live vault. The `contracts/`
NAV and epoch modules, the backend parameter registry, and the historical epoch
ledger service are not in this repository and must apply the same rules.
