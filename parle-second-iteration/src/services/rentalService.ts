import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { ApiError } from "../utils/errors.js";
import type { SharePermissions } from "./shareService.js";
import { runVehicleCommandForUser } from "./vehicleCommandRunner.js";

/**
 * Public-vehicle "Start Ride" / claim-access flow.
 *
 * A logged-in renter (identity VERIFIED from their Supabase token, not trusted
 * from a header) can claim a vehicle an owner published to
 * `public.fleet_available_vehicles`. Claiming creates a time-boxed
 * TemporaryVehicleAccess grant — the SAME architecture used by share codes — so
 * the existing authorization system automatically recognizes the renter on
 * command routes. Public visibility alone never grants commands; only an active,
 * unexpired grant (or ownership) does.
 *
 * Concurrency: claiming flips `is_available` true→false inside a transaction
 * using a conditional UPDATE (compare-and-set). Postgres row-locks that UPDATE,
 * so two simultaneous renters can never both succeed — the loser matches 0 rows
 * and gets a 409.
 *
 * Never logs tokens, API keys, or Tesla credentials.
 */

/** Permissions a renter gets: Lock, Unlock, Ready-to-drive, status refresh. */
export const RENTAL_PERMISSIONS: SharePermissions = {
  status: true,
  wake: true,
  lock: true,
  unlock: true,
  ready: true,
  enableDrive: false,
};

export const DEFAULT_RENTAL_MINUTES = 120;
const MIN_RENTAL_MINUTES = 1;
const MAX_RENTAL_MINUTES = 10080; // 1 week

type FleetRow = {
  id: string;
  owner_user_id: string;
  source_vehicle_id: string | null;
  vin: string | null;
  display_name: string | null;
  model: string | null;
  color: string | null;
  battery_level: number | null;
  range_miles: number | null;
  is_locked: boolean | null;
  is_available: boolean;
};

type AccessRow = {
  id: string;
  ownerUserId: string;
  guestUserId: string;
  vin: string | null;
  startsAt: Date;
  expiresAt: Date;
};

export type RentalGrant = {
  accessId: string;
  /** The id the command routes expect (source_vehicle_id). */
  vehicleId: string;
  sourceVehicleId: string | null;
  vin: string | null;
  displayName: string | null;
  model: string | null;
  color: string | null;
  batteryLevel: number | null;
  rangeMiles: number | null;
  isLocked: boolean | null;
  ownerUserId: string;
  guestUserId: string;
  permissions: SharePermissions;
  startsAt: string;
  expiresAt: string;
  durationMinutes: number;
  /** True when the caller already held this active grant (idempotent re-claim). */
  alreadyActive: boolean;
};

function clampMinutes(input?: number | null): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_RENTAL_MINUTES;
  const n = Math.round(input);
  if (n < MIN_RENTAL_MINUTES) return MIN_RENTAL_MINUTES;
  if (n > MAX_RENTAL_MINUTES) return MAX_RENTAL_MINUTES;
  return n;
}

function toGrant(
  access: AccessRow,
  row: FleetRow,
  sourceId: string,
  alreadyActive: boolean,
): RentalGrant {
  const durationMinutes = Math.max(
    0,
    Math.round((access.expiresAt.getTime() - access.startsAt.getTime()) / 60_000),
  );
  return {
    accessId: access.id,
    vehicleId: sourceId,
    sourceVehicleId: row.source_vehicle_id,
    vin: access.vin ?? row.vin,
    displayName: row.display_name,
    model: row.model,
    color: row.color,
    batteryLevel: row.battery_level,
    rangeMiles: row.range_miles,
    isLocked: row.is_locked,
    ownerUserId: access.ownerUserId,
    guestUserId: access.guestUserId,
    permissions: RENTAL_PERMISSIONS,
    startsAt: access.startsAt.toISOString(),
    expiresAt: access.expiresAt.toISOString(),
    durationMinutes,
    alreadyActive,
  };
}

/** Map a route param (source_vehicle_id or DB id) to the fleet source id. */
async function resolveFleetSourceId(vehicleParamId: string): Promise<string> {
  try {
    const rows = await prisma.$queryRaw<Array<{ source_vehicle_id: string | null; id: string }>>`
      SELECT source_vehicle_id, id::text AS id
      FROM public.fleet_available_vehicles
      WHERE source_vehicle_id = ${vehicleParamId} OR id::text = ${vehicleParamId}
      LIMIT 1
    `;
    if (rows.length === 0) return vehicleParamId;
    return rows[0].source_vehicle_id ?? rows[0].id;
  } catch {
    return vehicleParamId;
  }
}

/**
 * Claim a public fleet vehicle for the given renter. Concurrency-safe.
 * Throws ApiError(404/403/409) for the various rejection cases.
 */
