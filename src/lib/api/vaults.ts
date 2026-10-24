import { logger } from "../logger";
import { api, ApiError } from "./api";

/**
 * Vault storage TTL / state-archival policy (mirrors the contract's TTL
 * helper). All values are in ledgers (~5s each on Stellar).
 *
 * Every write extends the entries it touches to at least `min`; the batched
 * maintenance entry point extends entries whose remaining TTL has dropped
 * below `min` up to `target`.
 */
export const LEDGERS_PER_DAY = 17_280;

export type VaultKeyClass = "depositor" | "epoch" | "config";

export interface VaultTtlPolicy {
  /** Extend when remaining TTL falls below this many ledgers. */
  min: number;
  /** Extend up to this many ledgers. */
  target: number;
  /** Backend alerts when an entry is within this many ledgers of expiry. */
  warning: number;
}

export const VAULT_TTL_POLICY: Record<VaultKeyClass, VaultTtlPolicy> = {
  // Share balances, deposit intents, strategy state: one per depositor.
  depositor: {
    min: 30 * LEDGERS_PER_DAY,
    target: 60 * LEDGERS_PER_DAY,
    warning: 14 * LEDGERS_PER_DAY,
  },
  // Epoch ledger rows: append-only, read rarely after settlement.
  epoch: {
    min: 60 * LEDGERS_PER_DAY,
    target: 120 * LEDGERS_PER_DAY,
    warning: 21 * LEDGERS_PER_DAY,
  },
  // Global config: critical to every call, so kept far from expiry.
  config: {
    min: 90 * LEDGERS_PER_DAY,
    target: 180 * LEDGERS_PER_DAY,
    warning: 45 * LEDGERS_PER_DAY,
  },
};

export interface ExpiringVaultEntry {
  key: string;
  key_class: VaultKeyClass;
  live_until_ledger: number;
  ledgers_remaining: number;
  archived: boolean;
}

export interface VaultTtlStatus {
  contract_id: string;
  current_ledger: number;
  expiring: ExpiringVaultEntry[];
  archived_count: number;
}

export interface VaultRentCost {
  contract_id: string;
  epoch: number;
  /** Rent spent by maintenance runs in the epoch, in stroops. */
  rent_stroops: string;
  entries_extended: number;
}

export interface VaultRestoreResult {
  restored: string[];
  /** Entries skipped because a newer on-chain write superseded the snapshot. */
  skipped: string[];
}

export class VaultStateRestoredError extends Error {
  restored: string[];

  constructor(restored: string[]) {
    super("Vault state was archived and has been restored. Please retry.");
    this.name = "VaultStateRestoredError";
    this.restored = restored;
  }
}

export class VaultStateArchivedError extends Error {
  constructor(message = "Vault state is archived and could not be restored automatically.") {
    super(message);
    this.name = "VaultStateArchivedError";
  }
}

const ARCHIVED_PATTERN = /archived|entry expired|restore(?:\s+footprint)?|ttl expired/i;

/** True when an error from a vault call indicates archived contract state. */
export function isArchivedStateError(error: unknown): boolean {
  if (error instanceof ApiError) {
    const data = error.data as { code?: string } | undefined;
    return data?.code === "STATE_ARCHIVED" || ARCHIVED_PATTERN.test(error.message);
  }
  return error instanceof Error && ARCHIVED_PATTERN.test(error.message);
}

/** Ledgers remaining before an entry should trigger a warning for its class. */
export function isWithinWarningWindow(entry: ExpiringVaultEntry): boolean {
  return entry.ledgers_remaining <= VAULT_TTL_POLICY[entry.key_class].warning;
}

export async function getVaultTtlStatus(
  contractId: string,
): Promise<VaultTtlStatus> {
  return api.get<VaultTtlStatus>(
    `/vaults/${encodeURIComponent(contractId)}/ttl`,
  );
}

export async function getVaultRentCosts(
  contractId: string,
): Promise<VaultRentCost[]> {
  return api.get<VaultRentCost[]>(
    `/vaults/${encodeURIComponent(contractId)}/rent-costs`,
  );
}

/**
 * Ask the backend to restore archived entries from its indexed value
 * snapshot. The backend compares value/ledger before overwriting so a
 * concurrent legitimate write is never clobbered.
 */
export async function restoreVaultState(
  contractId: string,
  keys?: string[],
): Promise<VaultRestoreResult> {
  return api.post<VaultRestoreResult>(
    `/vaults/${encodeURIComponent(contractId)}/restore`,
    keys ? { keys } : undefined,
  );
}

/**
 * Run a vault operation. If it fails because state was archived, restore it
 * and surface a clear "state restored, please retry" error instead of the raw
 * contract error.
 */
export async function withVaultStateRestore<T>(
  contractId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isArchivedStateError(error)) throw error;

    logger.warn(`Vault ${contractId} state archived; attempting restore`);
    try {
      const result = await restoreVaultState(contractId);
      throw new VaultStateRestoredError(result.restored);
    } catch (restoreError) {
      if (restoreError instanceof VaultStateRestoredError) throw restoreError;
      logger.error("Vault state restore failed:", restoreError);
      throw new VaultStateArchivedError();
    }
  }
}
