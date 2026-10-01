import { prisma } from "../db/prisma.js";
import { ApiError } from "../utils/errors.js";
import {
  getUserAccessToken,
  type AccessTokenResult,
} from "./teslaAccountService.js";
import { resolveVehicle } from "./vehicleService.js";

/**
 * Temporary vehicle sharing ("ride-share codes").
 *
 * An owner with a linked Tesla account can mint a short, rotating code for one
 * of their vehicles. A second logged-in Parlé user redeems that code to get
 * time-boxed, permission-gated access — WITHOUT ever linking their own Tesla
 * account. Guest commands are executed using the owner's Tesla credentials,
 * but only while an active access record exists and the permission allows it.
 */

// ── Constants ─────────────────────────────────────────────

/** Share codes auto-expire 24h after creation. */
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** Allowed guest access durations (minutes). */
export const ALLOWED_DURATION_MINUTES = [1, 15, 60, 1440, 2880, 10080] as const;
export type DurationMinutes = (typeof ALLOWED_DURATION_MINUTES)[number];

/** Unambiguous alphabet (no 0/O/1/I) for human-readable codes. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Permission keys carried on a temporary access record. */
export type SharePermissionKey =
  | "status"
  | "wake"
  | "lock"
  | "unlock"
  | "ready"
  | "enableDrive";

export type SharePermissions = Record<SharePermissionKey, boolean>;

/** Default permissions applied at redemption time (driving is off by default). */
export const DEFAULT_SHARE_PERMISSIONS: SharePermissions = {
  status: true,
  wake: true,
  lock: true,
  unlock: true,
  ready: false,
  enableDrive: false,
};

/** Map a backend command (and the pseudo "status" action) to a permission key. */
const COMMAND_PERMISSION: Record<string, SharePermissionKey> = {
  status: "status",
  wake: "wake",
  lock: "lock",
  unlock: "unlock",
  "enable-drive": "enableDrive",
  "ready-vehicle": "ready",
};

// ── Code helpers ──────────────────────────────────────────

function randomChars(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Generate a code formatted like "FX1-3TF". */
export function generateCode(): string {
  return `${randomChars(3)}-${randomChars(3)}`;
}

/** Normalize user input: uppercase, keep alnum, re-insert the dash. */
export function normalizeCode(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 6) return input.trim().toUpperCase();
  return `${clean.slice(0, 3)}-${clean.slice(3)}`;
}

function coercePermissions(value: unknown): SharePermissions {
  const base = { ...DEFAULT_SHARE_PERMISSIONS };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    (Object.keys(base) as SharePermissionKey[]).forEach((k) => {
      if (typeof rec[k] === "boolean") base[k] = rec[k] as boolean;
    });
  }
  return base;
}

// ── Ownership guard ───────────────────────────────────────

/**
 * Confirm the caller can act as the vehicle owner. For MVP this means they have
 * a linked Tesla account (Tesla itself remains the source of truth for real
 * vehicle ownership when commands run). Returns the owner's token result.
 */
async function requireOwner(userId: string): Promise<AccessTokenResult> {
  const token = await getUserAccessToken(userId);
  if (!token.ok) {
    throw new ApiError(
      403,
      "access_denied",
      "Only a Tesla-connected vehicle owner can manage share codes.",
    );
  }
  return token;
}

async function snapshotVehicleMeta(
  vehicleId: string,
): Promise<{ vin: string | null; friendlyName: string | null }> {
  const v = await resolveVehicle(vehicleId);
  return { vin: v?.vin ?? null, friendlyName: v?.friendlyName ?? null };
}

// ── Code lifecycle ────────────────────────────────────────

export type ShareCodeView = {
  code: string;
  vehicleId: string;
  expiresAt: string;
  createdAt: string;
};

