import axios from "axios";
import { prisma } from "../db/prisma.js";
import { config } from "../config/env.js";

// ── Public types ──────────────────────────────────────────

export interface TeslaLinkStatus {
  linked: boolean;
  vehicleCount: number;
  hasVehicles: boolean;
  tokenExpired?: boolean;
  linkedAt?: string;
  updatedAt?: string;
}

export interface TeslaVehicleSummary {
  id: string;
  vehicleId: number;
  vin: string;
  displayName: string | null;
  state: string;
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; refreshed: boolean; expiresAt: Date }
  | { ok: false; reason: "not_linked" | "refresh_failed" };

// ── Private types (Tesla API responses) ───────────────────

interface TeslaVehicleListItem {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string | null;
  state: string;
}

interface TeslaVehicleListResponse {
  response: TeslaVehicleListItem[];
  count: number;
}

interface TeslaRefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// ── Internal helpers ──────────────────────────────────────

/**
 * Refresh an expired Tesla access token using the refresh_token grant.
 * Updates the TeslaAccount row in the database with the new credentials.
 * Returns the new access token, or null if refresh fails.
 * Never leaks tokens in logs.
 */
async function refreshAccessToken(
  userId: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  const tokenUrl = process.env.TESLA_TOKEN_URL;
  const clientId = process.env.TESLA_CLIENT_ID;
  if (!tokenUrl || !clientId) return null;

  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });

    // Include client_secret if available (required by some Tesla app types)
    const clientSecret = process.env.TESLA_CLIENT_SECRET;
    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }

    const res = await axios.post<TeslaRefreshTokenResponse>(tokenUrl, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: config.httpTimeoutMs,
    });

    const { access_token, refresh_token: newRefresh, expires_in } = res.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await prisma.teslaAccount.update({
      where: { userId },
      data: {
        accessToken: access_token,
        refreshToken: newRefresh,
        expiresAt,
      },
    });

    return { accessToken: access_token, expiresAt };
  } catch {
    return null;
  }
}

// ── Exported helpers ──────────────────────────────────────

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Load the per-user Tesla access token, refreshing if expired or near-expiry.
 * Proactively refreshes when the token has fewer than 5 minutes remaining so
 * downstream flows (wake polling, proxy commands) always start with a fresh token.
 * Returns a discriminated result so callers can log exactly what happened.
 */
export async function getUserAccessToken(
  userId: string,
): Promise<AccessTokenResult> {
  const account = await prisma.teslaAccount.findUnique({
    where: { userId },
    select: { accessToken: true, refreshToken: true, expiresAt: true },
  });

  if (!account) {
    return { ok: false, reason: "not_linked" };
  }

  // Token still valid with enough remaining lifetime
  if (account.expiresAt.getTime() > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return { ok: true, accessToken: account.accessToken, refreshed: false, expiresAt: account.expiresAt };
  }

  // Token expired or near-expiry — proactively refresh
  const refreshResult = await refreshAccessToken(userId, account.refreshToken);
  if (refreshResult) {
    return { ok: true, accessToken: refreshResult.accessToken, refreshed: true, expiresAt: refreshResult.expiresAt };
  }

  // Refresh failed but token might still be technically valid (near-expiry case)
  if (account.expiresAt.getTime() > Date.now()) {
    return { ok: true, accessToken: account.accessToken, refreshed: false, expiresAt: account.expiresAt };
  }

  return { ok: false, reason: "refresh_failed" };
}

/**
 * Fetch the user's full vehicle list from the Tesla Fleet API.
 * Uses the per-user access token (not the fleet bearer token).
 */
export async function fetchUserVehicles(
  accessToken: string,
): Promise<TeslaVehicleSummary[]> {
  const res = await axios.get<TeslaVehicleListResponse>(
    `${config.teslaBaseUrl}/api/1/vehicles`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: config.httpTimeoutMs,
    },
  );

  const raw = res.data?.response;
  if (!Array.isArray(raw)) return [];

  return raw.map((v) => ({
    id: String(v.id),
    vehicleId: v.vehicle_id,
    vin: v.vin ?? "",
    displayName: v.display_name ?? null,
    state: v.state ?? "unknown",
  }));
}

/**
 * Call Tesla Fleet API to get vehicle count only (lighter than full list).
 */
async function fetchUserVehicleCount(accessToken: string): Promise<number> {
  const res = await axios.get<TeslaVehicleListResponse>(
    `${config.teslaBaseUrl}/api/1/vehicles`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: config.httpTimeoutMs,
    },
  );
  return res.data?.count ?? res.data?.response?.length ?? 0;
}

// ── Status endpoint helper ────────────────────────────────

/**
 * Get the Tesla link status for a user, including live vehicle count.
 * - If unlinked: { linked: false, vehicleCount: 0, hasVehicles: false }
 * - If linked:   { linked: true, vehicleCount, hasVehicles, ... }
 *
 * Attempts token refresh when expired.
 * Never leaks tokens or secrets in the response.
 */
export async function getTeslaLinkStatus(
  userId: string,
): Promise<TeslaLinkStatus> {
  const account = await prisma.teslaAccount.findUnique({
    where: { userId },
    select: {
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!account) {
    return { linked: false, vehicleCount: 0, hasVehicles: false };
  }

  const base = {
    linked: true as const,
    linkedAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };

  let accessToken = account.accessToken;
  let tokenExpired = account.expiresAt.getTime() < Date.now();

  // ── Token refresh if expired ──
  if (tokenExpired) {
    const refreshed = await refreshAccessToken(userId, account.refreshToken);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      tokenExpired = false;
    } else {
      // Refresh failed — still linked, but can't query vehicles
      return { ...base, vehicleCount: 0, hasVehicles: false, tokenExpired: true };
    }
  }

  // ── Fetch vehicle count from Tesla Fleet API ──
  try {
    const vehicleCount = await fetchUserVehicleCount(accessToken);
    return {
      ...base,
      vehicleCount,
      hasVehicles: vehicleCount > 0,
      tokenExpired: false,
    };
  } catch {
    // Tesla API error — still linked, return 0 vehicles gracefully
    return { ...base, vehicleCount: 0, hasVehicles: false, tokenExpired };
  }
}
