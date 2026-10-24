import type {
  VaultJournalEntry,
  VaultMutationRequest,
  VaultOperation,
} from "../src/lib/api/vaults";

/**
 * In-memory mock of the idempotent vault mutation endpoints. Journal rows are
 * keyed by (account, operation, idempotency key), so duplicates return the
 * original row and never create a second effect.
 */
export class MockVaultBackend {
  private journal = new Map<string, VaultJournalEntry>();
  private shares = new Map<string, number>();

  private rowKey(account: string, operation: VaultOperation, key: string) {
    return `${account}:${operation}:${key}`;
  }

  submit(
    operation: VaultOperation,
    req: VaultMutationRequest,
    key: string,
  ): VaultJournalEntry {
    const id = this.rowKey(req.account, operation, key);
    const existing = this.journal.get(id);
    if (existing) return existing;

    const now = new Date().toISOString();
    const entry: VaultJournalEntry = {
      id,
      idempotency_key: key,
      account: req.account,
      operation,
      state: "submitted",
      amount: req.amount,
      tx_hash: this.journal.size.toString(16).padStart(64, "0"),
      created_at: now,
      updated_at: now,
    };
    this.journal.set(id, entry);
    return entry;
  }

  /** Simulates the reconciler observing the transaction on-chain; credits shares once. */
  confirm(
    account: string,
    operation: VaultOperation,
    key: string,
    ledger = 1,
  ): VaultJournalEntry | undefined {
    const entry = this.journal.get(this.rowKey(account, operation, key));
    if (!entry || entry.state === "confirmed") return entry;
    entry.state = "confirmed";
    entry.ledger_sequence = ledger;
    entry.shares = entry.amount;
    entry.updated_at = new Date().toISOString();
    this.shares.set(account, (this.shares.get(account) ?? 0) + Number(entry.amount));
    return entry;
  }

  get(account: string, operation: VaultOperation, key: string) {
    return this.journal.get(this.rowKey(account, operation, key));
  }

  list(account: string) {
    return [...this.journal.values()].filter((e) => e.account === account);
  }

  sharesFor(account: string) {
    return this.shares.get(account) ?? 0;
  }
}
