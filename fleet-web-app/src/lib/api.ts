/**
 * Backend API client for the Parlé fleet web app.
 *
 * Every call targets the Parlé backend at `NEXT_PUBLIC_API_BASE_URL`. The
 * backend owns all Tesla secrets — the frontend never talks to Tesla
 * directly. Protected routes are authenticated with two headers:
 *
 *   - `x-parle-api-key`  → shared service key (`NEXT_PUBLIC_PARLE_API_KEY`)
 *   - `x-triggered-by`   → the Supabase user id of the signed-in user
 *
 * Command requests additionally send an `x-request-id` for idempotency.
 *
 * The backend wraps every JSON response in an envelope:
 *   success → `{ ok: true,  data }`
 *   failure → `{ ok: false, error: { reason, message, details } }`
 *
 * `request<T>()` unwraps that envelope and throws an `ApiError` on failure so
 * callers only ever deal with the inner `data` or a typed error.
 *
 * Required env (see `.env.local`):
 *   NEXT_PUBLIC_API_BASE_URL   e.g. https://your-backend.example.com
 *   NEXT_PUBLIC_PARLE_API_KEY  the x-parle-api-key shared secret
 */

// ── Config ────────────────────────────────────────────────

function getApiBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  return base.replace(/\/+$/, "");
}

function getParleApiKey(): string {
  return process.env.NEXT_PUBLIC_PARLE_API_KEY ?? "";
}

/** True when both the base URL and API key are present. */
export function isApiConfigured(): boolean {
  return getApiBaseUrl().length > 0 && getParleApiKey().length > 0;
}

export const API_NOT_CONFIGURED_MESSAGE =
  "The Parlé backend isn’t configured yet. Add NEXT_PUBLIC_API_BASE_URL and NEXT_PUBLIC_PARLE_API_KEY to .env.local and restart the dev server.";

// ── Errors ────────────────────────────────────────────────

/** Backend `reason` codes, mirrored from the server's ErrorReason union. */
export type ApiErrorReason =
  | "offline"
  | "asleep_timeout"
  | "auth_error"
  | "command_rejected"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "access_denied"
  | "tesla_error"
  | "tesla_auth_error"
  | "tesla_pairing_required"
  | "tesla_rate_limited"
  | "tesla_upstream_error"
  | "vcp_required"
  | "mobile_access_disabled"
  | "vehicle_asleep_or_offline"
  | "vehicle_not_found"
  | "vehicle_in_service"
  | "auth_expired_or_invalid"
  | "generic_tesla_upstream_error"
  | "network_error"
  | "config_error"
  | "unknown";

export class ApiError extends Error {
  reason: ApiErrorReason;
  status: number;
  details: unknown;

  constructor(
    message: string,
    reason: ApiErrorReason = "unknown",
    status = 0,
    details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.reason = reason;
    this.status = status;
    this.details = details;
  }
}

/**
 * Turn any thrown error into a short, user-facing sentence. Falls back to the
 * raw message for unrecognized reasons so we never hide useful detail.
 */
export function getReadableErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const raw = error.message?.trim() ?? "";
    const lower = raw.toLowerCase();

    if (
      lower.includes("not supported") ||
      lower.includes("unsupported") ||
      lower.includes("not available on this vehicle") ||
      lower.includes("not available for this vehicle")
    ) {
      return "That feature isn’t supported on this vehicle yet.";
    }

    switch (error.reason) {
      case "config_error":
        return API_NOT_CONFIGURED_MESSAGE;
      case "network_error":
        return "We couldn’t reach Parlé. Check your connection and try again.";
      case "auth_error":
        return "Parlé couldn’t authenticate this request. Sign in again or contact support.";
      case "access_denied":
        return "You don’t have permission to control this vehicle, or the temporary access has expired.";
      case "tesla_auth_error":
      case "auth_expired_or_invalid":
        return "Your Tesla connection has expired. Reconnect Tesla and try again.";
      case "tesla_pairing_required":
      case "vcp_required":
        return "Parlé isn’t paired with this vehicle yet. Add the Parlé key in the Tesla app, then try again.";
      case "mobile_access_disabled":
        return "Mobile Access is off for this vehicle. Enable it in the Tesla, then try again.";
      case "vehicle_asleep_or_offline":
      case "asleep_timeout":
      case "offline":
        return "The vehicle is asleep or offline. Wake it, wait a moment, and try again.";
      case "vehicle_in_service":
        return "This vehicle is in service mode, so Tesla isn’t accepting remote commands.";
      case "vehicle_not_found":
      case "not_found":
        return "We couldn’t find that vehicle. Refresh your fleet and try again.";
      case "tesla_rate_limited":
      case "rate_limited":
        return "Tesla is limiting requests right now. Wait a moment and try again.";
      case "command_rejected":
        if (lower.includes("another renter") || lower.includes("isn’t available")) {
          return raw;
        }
        return "Tesla rejected that command. It may not be supported by this vehicle or its current state.";
      case "bad_request":
        return "That action isn’t available for this vehicle right now.";
      case "tesla_upstream_error":
      case "tesla_error":
      case "generic_tesla_upstream_error":
        return "Tesla didn’t complete the request. Please try again shortly.";
      default:
        return raw || "Something went wrong. Please try again.";
    }
  }

  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

