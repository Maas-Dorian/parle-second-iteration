/**
 * Publishes the owner's selected fleet vehicles to Supabase so the renter
 * mobile app can list them.
 *
 * The renter app reads `public.fleet_available_vehicles` where
 * `is_available = true`. This module upserts a row per owned vehicle:
 *   - selected vehicles   → is_available = true
 *   - unselected vehicles → is_available = false
 *
 * Writes go through the existing browser Supabase client (anon key + the
 * signed-in user's session). Row Level Security only allows a user to write
 * rows where `owner_user_id = auth.uid()`, so no service-role key is ever
 * needed or referenced in the frontend. localStorage stays the source of
 * truth for the UI; this is the durable, cross-device/renter-visible copy.
 */

import { supabase } from "@/lib/supabase";
import type { Vehicle } from "@/lib/api";

/** Row shape for `public.fleet_available_vehicles` upserts. */
export type FleetAvailableVehicleInsert = {
  owner_user_id: string;
  source_vehicle_id: string;
  vin: string | null;
  display_name: string | null;
  model: string | null;
  color: string | null;
  battery_level: number | null;
  range_miles: number | null;
  is_locked: boolean | null;
  hourly_rate: number | null;
  distance_miles: number | null;
  is_available: boolean;
};

/**
 * A vehicle we can map to a fleet-availability row. The web app's `Vehicle`
 * type is intentionally narrow; the extra fields are optional so this keeps
 * working if richer vehicle/status data is threaded through later.
 */
export type SyncableVehicle = Vehicle & {
  displayName?: string | null;
  model?: string | null;
  color?: string | null;
  batteryLevel?: number | null;
  rangeMiles?: number | null;
  isLocked?: boolean | null;
  hourlyRate?: number | null;
  status?: {
    batteryLevel?: number | null;
    rangeMiles?: number | null;
    isLocked?: boolean | null;
  } | null;
};

/** Default hourly rate until owner pricing exists. */
const DEFAULT_HOURLY_RATE = 24;

function toRow(
  vehicle: SyncableVehicle,
  ownerUserId: string,
  isAvailable: boolean,
): FleetAvailableVehicleInsert {
  return {
    owner_user_id: ownerUserId,
    source_vehicle_id: vehicle.id,
    vin: vehicle.vin || null,
    display_name:
      vehicle.displayName ?? vehicle.name ?? vehicle.model ?? "Tesla Vehicle",
    model: vehicle.model ?? null,
    color: vehicle.color ?? null,
    battery_level: vehicle.batteryLevel ?? vehicle.status?.batteryLevel ?? null,
    range_miles: vehicle.rangeMiles ?? vehicle.status?.rangeMiles ?? null,
    is_locked: vehicle.isLocked ?? vehicle.status?.isLocked ?? null,
    hourly_rate: vehicle.hourlyRate ?? DEFAULT_HOURLY_RATE,
    distance_miles: null,
    is_available: isAvailable,
  };
}

const TABLE = "fleet_available_vehicles";

type SupabaseErrorLike = { message?: string; code?: string };

/**
 * True when the DB rejects `ON CONFLICT (source_vehicle_id)` because the unique
 * index is partial (`WHERE source_vehicle_id IS NOT NULL`) — Postgres error
 * 42P10 "no unique or exclusion constraint matching the ON CONFLICT". We then
 * fall back to a manual insert/update reconcile so the sync still works.
 */
function isNoConflictConstraintError(error: SupabaseErrorLike | null): boolean {
  if (!error) return false;
  if (error.code === "42P10") return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("no unique or exclusion constraint");
}

/**
 * Fallback path when `onConflict` can't be used: look up existing rows for this
 * owner by `source_vehicle_id`, insert the new ones, and update the rest by
 * primary key (`id`), which always has a usable unique constraint.
 */
