/** Small colored pill for vehicle state / lock status. */
export function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "online" | "asleep" | "offline" | "locked" | "unlocked" | "neutral";
}) {
  const toneClass: Record<typeof tone, string> = {
    online: "bg-emerald-100 text-emerald-800",
    asleep: "bg-amber-100 text-amber-800",
    offline: "bg-desat-2 text-desat-7",
    locked: "bg-emerald-100 text-emerald-800",
    unlocked: "bg-amber-100 text-amber-800",
    neutral: "bg-desat-2 text-desat-7",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}
    >
      {label}
    </span>
  );
}