// ── Core request helper ───────────────────────────────────

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { reason?: string; message?: string; details?: unknown } };

type RequestOptions = {
  method?: "GET" | "POST";
  /** Supabase user id → sent as `x-triggered-by`. Required for protected routes. */
  userId?: string | null;
  /** JSON body for POST requests. */
  body?: unknown;
  /** Idempotency id → sent as `x-request-id` (command routes). */
  requestId?: string;
  /** Skip the API-key header for always-public routes. */
  publicRoute?: boolean;
};

/**
 * Perform a request against the backend and return the unwrapped `data`.
 * Throws an `ApiError` for transport failures, non-2xx responses, or
 * `{ ok: false }` envelopes.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", userId, body, requestId, publicRoute = false } = options;

  const base = getApiBaseUrl();
  if (!base) {
    throw new ApiError(API_NOT_CONFIGURED_MESSAGE, "config_error");
  }
  if (!publicRoute && !getParleApiKey()) {
    throw new ApiError(API_NOT_CONFIGURED_MESSAGE, "config_error");
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (!publicRoute) headers["x-parle-api-key"] = getParleApiKey();
  if (userId) headers["x-triggered-by"] = userId;
  if (requestId) headers["x-request-id"] = requestId;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? err.message : "Network request failed",
      "network_error",
    );
  }

  // 204 / empty body → nothing to unwrap.
  if (res.status === 204) return undefined as T;

  let payload: Envelope<T> | null = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text) as Envelope<T>;
    } catch {
      payload = null;
    }
  }

  if (!res.ok || (payload && payload.ok === false)) {
    const errObj =
      payload && payload.ok === false ? payload.error ?? {} : {};
    const reason = (errObj.reason as ApiErrorReason) ?? "unknown";
    const message =
      errObj.message ??
      `Request to ${path} failed (${res.status} ${res.statusText})`;
    throw new ApiError(message, reason, res.status, errObj.details ?? null);
  }

  // Some envelopes (or non-enveloped responses) may not carry `data`.
  if (payload && "data" in payload) return payload.data;
  return (payload as unknown as T) ?? (undefined as T);
}

// ── Vehicle types ─────────────────────────────────────────

/** Local fallback thumbnails when the backend has no image for a vehicle. */
const FALLBACK_THUMBNAILS = [
  "/assets/vehicle_white_thumbnail@2x.png",
  "/assets/vehicle_red_thumbnail@2x.png",
  "/assets/vehicle_black_thumbnail@2x.png",
] as const;

/** Per-command permissions for a temporarily shared vehicle. */
export type VehiclePermissions = {
  status: boolean;
  wake: boolean;
  lock: boolean;
  unlock: boolean;
  ready: boolean;
  enableDrive: boolean;
};