function toCodeView(row: {
  code: string;
  vehicleId: string;
  expiresAt: Date;
  createdAt: Date;
}): ShareCodeView {
  return {
    code: row.code,
    vehicleId: row.vehicleId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Owner: return the current active, non-expired code or create a fresh one. */
export async function getOrCreateActiveCode(
  ownerUserId: string,
  vehicleId: string,
): Promise<ShareCodeView> {
  await requireOwner(ownerUserId);

  const existing = await prisma.vehicleShareCode.findFirst({
    where: {
      ownerUserId,
      vehicleId,
      isActive: true,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return toCodeView(existing);

  return createCode(ownerUserId, vehicleId);
}

async function createCode(
  ownerUserId: string,
  vehicleId: string,
): Promise<ShareCodeView> {
  const meta = await snapshotVehicleMeta(vehicleId);
  const created = await prisma.vehicleShareCode.create({
    data: {
      ownerUserId,
      vehicleId,
      vin: meta.vin,
      friendlyName: meta.friendlyName,
      code: generateCode(),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return toCodeView(created);
}

/** Owner: deactivate existing codes for the vehicle and mint a new one. */
export async function regenerateCode(
  ownerUserId: string,
  vehicleId: string,
): Promise<ShareCodeView> {
  await requireOwner(ownerUserId);
  await prisma.vehicleShareCode.updateMany({
    where: { ownerUserId, vehicleId, isActive: true },
    data: { isActive: false },
  });
  return createCode(ownerUserId, vehicleId);
}

// ── Redemption ────────────────────────────────────────────

export type TemporaryAccessView = {
  id: string;
  vehicleId: string;
  /** Same id the web app writes as source_vehicle_id, for renter-app matching. */
  sourceVehicleId: string;
  vin: string | null;
  friendlyName: string | null;
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
};

type AccessRow = {
  id: string;
  vehicleId: string;
  vin: string | null;
  friendlyName: string | null;
  ownerUserId: string;
  guestUserId: string;
  permissions: unknown;
  startsAt: Date;
  expiresAt: Date;
};

/** Best-effort live-ish status from the most recent telemetry snapshot. */
type VehicleStatusMeta = {
  batteryLevel: number | null;
  rangeMiles: number | null;
  isLocked: boolean | null;
};

async function latestVehicleStatus(vehicleId: string): Promise<VehicleStatusMeta> {
  try {
    const snap = await prisma.telemetrySnapshot.findFirst({
      where: { vehicleId },
      orderBy: { lastSeenAt: "desc" },
      select: { batteryPercent: true, lockStatus: true },
    });
    if (!snap) return { batteryLevel: null, rangeMiles: null, isLocked: null };
    const isLocked =
      snap.lockStatus === "LOCKED"
        ? true
        : snap.lockStatus === "UNLOCKED"
          ? false
          : null;
    return {
      batteryLevel: snap.batteryPercent ?? null,
      rangeMiles: null, // range isn't persisted yet; surface null for now
      isLocked,
    };
  } catch {
    // Telemetry is optional context — never let it break an access lookup.
    return { batteryLevel: null, rangeMiles: null, isLocked: null };
  }
}

function toAccessView(row: AccessRow, status?: VehicleStatusMeta): TemporaryAccessView {
  const durationMinutes = Math.max(
    1,
    Math.round((row.expiresAt.getTime() - row.startsAt.getTime()) / 60000),
  );
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    sourceVehicleId: row.vehicleId,
    vin: row.vin,
    friendlyName: row.friendlyName,
    displayName: row.friendlyName,
    model: null,
    color: null,
    batteryLevel: status?.batteryLevel ?? null,
    rangeMiles: status?.rangeMiles ?? null,
    isLocked: status?.isLocked ?? null,
    ownerUserId: row.ownerUserId,
    guestUserId: row.guestUserId,
    permissions: coercePermissions(row.permissions),
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    durationMinutes,
  };
}

/** Map access rows to views, attaching best-effort vehicle status to each. */
async function toAccessViews(rows: AccessRow[]): Promise<TemporaryAccessView[]> {
  return Promise.all(
    rows.map(async (row) => toAccessView(row, await latestVehicleStatus(row.vehicleId))),
  );
}

/** Guest: redeem a code, creating a time-boxed access record. */
export async function redeemCode(
  guestUserId: string,
  rawCode: string,
  durationMinutes: number,
): Promise<TemporaryAccessView> {
  const code = normalizeCode(rawCode);

  if (!ALLOWED_DURATION_MINUTES.includes(durationMinutes as DurationMinutes)) {
    throw new ApiError(
      400,
      "bad_request",
      "Invalid duration. Choose 1m, 15m, 1h, 24h, 48h, or 1 week.",
    );
  }

  // Look the code up regardless of active/expiry so we can tell "doesn't exist"
  // (404) apart from "expired/deactivated" (410) — the mobile app maps these to
  // different messages.
  const shareCode = await prisma.vehicleShareCode.findFirst({
    where: { code },
    orderBy: { createdAt: "desc" },
  });
  if (!shareCode) {
    throw new ApiError(
      404,
      "not_found",
      "That ride-share code doesn’t exist. Double-check it and try again.",
    );
  }
  const isExpired =
    !shareCode.isActive || shareCode.expiresAt.getTime() <= Date.now();
  if (isExpired) {
    throw new ApiError(
      410,
      "not_found",
      "That ride-share code has expired. Ask the owner to share a new one.",
    );
  }
  if (shareCode.ownerUserId === guestUserId) {
    throw new ApiError(
      400,
      "bad_request",
      "You can’t redeem a ride-share code for your own vehicle.",
    );
  }

  // Replace any prior active access this guest has for the same vehicle.
  await prisma.temporaryVehicleAccess.updateMany({
    where: {
      guestUserId,
      vehicleId: shareCode.vehicleId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  const now = new Date();
  const created = await prisma.temporaryVehicleAccess.create({
    data: {
      ownerUserId: shareCode.ownerUserId,
      guestUserId,
      vehicleId: shareCode.vehicleId,
      vin: shareCode.vin,
      friendlyName: shareCode.friendlyName,
      shareCodeId: shareCode.id,
      permissions: DEFAULT_SHARE_PERMISSIONS,
      startsAt: now,
      expiresAt: new Date(now.getTime() + durationMinutes * 60 * 1000),
    },
  });

  return toAccessView(created, await latestVehicleStatus(created.vehicleId));
}

// ── Access lookups ────────────────────────────────────────

/** Active (not revoked, not expired) access records where the user is the guest. */
export async function getActiveAccessAsGuest(
  guestUserId: string,
): Promise<TemporaryAccessView[]> {
  const rows = await prisma.temporaryVehicleAccess.findMany({
    where: { guestUserId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  return toAccessViews(rows);
}

/** Active access records where the user is the owner (the guests they granted). */
export async function getActiveAccessAsOwner(
  ownerUserId: string,
): Promise<TemporaryAccessView[]> {
  const rows = await prisma.temporaryVehicleAccess.findMany({
    where: { ownerUserId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  return toAccessViews(rows);
}

/** Single active access record for a (guest, vehicle) pair, if any. */
async function findActiveAccess(guestUserId: string, vehicleId: string) {
  return prisma.temporaryVehicleAccess.findFirst({
    where: {
      guestUserId,
      vehicleId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Owner: revoke a guest's access by id. */
export async function revokeAccess(
  ownerUserId: string,
  accessId: string,
): Promise<void> {
  const row = await prisma.temporaryVehicleAccess.findUnique({
    where: { id: accessId },
  });
  if (!row || row.ownerUserId !== ownerUserId) {
    throw new ApiError(404, "not_found", "Access record not found.");
  }
  if (row.revokedAt) return;
  await prisma.temporaryVehicleAccess.update({
    where: { id: accessId },
    data: { revokedAt: new Date() },
  });
}

// ── Authorization for vehicle actions ─────────────────────

export type VehicleAuth = {
  role: "owner" | "guest";
  /** Whose Tesla token to use (owner for guests). */
  tokenUserId: string;
  tokenResult: AccessTokenResult;
  accessId?: string;
  ownerUserId?: string;
  /** True when ownership was confirmed against public.fleet_available_vehicles. */
  ownerVerifiedViaFleet?: boolean;
};

/**
 * Confirm the caller owns the requested vehicle per the renter fleet table
 * (`public.fleet_available_vehicles`), matched by `source_vehicle_id` (falling
 * back to the row id). This table lives in the SAME Supabase Postgres this
 * service already connects to via `DATABASE_URL`, so we read it directly — no
 * extra client or credential is introduced.
 *
 * Ownership is keyed on `owner_user_id`, which the fleet web app writes as the
 * Supabase `auth.uid()` — the exact value the mobile app sends as
 * `x-triggered-by`. Never throws: a lookup failure returns false so the caller
 * falls back to the linked-Tesla-account owner path.
 */
async function ownsVehicleViaFleet(
  userId: string,
  vehicleId: string,
): Promise<boolean> {
  if (!userId || userId === "system") return false;
  try {
    const rows = await prisma.$queryRaw<Array<{ owner_user_id: string }>>`
      SELECT owner_user_id
      FROM public.fleet_available_vehicles
      WHERE owner_user_id = ${userId}
        AND (source_vehicle_id = ${vehicleId} OR id::text = ${vehicleId})
      LIMIT 1
    `;
    return rows.length > 0;
  } catch (err) {
    // fleet_available_vehicles may be absent in some environments — never let an
    // ownership lookup crash a command; fall back to the Tesla-linked path.
    console.warn(
      "[authz] fleet ownership lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Authorize a vehicle action for `triggeredBy` against `vehicleId`.
 *
 * - Owners (callers with a linked Tesla account) are allowed every action and
 *   use their own token.
 * - Otherwise the caller must hold an active TemporaryVehicleAccess record for
 *   the vehicle and the action must be permitted; the action then runs with the
 *   owner's Tesla token.
 *
 * `command` accepts a backend command name or the pseudo-action "status".
 * Throws ApiError(403) when the caller isn't allowed.
 */
export async function authorizeVehicleAction(
  triggeredBy: string,
  vehicleId: string,
  command: string,
): Promise<VehicleAuth> {
  // Explicit ownership: does this caller own the vehicle per the renter fleet
  // table (owner_user_id == caller, matched by source_vehicle_id)?
  const ownsViaFleet = await ownsVehicleViaFleet(triggeredBy, vehicleId);

  // Owner path — the caller either owns the vehicle in the fleet table OR has
  // their own linked Tesla connection (which serves the web app owner dashboard
  // for vehicles not published to the renter fleet). A linked account whose
  // token merely failed to refresh is still treated as the owner so the caller
  // surfaces the correct "re-link Tesla" error (rather than an access error).
  const ownerToken = await getUserAccessToken(triggeredBy);
  const isOwnerByToken = ownerToken.ok || ownerToken.reason === "refresh_failed";

  if (ownsViaFleet || isOwnerByToken) {
    console.log("[authz] decision", {
      command,
      role: "owner",
      ownerVerifiedViaFleet: ownsViaFleet,
      ownerByTeslaLink: isOwnerByToken,
    });
    return {
      role: "owner",
      tokenUserId: triggeredBy,
      tokenResult: ownerToken,
      ownerUserId: triggeredBy,
      ownerVerifiedViaFleet: ownsViaFleet,
    };
  }

  // Guest path — must have an active access record for this vehicle.
  const access = await findActiveAccess(triggeredBy, vehicleId);
  if (!access) {
    console.log("[authz] decision", {
      command,
      role: "denied",
      ownerVerifiedViaFleet: false,
      hasActiveShare: false,
    });
    throw new ApiError(
      403,
      "access_denied",
      "You don’t have access to this vehicle, or your temporary access has expired.",
    );
  }

  const permKey = COMMAND_PERMISSION[command];
  if (permKey) {
    const perms = coercePermissions(access.permissions);
    if (!perms[permKey]) {
      throw new ApiError(
        403,
        "access_denied",
        "This action isn’t allowed for your temporary access.",
      );
    }
  }

  const ownerTokenForGuest = await getUserAccessToken(access.ownerUserId);
  console.log("[authz] decision", {
    command,
    role: "guest",
    hasActiveShare: true,
    accessId: access.id,
  });
  return {
    role: "guest",
    tokenUserId: access.ownerUserId,
    tokenResult: ownerTokenForGuest,
    accessId: access.id,
    ownerUserId: access.ownerUserId,
  };
}