export async function claimPublicVehicle(params: {
  renterUserId: string;
  vehicleParamId: string;
  durationMinutes?: number | null;
  log: FastifyBaseLogger;
}): Promise<RentalGrant> {
  const { renterUserId, vehicleParamId, log } = params;
  const minutes = clampMinutes(params.durationMinutes);
  const now = new Date();

  log.info(
    { sourceVehicleId: vehicleParamId, guestUserIdPresent: !!renterUserId, durationMinutes: minutes },
    "[rental] public claim requested",
  );

  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<FleetRow[]>`
      SELECT id::text AS id, owner_user_id, source_vehicle_id, vin, display_name,
             model, color, battery_level, range_miles, is_locked, is_available
      FROM public.fleet_available_vehicles
      WHERE source_vehicle_id = ${vehicleParamId} OR id::text = ${vehicleParamId}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new ApiError(404, "not_found", "This vehicle isn’t part of the Parlé fleet.");
    }
    const row = rows[0];
    const sourceId = row.source_vehicle_id ?? row.id;

    log.info(
      { sourceVehicleId: sourceId, isAvailable: row.is_available, isOwner: row.owner_user_id === renterUserId },
      "[rental] availability decision",
    );

    // Owners can't rent their own listing through the renter flow.
    if (row.owner_user_id === renterUserId) {
      throw new ApiError(
        403,
        "access_denied",
        "You own this vehicle. Manage it from the fleet app instead of renting it.",
      );
    }

    // Is another (or the same) renter already holding an active grant?
    const active = await tx.temporaryVehicleAccess.findFirst({
      where: { vehicleId: sourceId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      if (active.guestUserId === renterUserId) {
        // Idempotent: the same renter re-claiming their own active grant.
        return { access: active as AccessRow, row, sourceId, alreadyActive: true };
      }
      log.warn(
        { sourceVehicleId: sourceId, conflictingAccessId: active.id },
        "[rental] conflicting active access — vehicle already claimed by another renter",
      );
      throw new ApiError(409, "command_rejected", "Another renter is currently using this vehicle.");
    }

    if (!row.is_available) {
      throw new ApiError(409, "command_rejected", "This vehicle isn’t available right now.");
    }

    // Concurrency-safe compare-and-set: only one claimer can flip true→false.
    const affected = await tx.$executeRaw`
      UPDATE public.fleet_available_vehicles
      SET is_available = false, updated_at = now()
      WHERE (source_vehicle_id = ${vehicleParamId} OR id::text = ${vehicleParamId})
        AND is_available = true
    `;
    if (affected === 0) {
      log.warn({ sourceVehicleId: sourceId }, "[rental] claim lost race — vehicle became unavailable");
      throw new ApiError(409, "command_rejected", "This vehicle was just claimed by someone else.");
    }

    const created = await tx.temporaryVehicleAccess.create({
      data: {
        ownerUserId: row.owner_user_id,
        guestUserId: renterUserId,
        vehicleId: sourceId,
        vin: row.vin,
        friendlyName: row.display_name,
        shareCodeId: null,
        permissions: RENTAL_PERMISSIONS,
        startsAt: now,
        expiresAt: new Date(now.getTime() + minutes * 60_000),
      },
    });
    return { access: created as AccessRow, row, sourceId, alreadyActive: false };
  });

  const grant = toGrant(result.access, result.row, result.sourceId, result.alreadyActive);
  log.info(
    { accessId: grant.accessId, expiresAt: grant.expiresAt, alreadyActive: grant.alreadyActive },
    "[rental] access grant created",
  );
  return grant;
}

export type EndRideResult = {
  ended: true;
  alreadyEnded: boolean;
  locked: boolean | null;
  released: boolean;
  expiresAt: string | null;
};

/**
 * End a renter's ride: lock the vehicle first (via the owner's token, using the
 * same command path as the routes), then revoke the grant and — for public
 * rentals — return the vehicle to the fleet. Idempotent: a second call with no
 * active grant is a no-op success. Throws ApiError if locking fails so the
 * renter can retry (access is preserved).
 */
export async function endRide(params: {
  renterUserId: string;
  vehicleParamId: string;
  log: FastifyBaseLogger;
}): Promise<EndRideResult> {
  const { renterUserId, vehicleParamId, log } = params;
  const now = new Date();

  log.info(
    { sourceVehicleId: vehicleParamId, guestUserIdPresent: !!renterUserId },
    "[rental] end ride requested",
  );

  const sourceId = await resolveFleetSourceId(vehicleParamId);

  const access = await prisma.temporaryVehicleAccess.findFirst({
    where: {
      guestUserId: renterUserId,
      revokedAt: null,
      expiresAt: { gt: now },
      vehicleId: sourceId,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!access) {
    // Nothing active to end — idempotent no-op. Never touch availability here:
    // the vehicle may already have been released or claimed by someone else.
    log.info({ sourceVehicleId: sourceId }, "[rental] end ride: no active access (idempotent no-op)");
    return { ended: true, alreadyEnded: true, locked: null, released: false, expiresAt: null };
  }

  // 1) Always attempt to lock first — never end a ride silently. Reuses the
  //    exact route command path (guest → owner token, wake, VCP proxy, retry).
  try {
    await runVehicleCommandForUser({
      triggeredBy: renterUserId,
      vehicleParamId: sourceId,
      command: "lock",
      requestId: randomUUID(),
      log,
    });
  } catch (err) {
    const apiErr =
      err instanceof ApiError ? err : new ApiError(502, "lock_failed", "Couldn’t lock the vehicle.");
    log.warn(
      { sourceVehicleId: sourceId, errorReason: apiErr.reason, errorMessage: apiErr.message },
      "[rental] end ride: lock failed — access kept active for retry",
    );
    throw apiErr;
  }

  // 2) Revoke the grant and release the public vehicle back to the fleet.
  let released = false;
  await prisma.$transaction(async (tx) => {
    await tx.temporaryVehicleAccess.update({
      where: { id: access.id },
      data: { revokedAt: new Date() },
    });
    log.info({ accessId: access.id }, "[rental] access revoked");

    // Only public rentals (no share code) return the vehicle to availability.
    if (access.shareCodeId == null) {
      const affected = await tx.$executeRaw`
        UPDATE public.fleet_available_vehicles
        SET is_available = true, updated_at = now()
        WHERE source_vehicle_id = ${sourceId} OR id::text = ${sourceId}
      `;
      released = affected > 0;
      log.info(
        { sourceVehicleId: sourceId, released },
        "[rental] vehicle returned to public availability",
      );
    }
  });

  return {
    ended: true,
    alreadyEnded: false,
    locked: true,
    released,
    expiresAt: access.expiresAt.toISOString(),
  };
}