/** Vehicle shape the UI renders. Normalized from the backend's raw response. */
export type ApiVehicle = {
  /** Backend id used for command + status routes. */
  id: string;
  vin: string;
  /** Best-effort model year decoded from the VIN (may be ""). */
  year: string;
  /** Display model, e.g. "Tesla Model Y". Falls back to the friendly name. */
  model: string;
  /** Human-friendly name from the backend, when present. */
  name?: string;
  image: string;
  /** Online state reported by the list endpoint ("online" | "asleep" | "offline"). */
  state?: string;
  /** True when this vehicle is available via a temporary ride-share, not owned. */
  shared?: boolean;
  /** Temporary access record id (shared vehicles only). */
  accessId?: string;
  /** Owner's Supabase user id (shared vehicles only). */
  ownerUserId?: string;
  /** ISO expiry of the temporary access (shared vehicles only). */
  expiresAt?: string;
  /** Allowed commands for a shared vehicle (owned vehicles allow everything). */
  permissions?: VehiclePermissions;
};

/** Raw vehicle from `GET /vehicles`. */
type RawVehicle = {
  id?: string | number;
  teslaVehicleId?: string | number;
  vin?: string;
  friendlyName?: string | null;
  displayName?: string | null;
  name?: string | null;
  state?: string | null;
  shared?: boolean;
  accessId?: string;
  ownerUserId?: string;
  expiresAt?: string;
  permissions?: Partial<VehiclePermissions> | null;
};

/** Live status from `GET /vehicles/:id/status`. */
export type VehicleLiveStatus = {
  /** "online" | "asleep" | "offline" | other lowercase Tesla state. */
  state: string;
  batteryLevel: number | null;
  isLocked: boolean | null;
  chargingState: string | null;
  rangeKm: number | null;
};

export type TeslaStatus = {
  linked: boolean;
  vehicleCount: number;
  hasVehicles: boolean;
  tokenExpired?: boolean;
  linkedAt?: string;
  updatedAt?: string;
};

/**
 * Vehicle shape consumed by `Dashboard.tsx` / `VehicleControlCard.tsx` via the
 * flat `getVehicles()` helper. Display-ready (always has a name + image).
 */
export type Vehicle = {
  id: string;
  name: string;
  image: string;
  vin: string;
  state: string;
};

/** Live status returned by `GET /vehicles/:id/status` (flat `getVehicleStatus`). */
export type VehicleStatus = {
  /** Lowercased Tesla online state ("online" | "asleep" | "offline" | …). */
  state: string;
  batteryLevel: number | null;
  isLocked: boolean | null;
  chargingState: string | null;
  rangeKm: number | null;
  insideTemp?: number | null;
  outsideTemp?: number | null;
  lastSeenAt?: string | null;
  lastLat?: number | null;
  lastLng?: number | null;
};

/** One row from `GET /logs/commands` (the backend `CommandLog` model). */
export type CommandLogEntry = {
  id: string;
  command: string;
  result: string;
  errorMessage: string | null;
  createdAt: string;
  requestId?: string;
  vehicleId?: string;
  triggeredBy?: string;
  errorReason?: string | null;
  teslaStatus?: number | null;
};

/** A ride-share code for one of the owner's vehicles. */
export type ShareCode = {
  code: string;
  vehicleId: string;
  expiresAt: string;
  createdAt: string;
};

/** A temporary access record (guest's view or owner's grant). */
export type TemporaryAccess = {
  id: string;
  vehicleId: string;
  vin: string | null;
  friendlyName: string | null;
  ownerUserId: string;
  guestUserId: string;
  permissions: VehiclePermissions;
  startsAt: string;
  expiresAt: string;
};

/** Active access records for the current user, split by role. */
export type ShareAccess = {
  /** Vehicles shared *with* me (I'm the guest). */
  asGuest: TemporaryAccess[];
  /** Guests I've granted access to (I'm the owner). */
  asOwner: TemporaryAccess[];
};

/** Allowed guest access durations (minutes), matched to the backend. */
export const SHARE_DURATIONS: { label: string; minutes: number }[] = [
  { label: "1 minute", minutes: 1 },
  { label: "15 minutes", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 1440 },
  { label: "48 hours", minutes: 2880 },
  { label: "1 week", minutes: 10080 },
];

// ── Normalization helpers ─────────────────────────────────

function pickFallbackThumbnail(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return FALLBACK_THUMBNAILS[Math.abs(h) % FALLBACK_THUMBNAILS.length];
}

const VIN_MODEL_BY_CODE: Record<string, string> = {
  S: "Tesla Model S",
  "3": "Tesla Model 3",
  X: "Tesla Model X",
  Y: "Tesla Model Y",
  R: "Tesla Roadster",
};

