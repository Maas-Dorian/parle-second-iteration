"use client";

import { useState } from "react";
import {
  api,
  getReadableErrorMessage,
  SHARE_DURATIONS,
  type TemporaryAccess,
} from "@/lib/api";

type RedeemCodeFormProps = {
  userId: string;
  /** Called after a successful redemption so the caller can refresh / route. */
  onRedeemed: (access: TemporaryAccess) => void;
  /** Compact variant for the dashboard header (vs. the connect screen). */
  compact?: boolean;
};

/**
 * "Enter ride-share code" form. Any logged-in user can redeem a code to gain
 * temporary access to a shared vehicle for the chosen duration.
 */
export function RedeemCodeForm({ userId, onRedeemed, compact = false }: RedeemCodeFormProps) {
  const [code, setCode] = useState("");
  const [minutes, setMinutes] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRedeem() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Enter a ride-share code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const access = await api.redeemShareCode(userId, trimmed, minutes);
      setCode("");
      onRedeemed(access);
    } catch (err) {
      setError(getReadableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl border border-desat-3 bg-white p-4 ${
        compact ? "w-[300px]" : "w-full"
      }`}
    >
      <p className="text-sm font-medium text-accent-dark">Enter ride-share code</p>
      <div className="flex items-center gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="FX1-3TF"
          maxLength={7}
          spellCheck={false}
          className="h-9 w-[120px] rounded-lg border border-desat-3 bg-white px-3 font-mono text-sm uppercase tracking-wider text-accent-dark outline-none focus:border-accent-primary"
        />
        <select
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          className="h-9 flex-1 rounded-lg border border-desat-3 bg-white px-2 text-sm text-accent-dark outline-none focus:border-accent-primary"
        >
          {SHARE_DURATIONS.map((d) => (
            <option key={d.minutes} value={d.minutes}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        onClick={() => void handleRedeem()}
        disabled={busy}
        className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-accent-dark px-3 text-sm font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy && (
          <span
            aria-hidden
            className="size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        )}
        Redeem
      </button>
      {error && (
        <p role="alert" className="text-xs leading-[16px] text-[#dc2626]">
          {error}
        </p>
      )}
    </div>
  );
}
