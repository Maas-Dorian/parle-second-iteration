"use client";

import { useEffect, useState } from "react";

/** Ticking clock so countdown labels refresh without manual re-renders. */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type ExpiryTone = "ok" | "soon" | "expired";

/** Human "expires in …" label + tone for a temporary-access expiry. */
export function formatExpiry(
  expiresAt: string,
  now: number = Date.now(),
): { label: string; tone: ExpiryTone } {
  const exp = new Date(expiresAt).getTime();
  if (Number.isNaN(exp)) return { label: "", tone: "ok" };
  const diff = exp - now;
  if (diff <= 0) return { label: "Expired", tone: "expired" };

  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return { label: "Expires in <1m", tone: "soon" };
  if (mins < 60) return { label: `Expires in ${mins}m`, tone: "soon" };

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return { label: `Expires in ${hours}h`, tone: hours <= 1 ? "soon" : "ok" };
  }
  const days = Math.floor(hours / 24);
  return { label: `Expires in ${days}d`, tone: "ok" };
}
