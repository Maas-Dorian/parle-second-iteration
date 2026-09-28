"use client";

/**
 * Management card for a single vehicle (owned or temporarily shared):
 *  - vehicle name / VIN / live state badges
 *  - basic live status (battery, range, charging, lock)
 *  - command buttons (wake, lock, unlock, enable-drive, ready) — permission-aware
 *  - owner: share-access controls (code + active guests) and local scheduling
 *  - guest: temporary-access badge + only the commands they're allowed to run
 *
 * No "recent activity" log section (removed by product request).
 */

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  enableDriveVehicle,
  getReadableErrorMessage,
  getVehicleStatus,
  lockVehicle,
  readyVehicle,
  unlockVehicle,
  wakeVehicle,
  type TemporaryAccess,
  type Vehicle,
  type VehiclePermissions,
  type VehicleStatus,
} from "@/lib/api";
import {
  ACCESS_ACTION_LABELS,
  addSchedule,
  loadSchedules,
  removeSchedule,
  sortSchedules,
  type AccessAction,
  type AccessSchedule,
} from "@/lib/schedules";
import { StatusBadge } from "./StatusBadge";
import { Badge } from "./Badge";
import { ShareCodePanel } from "./ShareCodePanel";
import { formatExpiry, useNow } from "@/lib/format";

/** Background status refresh cadence for selected vehicles. */
const AUTO_REFRESH_MS = 30_000;

type CommandKey = "wake" | "lock" | "unlock" | "enable-drive" | "ready";

type CommandFeedback = { kind: "success" | "error"; text: string } | null;

const PERMISSION_BY_COMMAND: Record<CommandKey, keyof VehiclePermissions> = {
  wake: "wake",
  lock: "lock",
  unlock: "unlock",
  "enable-drive": "enableDrive",
  ready: "ready",
};

