import { api, ApiError } from "./api";

export type VaultOperation = "deposit" | "withdrawal_request" | "redemption_claim";

/** `unknown` = ambiguous outcome; the backend reconciler resolves it against the chain. */
export type VaultJournalState =
  | "created"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown";

export interface VaultJournalEntry {
  id: string;
  idempotency_key: string;
  account: string;
  operation: VaultOperation;
  state: VaultJournalState;
  amount: string;
  tx_hash?: string;
  ledger_sequence?: number;
  shares?: string;
  premiums?: string;
  error?: string;
  /** True only when on-chain evidence shows a failed intent applied nothing. */
  safe_to_replay?: boolean;
  created_at: string;
  updated_at: string;
}

export interface VaultMutationRequest {
  account: string;
  amount: string;
}

const MUTATION_PATHS: Record<VaultOperation, string> = {
  deposit: "/vaults/deposit",
  withdrawal_request: "/vaults/withdrawals",
  redemption_claim: "/vaults/redemptions",
};

export function isTerminalState(state: VaultJournalState): boolean {
  return state === "confirmed" || state === "failed";
}

/** Retrying is only offered after a terminal failure with on-chain proof nothing applied. */
export function canRetryEntry(entry: VaultJournalEntry): boolean {
  return entry.state === "failed" && entry.safe_to_replay === true;
}

/**
 * Generate a client-side idempotency key for one user intent. Create it once
 * per intent (e.g. when the form is opened) and reuse it for every retry.
 * The backend scopes keys per depositor account and operation type.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function stellarExplorerUrl(
  txHash: string,
  network: "public" | "testnet" = "public",
): string {
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

/**
 * Submit a vault mutation. Always sends the idempotency key so duplicates
 * (double clicks, timeouts followed by retries) resolve to the original journal row.
 */
export async function submitVaultMutation(
  operation: VaultOperation,
  request: VaultMutationRequest,
  idempotencyKey: string,
): Promise<VaultJournalEntry> {
  return api.post<VaultJournalEntry>(MUTATION_PATHS[operation], request, {
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function getVaultJournalEntry(
  idempotencyKey: string,
  operation: VaultOperation,
  account: string,
): Promise<VaultJournalEntry> {
  const params = new URLSearchParams({ operation, account });
  return api.get<VaultJournalEntry>(
    `/vaults/journal/${encodeURIComponent(idempotencyKey)}?${params.toString()}`,
  );
}

export async function listVaultJournal(
  account: string,
): Promise<VaultJournalEntry[]> {
  return api.get<VaultJournalEntry[]>(
    `/vaults/journal?account=${encodeURIComponent(account)}`,
  );
}

/**
 * Submit with retry. A network error, timeout or 5xx is ambiguous: the request
 * may have been accepted. Never assume failure — retry with the SAME key (the
 * backend returns the original result) and fall back to reading the journal.
 * 409 means the original is still in flight; read the journal for its state.
 */
export async function submitVaultMutationWithRetry(
  operation: VaultOperation,
  request: VaultMutationRequest,
  idempotencyKey: string,
  {
    maxAttempts = 4,
    baseDelayMs = 500,
  }: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<VaultJournalEntry> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
    try {
      return await submitVaultMutation(operation, request, idempotencyKey);
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError) {
        if (error.status === 409) {
          try {
            return await getVaultJournalEntry(
              idempotencyKey,
              operation,
              request.account,
            );
          } catch (lookupError) {
            lastError = lookupError;
            continue;
          }
        }
        // Definite client errors will not change on retry.
        if (
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429
        ) {
          throw error;
        }
      }
    }
  }
  // Retries exhausted: surface whatever the journal knows rather than a bare failure.
  try {
    return await getVaultJournalEntry(idempotencyKey, operation, request.account);
  } catch {
    throw lastError;
  }
}
