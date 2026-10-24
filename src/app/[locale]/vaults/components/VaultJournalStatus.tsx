"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import {
  VaultJournalEntry,
  canRetryEntry,
  stellarExplorerUrl,
} from "@/lib/api/vaults";

interface VaultJournalStatusProps {
  entry: VaultJournalEntry;
  onRetry?: () => void;
}

const LABELS: Record<VaultJournalEntry["state"], string> = {
  created: "Preparing transaction",
  submitted: "Submitted, awaiting confirmation",
  confirmed: "Confirmed",
  failed: "Failed",
  unknown: "Verifying outcome on-chain",
};

const VARIANTS: Record<
  VaultJournalEntry["state"],
  "default" | "success" | "warning" | "destructive"
> = {
  created: "default",
  submitted: "warning",
  confirmed: "success",
  failed: "destructive",
  unknown: "warning",
};

export const VaultJournalStatus: React.FC<VaultJournalStatusProps> = ({
  entry,
  onRetry,
}) => (
  <div role="status" aria-live="polite" className="space-y-2">
    <Badge variant={VARIANTS[entry.state]}>{LABELS[entry.state]}</Badge>
    {entry.tx_hash && (
      <p className="text-sm">
        <a
          href={stellarExplorerUrl(entry.tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          View on explorer
        </a>
      </p>
    )}
    {entry.state === "unknown" && (
      <p className="text-sm">
        Do not resubmit. We are checking the network for this transaction.
      </p>
    )}
    {entry.state === "confirmed" && entry.shares && (
      <p className="text-sm">Shares credited: {entry.shares}</p>
    )}
    {entry.state === "failed" && entry.error && (
      <p className="text-sm">{entry.error}</p>
    )}
    {/* Never offered while submitted/unknown; only after a failure proven to have applied nothing. */}
    {onRetry && canRetryEntry(entry) && (
      <button type="button" onClick={onRetry} className="min-h-[44px] underline">
        Retry
      </button>
    )}
  </div>
);