/** Tesla VIN model-year codes (position 10). Skips I, O, Q, U, Z and 0. */
const VIN_YEAR_BY_CODE: Record<string, string> = {
  A: "2010", B: "2011", C: "2012", D: "2013", E: "2014", F: "2015",
  G: "2016", H: "2017", J: "2018", K: "2019", L: "2020", M: "2021",
  N: "2022", P: "2023", R: "2024", S: "2025", T: "2026", V: "2027",
  W: "2028", X: "2029", Y: "2030",
};

function decodeVin(vin: string): { model: string | null; year: string | null } {
  if (vin.length < 10) return { model: null, year: null };
  const model = VIN_MODEL_BY_CODE[vin[3]?.toUpperCase()] ?? null;
  const year = VIN_YEAR_BY_CODE[vin[9]?.toUpperCase()] ?? null;
  return { model, year };
}

const ALL_PERMISSIONS: VehiclePermissions = {
  status: true,
  wake: true,
  lock: true,
  unlock: true,
  ready: true,
  enableDrive: true,
};

function normalizePermissions(
  raw: Partial<VehiclePermissions> | null | undefined,
): VehiclePermissions {
  const base: VehiclePermissions = {
    status: false,
    wake: false,
    lock: false,
    unlock: false,
    ready: false,
    enableDrive: false,
  };
  if (raw && typeof raw === "object") {
    (Object.keys(base) as (keyof VehiclePermissions)[]).forEach((k) => {
      if (typeof raw[k] === "boolean") base[k] = raw[k] as boolean;
    });
  }
  return base;
}

function normalizeVehicle(raw: RawVehicle, index: number): ApiVehicle {
  const id = String(raw.id ?? raw.teslaVehicleId ?? raw.vin ?? `vehicle-${index}`);
  const vin = String(raw.vin ?? "");
  const friendly =
    raw.friendlyName ?? raw.displayName ?? raw.name ?? undefined;
  const decoded = decodeVin(vin);
  const model = decoded.model ?? (friendly || "Tesla");
  const shared = raw.shared === true;
  return {
    id,
    vin,
    year: decoded.year ?? "",
    model,
    name: friendly ?? undefined,
    image: pickFallbackThumbnail(id),
    state: raw.state ? String(raw.state).toLowerCase() : undefined,
    shared,
    accessId: raw.accessId,
    ownerUserId: raw.ownerUserId,
    expiresAt: raw.expiresAt,
    // Owned vehicles allow everything; shared vehicles use backend permissions.
    permissions: shared ? normalizePermissions(raw.permissions) : ALL_PERMISSIONS,
  };
}

function unwrapVehicleList(
  data: RawVehicle[] | { vehicles?: RawVehicle[] } | null | undefined,
): RawVehicle[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.vehicles)) return data.vehicles;
  return [];
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── OAuth ─────────────────────────────────────────────────

/**
 * Build the backend's Tesla OAuth start URL. The backend (not the frontend)
 * performs the OAuth handshake and holds all Tesla secrets.
 *
 * `returnTo=web` tells the backend to redirect back to this web app after
 * OAuth (vs. the mobile deep link used by the Rork app).
 */
export function getOAuthStartUrl(userId: string): string {
  const params = new URLSearchParams({ userId, returnTo: "web" });
  return `${getApiBaseUrl()}/auth/tesla/start?${params.toString()}`;
}

/** Redirect the browser to the backend's Tesla OAuth start endpoint. */
export function startTeslaOAuth(userId: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(getOAuthStartUrl(userId));
}

// ── API surface ───────────────────────────────────────────