function stateTone(state: string): "online" | "asleep" | "offline" | "neutral" {
  const s = state.toLowerCase();
  if (s === "online") return "online";
  if (s === "asleep") return "asleep";
  if (s === "offline") return "offline";
  return "neutral";
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function VehicleControlCard({
  userId,
  vehicle,
  shared = false,
  permissions,
  expiresAt,
  guestAccesses = [],
  onAccessChanged,
}: {
  userId: string;
  vehicle: Vehicle;
  /** True when this card represents a vehicle shared *with* the current user. */
  shared?: boolean;
  /** Allowed commands for a guest (ignored for owned vehicles). */
  permissions?: VehiclePermissions;
  /** ISO expiry of the guest's temporary access. */
  expiresAt?: string;
  /** Owner only: active guest grants on this vehicle. */
  guestAccesses?: TemporaryAccess[];
  /** Owner only: refetch access after a code/access change. */
  onAccessChanged?: () => void;
}) {
  const vehicleId = vehicle.id;
  const now = useNow();

  const statusAllowed = !shared || permissions?.status !== false;

  const canRun = useCallback(
    (key: CommandKey): boolean => {
      if (!shared) return true;
      return permissions?.[PERMISSION_BY_COMMAND[key]] === true;
    },
    [shared, permissions],
  );

  // ── Status ──
  const [status, setStatus] = useState<VehicleStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(statusAllowed);
  const [statusVersion, setStatusVersion] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // ── Commands ──
  const [activeCommand, setActiveCommand] = useState<CommandKey | null>(null);
  const [feedback, setFeedback] = useState<CommandFeedback>(null);

  const mountedRef = useRef(true);
  const activeCommandRef = useRef<CommandKey | null>(activeCommand);
  useEffect(() => {
    activeCommandRef.current = activeCommand;
  }, [activeCommand]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(
    async (opts: { background: boolean }) => {
      try {
        const s = await getVehicleStatus(userId, vehicleId);
        if (!mountedRef.current) return;
        setStatus(s);
        setStatusError(null);
        setLastUpdated(new Date().toISOString());
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = getReadableErrorMessage(err);
        setStatusError(msg);
        if (!opts.background) setStatus(null);
      } finally {
        if (mountedRef.current) setStatusLoading(false);
      }
    },
    [userId, vehicleId],
  );

  // Foreground load (mount + manual refresh) — deferred a tick so no state
  // update happens synchronously in the effect.
  useEffect(() => {
    if (!statusAllowed) return;
    const timer = window.setTimeout(
      () => void loadStatus({ background: false }),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [loadStatus, statusVersion, statusAllowed]);

  // Auto-refresh while visible and idle.
  useEffect(() => {
    if (!statusAllowed) return;
    const canRefresh = () =>
      document.visibilityState === "visible" &&
      activeCommandRef.current === null;
    const interval = window.setInterval(() => {
      if (canRefresh()) void loadStatus({ background: true });
    }, AUTO_REFRESH_MS);
    const onVisibility = () => {
      if (canRefresh()) void loadStatus({ background: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadStatus, statusAllowed]);

  function refreshStatus() {
    setStatusError(null);
    setStatusLoading(true);
    setStatusVersion((v) => v + 1);
  }

  async function runCommand(key: CommandKey) {
    if (activeCommand || !canRun(key)) return;

    if (key === "unlock" && !window.confirm(`Unlock ${vehicle.name}?`)) return;
    if (
      (key === "ready" || key === "enable-drive") &&
      !window.confirm(
        `${key === "ready" ? "Ready" : "Enable drive on"} ${vehicle.name}? This unlocks the car and makes it drivable.`,
      )
    ) {
      return;
    }

    setActiveCommand(key);
    setFeedback(null);
    try {
      switch (key) {
        case "wake":
          await wakeVehicle(userId, vehicleId);
          break;
        case "lock":
          await lockVehicle(userId, vehicleId);
          break;
        case "unlock":
          await unlockVehicle(userId, vehicleId);
          break;
        case "enable-drive":
          await enableDriveVehicle(userId, vehicleId);
          break;
        case "ready":
          await readyVehicle(userId, vehicleId);
          break;
      }
      setFeedback({ kind: "success", text: `${commandLabel(key)} sent.` });
      if (statusAllowed) setStatusVersion((v) => v + 1);
    } catch (err) {
      setFeedback({
        kind: "error",
        text: getReadableErrorMessage(err),
      });
    } finally {
      setActiveCommand(null);
    }
  }

  const batteryText =
    status?.batteryLevel != null ? `${status.batteryLevel}%` : "—";
  const rangeText =
    status?.rangeKm != null ? `${Math.round(status.rangeKm)} km` : "—";
  const expiry = shared && expiresAt ? formatExpiry(expiresAt, now) : null;

  return (
    <article className="flex flex-col gap-5 rounded-[22px] border border-desat-2 bg-white p-6 shadow-[0_14px_38px_rgba(29,6,51,0.05)]">
      {/* ── Header ── */}
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="relative h-12 w-20 shrink-0">
            <Image
              src={vehicle.image}
              alt={vehicle.name}
              fill
              sizes="80px"
              className="object-contain"
            />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-accent-dark">
              {vehicle.name}
            </h3>
            {vehicle.vin && (
              <p className="truncate font-mono text-xs text-desat-7">
                {vehicle.vin}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {shared && (
            <Badge
              tone={expiry ? (expiry.tone === "ok" ? "temporary" : expiry.tone) : "temporary"}
            >
              {expiry?.tone === "expired"
                ? "Expired"
                : expiry?.label ?? "Shared"}
            </Badge>
          )}
          {status && (
            <StatusBadge
              label={status.state || "unknown"}
              tone={stateTone(status.state)}
            />
          )}
          {status?.isLocked != null && (
            <StatusBadge
              label={status.isLocked ? "Locked" : "Unlocked"}
              tone={status.isLocked ? "locked" : "unlocked"}
            />
          )}
        </div>
      </header>

      {/* ── Live status ── */}
      <section>
        {!statusAllowed ? (
          <p className="text-sm text-desat-7">
            Live status isn&apos;t shared for this temporary access.
          </p>
        ) : statusLoading && status === null ? (
          <p className="text-sm text-desat-7">Loading status…</p>
        ) : status === null && statusError ? (
          <div className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <span>{statusError}</span>
            <button
              type="button"
              onClick={refreshStatus}
              className="ml-3 font-medium underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {statusError && (
              <div className="mb-3 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span>Couldn&apos;t refresh: {statusError}</span>
                <button
                  type="button"
                  onClick={refreshStatus}
                  className="ml-3 font-medium underline-offset-2 hover:underline"
                >
                  Retry
                </button>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Stat label="Battery" value={batteryText} />
              <Stat label="Range" value={rangeText} />
              <Stat label="Charging" value={status?.chargingState ?? "—"} />
              <Stat
                label="Lock"
                value={
                  status?.isLocked == null
                    ? "—"
                    : status.isLocked
                    ? "Locked"
                    : "Unlocked"
                }
              />
            </dl>
          </>
        )}
        {statusAllowed && (
          <p className="mt-3 text-xs text-desat-7">
            Last refreshed: {formatTime(lastUpdated)}
            <span className="ml-1">· auto-refreshes every 30s</span>
          </p>
        )}
      </section>

      {/* ── Command feedback ── */}
      {feedback && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            feedback.kind === "success"
              ? "bg-emerald-50 text-emerald-800"
              : "bg-red-50 text-red-700"
          }`}
        >
          {feedback.text}
        </p>
      )}

      {/* ── Commands ── */}
      <section className="flex flex-wrap gap-2">
        <CommandButton
          label="Wake"
          busy={activeCommand === "wake"}
          disabled={activeCommand !== null || !canRun("wake")}
          hidden={!canRun("wake")}
          onClick={() => runCommand("wake")}
        />
        <CommandButton
          label="Lock"
          busy={activeCommand === "lock"}
          disabled={activeCommand !== null || !canRun("lock")}
          hidden={!canRun("lock")}
          onClick={() => runCommand("lock")}
        />
        <CommandButton
          label="Unlock"
          busy={activeCommand === "unlock"}
          disabled={activeCommand !== null || !canRun("unlock")}
          hidden={!canRun("unlock")}
          onClick={() => runCommand("unlock")}
        />
        <CommandButton
          label="Enable drive"
          busy={activeCommand === "enable-drive"}
          disabled={activeCommand !== null || !canRun("enable-drive")}
          hidden={!canRun("enable-drive")}
          onClick={() => runCommand("enable-drive")}
        />
        <CommandButton
          label="Ready"
          busy={activeCommand === "ready"}
          disabled={activeCommand !== null || !canRun("ready")}
          hidden={!canRun("ready")}
          onClick={() => runCommand("ready")}
          primary
        />
        {statusAllowed && (
          <CommandButton
            label="Refresh status"
            busy={statusLoading}
            disabled={activeCommand !== null}
            onClick={refreshStatus}
            variant="ghost"
          />
        )}
      </section>

      {/* ── Owner: share access ── */}
      {!shared && onAccessChanged && (
        <ShareCodePanel
          userId={userId}
          vehicleId={vehicleId}
          guestAccesses={guestAccesses}
          onChanged={onAccessChanged}
        />
      )}

      {/* ── Owner: scheduled access (local draft) ── */}
      {!shared && (
        <SchedulePanel userId={userId} vehicleId={vehicleId} vehicleName={vehicle.name} />
      )}

      {/* ── Guest: temporary access note ── */}
      {shared && (
        <section className="border-t border-desat-2 pt-4">
          <p className="text-sm text-desat-7">
            Temporary access{expiry?.label ? ` — ${expiry.label}` : ""}. Only the
            commands above are permitted by the owner.
          </p>
        </section>
      )}
    </article>
  );
}

function commandLabel(key: CommandKey): string {
  switch (key) {
    case "wake":
      return "Wake";
    case "lock":
      return "Lock";
    case "unlock":
      return "Unlock";
    case "enable-drive":
      return "Enable drive";
    case "ready":
      return "Ready";
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-desat-7">{label}</dt>
      <dd className="text-sm font-medium capitalize text-accent-dark">{value}</dd>
    </div>
  );
}

function CommandButton({
  label,
  busy,
  disabled,
  hidden,
  onClick,
  primary,
  variant,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  hidden?: boolean;
  onClick: () => void;
  primary?: boolean;
  variant?: "ghost";
}) {
  if (hidden) return null;
  const base =
    "rounded-xl px-3.5 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50";
  const style = primary
    ? "bg-accent-primary text-white hover:opacity-90"
    : variant === "ghost"
    ? "text-accent-dark hover:bg-desat-1"
    : "border border-desat-3 text-accent-dark hover:bg-desat-1";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${style}`}
    >
      {busy ? "…" : label}
    </button>
  );
}

function SchedulePanel({
  userId,
  vehicleId,
  vehicleName,
}: {
  userId: string;
  vehicleId: string;
  vehicleName: string;
}) {
  const [schedules, setSchedules] = useState<AccessSchedule[]>([]);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [durationHours, setDurationHours] = useState("1");
  const [action, setAction] = useState<AccessAction>("unlock");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSchedules(sortSchedules(loadSchedules(userId, vehicleId))),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [userId, vehicleId]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!date) return;
    const next = addSchedule(userId, vehicleId, {
      date,
      startTime,
      durationHours: Number(durationHours) || 1,
      action,
      notes: notes.trim(),
    });
    setSchedules(next);
    setNotes("");
  }

  function handleRemove(id: string) {
    setSchedules(removeSchedule(userId, vehicleId, id));
  }

  const inputClass =
    "rounded-lg border border-desat-3 px-3 py-2 text-sm text-accent-dark outline-none focus:border-accent-primary";

  return (
    <section className="border-t border-desat-2 pt-4">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-sm font-bold text-accent-dark">Scheduled access</h4>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
          Local draft
        </span>
      </div>
      <p className="mb-3 text-xs text-desat-7">
        Plan access windows for {vehicleName}. Saved on this device only — not yet
        enforced by the backend.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-desat-7">Date</span>
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-desat-7">Start</span>
            <input
              type="time"
              required
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-desat-7">Hours</span>
            <input
              type="number"
              min={1}
              max={24}
              value={durationHours}
              onChange={(e) => setDurationHours(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-desat-7">Action</span>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as AccessAction)}
              className={inputClass}
            >
              {(Object.keys(ACCESS_ACTION_LABELS) as AccessAction[]).map((a) => (
                <option key={a} value={a}>
                  {ACCESS_ACTION_LABELS[a]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-desat-7">Notes</span>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Cleaning crew access"
            className={inputClass}
          />
        </label>
        <button
          type="submit"
          className="self-start rounded-lg bg-accent-dark px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Save schedule
        </button>
      </form>

      {schedules.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {schedules.map((s) => (
            <li
              key={s.id}
              className="flex items-start justify-between gap-3 rounded-lg bg-desat-1 px-3 py-2"
            >
              <div className="text-sm">
                <p className="font-medium text-accent-dark">
                  {s.date} at {s.startTime} · {s.durationHours}h
                </p>
                <p className="text-xs text-desat-7">
                  {ACCESS_ACTION_LABELS[s.action]}
                  {s.notes ? ` — ${s.notes}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(s.id)}
                className="shrink-0 text-xs font-medium text-red-600 underline-offset-2 hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
