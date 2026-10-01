"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getReadableErrorMessage,
  getShareCode,
  regenerateShareCode,
  revokeTemporaryAccess,
  type ShareCode,
  type TemporaryAccess,
  type VehiclePermissions,
} from "@/lib/api";
import { formatExpiry, useNow } from "@/lib/format";
import { Badge } from "@/components/Badge";

type ShareCodePanelProps = {
  userId: string;
  /** The single owned vehicle this share section controls. */
  vehicleId: string;
  /** Active guest grants on this vehicle (owner view), passed from the dashboard. */
  guestAccesses: TemporaryAccess[];
  /** Called after a code/access change so the dashboard can refetch. */
  onChanged: () => void;
};

function allowedSummary(p: VehiclePermissions): string {
  const on = (
    [
      ["status", "Status"],
      ["wake", "Wake"],
      ["lock", "Lock"],
      ["unlock", "Unlock"],
      ["ready", "Ready"],
      ["enableDrive", "Drive"],
    ] as [keyof VehiclePermissions, string][]
  )
    .filter(([k]) => p[k])
    .map(([, label]) => label);
  return on.length ? on.join(" · ") : "View only";
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Owner-only "Share access" section for a single vehicle:
 *  - shows / generates the active ride-share code (copy + regenerate)
 *  - lists active guest grants with their expiry, permissions and a revoke button
 */
export function ShareCodePanel({
  userId,
  vehicleId,
  guestAccesses,
  onChanged,
}: ShareCodePanelProps) {
  const [code, setCode] = useState<ShareCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    if (!vehicleId) return;
    try {
      const c = await getShareCode(userId, vehicleId);
      setCode(c);
      setError(null);
    } catch (err) {
      setCode(null);
      setError(getReadableErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId, vehicleId]);

  useEffect(() => {
    const begin = () => {
      setLoading(true);
      setCopied(false);
      void load();
    };
    begin();
  }, [load]);

  async function regenerate() {
    if (!vehicleId) return;
    setRegenerating(true);
    setError(null);
    try {
      const c = await regenerateShareCode(userId, vehicleId);
      setCode(c);
      setCopied(false);
    } catch (err) {
      setError(getReadableErrorMessage(err));
    } finally {
      setRegenerating(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context) — ignore.
    }
  }

  async function revoke(accessId: string) {
    setRevokingId(accessId);
    try {
      await revokeTemporaryAccess(userId, accessId);
      onChanged();
    } catch (err) {
      setError(getReadableErrorMessage(err));
    } finally {
      setRevokingId(null);
    }
  }

  const expiry = code ? formatExpiry(code.expiresAt, now) : null;

  return (
    <section className="flex flex-col gap-3 border-t border-desat-2 pt-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-accent-dark">Share access</h4>
        <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-primary">
          Owner
        </span>
      </div>

      {/* Code row */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-desat-3 bg-desat-0 p-3">
        <span className="font-mono text-2xl font-bold tracking-[2px] text-accent-primary">
          {loading ? "······" : code?.code ?? "—"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!code}
            className="h-9 rounded-lg border border-desat-3 bg-white px-3 text-sm font-medium text-accent-dark transition-colors hover:bg-desat-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={regenerating}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-accent-dark px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {regenerating && (
              <span
                aria-hidden
                className="size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
            )}
            Regenerate
          </button>
        </div>
      </div>

      <p className="text-xs leading-4 text-desat-7">
        {error
          ? error
          : code
          ? `Share this code with a guest — ${expiry?.label ?? "active"}. They choose how long their access lasts when redeeming.`
          : "Generating a code…"}
      </p>

      {/* Active guests */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-accent-dark">
          Active guest access ({guestAccesses.length})
        </p>
        {guestAccesses.length === 0 ? (
          <p className="text-xs text-desat-7">
            No one has redeemed this vehicle&apos;s code yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {guestAccesses.map((a) => {
              const exp = formatExpiry(a.expiresAt, now);
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-desat-1 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-accent-dark">
                      Guest {shortId(a.guestUserId)}
                    </p>
                    <p className="truncate text-xs text-desat-7">
                      {allowedSummary(a.permissions)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      tone={exp.tone === "ok" ? "temporary" : exp.tone}
                      dot={false}
                    >
                      {exp.label || "Active"}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => void revoke(a.id)}
                      disabled={revokingId === a.id}
                      className="text-xs font-medium text-[#dc2626] underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {revokingId === a.id ? "Revoking…" : "Revoke"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
