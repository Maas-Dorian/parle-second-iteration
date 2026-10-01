/**
 * Local-only access scheduling.
 *
 * The backend has no scheduling endpoint yet, so scheduled access windows are
 * stored in localStorage per Supabase user + vehicle. The UI labels these as
 * "local draft" schedules — they are NOT enforced server-side. When a backend
 * endpoint exists, move this into src/lib/api.ts (saveAccessSchedule, etc.).
 */

export type AccessAction = "unlock" | "ready" | "lock";

export type AccessSchedule = {
  id: string;
  vehicleId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** 24h start time (HH:MM). */
  startTime: string;
  /** Duration in hours. */
  durationHours: number;
  action: AccessAction;
  notes: string;
  createdAt: string;
};

export const ACCESS_ACTION_LABELS: Record<AccessAction, string> = {
  unlock: "Unlock / allow access",
  ready: "Ready vehicle (unlock + enable drive)",
  lock: "Lock",
};

function storageKey(userId: string, vehicleId: string): string {
  return `parle.schedules.${userId}.${vehicleId}`;
}

export function loadSchedules(
  userId: string,
  vehicleId: string,
): AccessSchedule[] {
  try {
    const raw = localStorage.getItem(storageKey(userId, vehicleId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AccessSchedule[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(
  userId: string,
  vehicleId: string,
  schedules: AccessSchedule[],
): void {
  try {
    localStorage.setItem(
      storageKey(userId, vehicleId),
      JSON.stringify(schedules),
    );
  } catch {
    // Storage unavailable (private mode etc.) — drafts just won't persist.
  }
}

/** Add a schedule and return the new, sorted list (soonest first). */
export function addSchedule(
  userId: string,
  vehicleId: string,
  input: Omit<AccessSchedule, "id" | "vehicleId" | "createdAt">,
): AccessSchedule[] {
  const schedule: AccessSchedule = {
    ...input,
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    vehicleId,
    createdAt: new Date().toISOString(),
  };
  const next = sortSchedules([...loadSchedules(userId, vehicleId), schedule]);
  persist(userId, vehicleId, next);
  return next;
}

/** Remove a schedule by id and return the updated list. */
export function removeSchedule(
  userId: string,
  vehicleId: string,
  scheduleId: string,
): AccessSchedule[] {
  const next = loadSchedules(userId, vehicleId).filter(
    (s) => s.id !== scheduleId,
  );
  persist(userId, vehicleId, next);
  return next;
}

/** Sort soonest-first by start datetime. */
export function sortSchedules(schedules: AccessSchedule[]): AccessSchedule[] {
  return [...schedules].sort(
    (a, b) =>
      new Date(`${a.date}T${a.startTime}`).getTime() -
      new Date(`${b.date}T${b.startTime}`).getTime(),
  );
}