async function reconcileWithoutOnConflict(
  rows: FleetAvailableVehicleInsert[],
  ownerUserId: string,
): Promise<void> {
  if (!supabase) throw new Error("Supabase isn’t configured.");
  const sourceIds = rows.map((r) => r.source_vehicle_id);

  const { data: existing, error: selectError } = await supabase
    .from(TABLE)
    .select("id, source_vehicle_id")
    .eq("owner_user_id", ownerUserId)
    .in("source_vehicle_id", sourceIds);
  if (selectError) throw selectError;

  const idBySource = new Map<string, string>(
    (existing ?? []).map((r) => [
      String((r as { source_vehicle_id: string }).source_vehicle_id),
      String((r as { id: string }).id),
    ]),
  );

  const toInsert = rows.filter((r) => !idBySource.has(r.source_vehicle_id));
  const toUpdate = rows
    .filter((r) => idBySource.has(r.source_vehicle_id))
    .map((r) => ({ ...r, id: idBySource.get(r.source_vehicle_id) as string }));

  if (toInsert.length) {
    const { error } = await supabase.from(TABLE).insert(toInsert);
    if (error) throw error;
  }
  if (toUpdate.length) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(toUpdate, { onConflict: "id" });
    if (error) throw error;
  }

  console.log("[fleetAvailability] reconciled via insert/update fallback", {
    insertedCount: toInsert.length,
    updatedCount: toUpdate.length,
  });
}

/**
 * Upsert every owned vehicle into `fleet_available_vehicles`, flagging the
 * selected ones as available and the rest as unavailable. Conflicts resolve on
 * `source_vehicle_id` (the web app's vehicle id), so re-saving updates in place.
 * If the DB's unique index is partial (can't be an ON CONFLICT target), it
 * automatically falls back to a manual insert/update reconcile.
 *
 * Throws on a Supabase error so callers can surface a message in the UI.
 */
export async function syncSelectedFleetVehiclesToSupabase(params: {
  ownerUserId: string;
  allVehicles: SyncableVehicle[];
  selectedVehicleIds: string[];
}): Promise<void> {
  const { ownerUserId, allVehicles, selectedVehicleIds } = params;

  // Safe diagnostics only — never tokens, keys, or vehicle PII.
  console.log("[fleetAvailability] sync start", {
    ownerUserIdPresent: Boolean(ownerUserId),
    loadedVehicleCount: allVehicles.length,
    selectedVehicleCount: selectedVehicleIds.length,
  });

  if (!supabase) {
    throw new Error(
      "Supabase isn’t configured, so the fleet could not be published.",
    );
  }
  if (!ownerUserId) {
    throw new Error("Missing owner user id; cannot publish fleet.");
  }
  if (allVehicles.length === 0) {
    console.log("[fleetAvailability] no vehicles loaded — nothing to sync");
    return;
  }

  const selected = new Set(selectedVehicleIds.map(String));
  const rows = allVehicles.map((v) =>
    toRow(v, ownerUserId, selected.has(String(v.id))),
  );
  const availableCount = rows.filter((r) => r.is_available).length;

  console.log("[fleetAvailability] upserting rows", {
    upsertRowCount: rows.length,
    availableCount,
  });

  const { error } = await supabase
    .from(TABLE)
    .upsert(rows, { onConflict: "source_vehicle_id" });

  if (error && isNoConflictConstraintError(error)) {
    console.warn(
      "[fleetAvailability] onConflict unavailable (partial index) — using fallback",
      { code: error.code ?? null },
    );
    await reconcileWithoutOnConflict(rows, ownerUserId);
    console.log("[fleetAvailability] sync success (fallback)", {
      upsertRowCount: rows.length,
      availableCount,
    });
    return;
  }

  if (error) {
    console.error("[fleetAvailability] upsert error", {
      code: error.code ?? null,
      message: error.message ?? "unknown",
      upsertRowCount: rows.length,
      availableCount,
    });
    throw error;
  }

  console.log("[fleetAvailability] sync success", {
    upsertRowCount: rows.length,
    availableCount,
  });
}