export const api = {
  /** GET /auth/tesla/status — is this user's Tesla account linked? */
  async getTeslaStatus(userId: string): Promise<TeslaStatus> {
    return request<TeslaStatus>("/auth/tesla/status", { userId });
  },

  /** GET /vehicles — the user's Tesla vehicles, normalized for the UI. */
  async getVehiclesParsed(userId: string): Promise<ApiVehicle[]> {
    const data = await request<RawVehicle[] | { vehicles?: RawVehicle[] }>(
      "/vehicles",
      { userId },
    );
    return unwrapVehicleList(data).map((raw, i) => normalizeVehicle(raw, i));
  },

  /** GET /vehicles/:id/status — live status for a single vehicle. */
  async getVehicleStatus(
    vehicleId: string,
    userId: string,
  ): Promise<VehicleLiveStatus> {
    return request<VehicleLiveStatus>(
      `/vehicles/${encodeURIComponent(vehicleId)}/status`,
      { userId },
    );
  },

  /** POST /vehicles/:id/wake */
  async wakeVehicle(vehicleId: string, userId: string): Promise<unknown> {
    const requestId = randomRequestId();
    return request(`/vehicles/${encodeURIComponent(vehicleId)}/wake`, {
      method: "POST",
      userId,
      requestId,
      body: { requestId },
    });
  },

  /** POST /vehicles/:id/unlock */
  async unlockVehicle(vehicleId: string, userId: string): Promise<unknown> {
    const requestId = randomRequestId();
    return request(`/vehicles/${encodeURIComponent(vehicleId)}/unlock`, {
      method: "POST",
      userId,
      requestId,
      body: { requestId },
    });
  },

  /** POST /vehicles/:id/lock */
  async lockVehicle(vehicleId: string, userId: string): Promise<unknown> {
    const requestId = randomRequestId();
    return request(`/vehicles/${encodeURIComponent(vehicleId)}/lock`, {
      method: "POST",
      userId,
      requestId,
      body: { requestId },
    });
  },

  /** POST /vehicles/:id/enable-drive */
  async enableDrive(vehicleId: string, userId: string): Promise<unknown> {
    const requestId = randomRequestId();
    return request(`/vehicles/${encodeURIComponent(vehicleId)}/enable-drive`, {
      method: "POST",
      userId,
      requestId,
      body: { requestId },
    });
  },

  /** POST /vehicles/:id/ready — wake → unlock → enable-drive. */
  async readyVehicle(vehicleId: string, userId: string): Promise<unknown> {
    const requestId = randomRequestId();
    return request(`/vehicles/${encodeURIComponent(vehicleId)}/ready`, {
      method: "POST",
      userId,
      requestId,
      body: { requestId },
    });
  },

  /** POST /auth/tesla/disconnect — remove the user's stored Tesla tokens. */
  async disconnect(userId: string): Promise<unknown> {
    return request("/auth/tesla/disconnect", { method: "POST", userId });
  },

  // ── Temporary vehicle sharing (ride-share codes) ────────

  /** GET /share/code — owner: current active code for a vehicle (creates one if needed). */
  async getShareCode(userId: string, vehicleId: string): Promise<ShareCode> {
    const params = new URLSearchParams({ vehicleId });
    return request<ShareCode>(`/share/code?${params.toString()}`, { userId });
  },

  /** POST /share/code/regenerate — owner: deactivate old code, mint a new one. */
  async regenerateShareCode(userId: string, vehicleId: string): Promise<ShareCode> {
    return request<ShareCode>("/share/code/regenerate", {
      method: "POST",
      userId,
      body: { vehicleId },
    });
  },

  /** POST /share/redeem — guest: redeem a code into time-boxed access. */
  async redeemShareCode(
    userId: string,
    code: string,
    durationMinutes: number,
  ): Promise<TemporaryAccess> {
    return request<TemporaryAccess>("/share/redeem", {
      method: "POST",
      userId,
      body: { code, durationMinutes },
    });
  },

  /** GET /share/access — active temporary access for the current user (both roles). */
  async getTemporaryAccess(userId: string): Promise<ShareAccess> {
    return request<ShareAccess>("/share/access", { userId });
  },

  /** POST /share/revoke — owner: revoke a guest's access by id. */
  async revokeTemporaryAccess(userId: string, accessId: string): Promise<unknown> {
    return request("/share/revoke", {
      method: "POST",
      userId,
      body: { accessId },
    });
  },
};

export type Api = typeof api;

// ── Flat named exports ────────────────────────────────────
// `Dashboard.tsx` and `VehicleControlCard.tsx` import these functions directly.
// Account-scoped calls take `(userId)`; vehicle-scoped calls take
// `(userId, vehicleId)`. Endpoints match the backend the `api` object uses
// (Tesla auth lives under `/auth/tesla/*`).

