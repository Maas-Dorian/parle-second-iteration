"use client";

import type { ReactNode } from "react";

export type BadgeTone =
  | "connected"
  | "temporary"
  | "soon"
  | "expired"
  | "neutral";

const TONE_CLASS: Record<BadgeTone, string> = {
  connected: "bg-success/15 text-success",
  temporary: "bg-accent-primary/12 text-accent-primary",
  soon: "bg-[#b45309]/12 text-[#b45309]",
  expired: "bg-[#dc2626]/12 text-[#dc2626]",
  neutral: "bg-desat-1 text-desat-7",
};

const DOT_CLASS: Record<BadgeTone, string> = {
  connected: "bg-success",
  temporary: "bg-accent-primary",
  soon: "bg-[#b45309]",
  expired: "bg-[#dc2626]",
  neutral: "bg-desat-7",
};

/** Small status pill used across the dashboard (connection + expiry states). */
export function Badge({
  tone,
  children,
  dot = true,
}: {
  tone: BadgeTone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {dot && <span className={`size-1.5 rounded-full ${DOT_CLASS[tone]}`} />}
      {children}
    </span>
  );
}