/** Build a display-ready Vehicle from a raw `GET /vehicles` row. */
function toVehicle(raw: RawVehicle, index: number): Vehicle {
  const id = String(raw.id ?? raw.teslaVehicleId ?? raw.vin ?? `vehicle-${index}`);
  const vin = String(raw.vin ?? "");
  const friendly = raw.friendlyName ?? raw.displayName ?? raw.name ?? null;
  const decoded = decodeVin(vin);
  return {
    id,
    vin,
    name: friendly ?? decoded.model ?? "Tesla",
    image: pickFallbackThumbnail(id),
    state: raw.state ? String(raw.state).toLowerCase() : "",
  };
}

/** GET /auth/tesla/status — is this user's Tesla account linked? */
export function getTeslaStatus(userId: string): Promise<TeslaStatus> {
  return request<TeslaStatus>("/auth/tesla/status", { userId });
}

/** POST /auth/tesla/disconnect — remove the user's stored Tesla tokens. */
export function disconnectTesla(userId: string): Promise<unknown> {
  return request("/auth/tesla/disconnect", { method: "POST", userId });
}

/** GET /vehicles — the user's vehicles (owned + temporarily shared). */
export async function getVehicles(userId: string): Promise<Vehicle[]> {
  const data = await request<RawVehicle[] | { vehicles?: RawVehicle[] }>(
    "/vehicles",
    { userId },
  );
  return unwrapVehicleList(data).map((raw, i) => toVehicle(raw, i));
}

/** GET /vehicles/:id/status — live status for a single vehicle. */
export function getVehicleStatus(
  userId: string,
  vehicleId: string,
): Promise<VehicleStatus> {
  return request<VehicleStatus>(
    `/vehicles/${encodeURIComponent(vehicleId)}/status`,
    { userId },
  );
}

/** GET /logs/commands?vehicleId=…&limit=… — recent command logs. */
export async function getVehicleLogs(
  userId: string,
  vehicleId: string,
  limit = 50,
): Promise<CommandLogEntry[]> {
  const params = new URLSearchParams({ vehicleId, limit: String(limit) });
  const data = await request<{ logs?: CommandLogEntry[] } | CommandLogEntry[]>(
    `/logs/commands?${params.toString()}`,
    { userId },
  );
  return Array.isArray(data) ? data : data?.logs ?? [];
}

/** POST /vehicles/:id/wake */
export function wakeVehicle(userId: string, vehicleId: string): Promise<unknown> {
  return api.wakeVehicle(vehicleId, userId);
}

/** POST /vehicles/:id/lock */
export function lockVehicle(userId: string, vehicleId: string): Promise<unknown> {
  return api.lockVehicle(vehicleId, userId);
}

/** POST /vehicles/:id/unlock */
export function unlockVehicle(
  userId: string,
  vehicleId: string,
): Promise<unknown> {
  return api.unlockVehicle(vehicleId, userId);
}

/** POST /vehicles/:id/enable-drive */
export function enableDriveVehicle(
  userId: string,
  vehicleId: string,
): Promise<unknown> {
  return api.enableDrive(vehicleId, userId);
}

/** POST /vehicles/:id/ready — wake → unlock → enable-drive. */
export function readyVehicle(
  userId: string,
  vehicleId: string,
): Promise<unknown> {
  return api.readyVehicle(vehicleId, userId);
}

// Flat aliases for the temporary vehicle sharing API (also on the `api` object).

/** GET /share/code */
export function getShareCode(userId: string, vehicleId: string): Promise<ShareCode> {
  return api.getShareCode(userId, vehicleId);
}

/** POST /share/code/regenerate */
export function regenerateShareCode(
  userId: string,
  vehicleId: string,
): Promise<ShareCode> {
  return api.regenerateShareCode(userId, vehicleId);
}

/** POST /share/redeem */
export function redeemShareCode(
  userId: string,
  code: string,
  durationMinutes: number,
): Promise<TemporaryAccess> {
  return api.redeemShareCode(userId, code, durationMinutes);
}

/** GET /share/access */
export function getTemporaryAccess(userId: string): Promise<ShareAccess> {
  return api.getTemporaryAccess(userId);
}

/** POST /share/revoke */
export function revokeTemporaryAccess(
  userId: string,
  accessId: string,
): Promise<unknown> {
  return api.revokeTemporaryAccess(userId, accessId);
}
