import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AxiosError } from "axios";
import { getUserAccessToken, fetchUserVehicles } from "../services/teslaAccountService.js";
import { getVehicleOrThrow, resolveVehicle, syncVehiclesToDb } from "../services/vehicleService.js";
import { authorizeVehicleAction, getActiveAccessAsGuest } from "../services/shareService.js";
import { createTeslaClient } from "../clients/teslaClient.js";
import { TeslaApi } from "../tesla/teslaApi.js";
import { getCachedTelemetry, refreshTelemetry } from "../services/telemetryService.js";
import { config } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { ok, fail } from "../utils/http.js";

const SENSITIVE_KEYS = new Set(["access_token", "refresh_token", "token", "authorization"]);

function redactBody(data: unknown): unknown {
  if (data == null) return null;
  if (typeof data === "string") return data.slice(0, 200);
  if (typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Build vehicle entries for the vehicles a user can access as a guest via an
 * active temporary share, excluding any ids already returned as owned.
 */
async function sharedVehiclesFor(userId: string, ownedIds: Set<string>) {
  const access = await getActiveAccessAsGuest(userId);
  return access
    .filter((a) => !ownedIds.has(a.vehicleId))
    .map((a) => ({
      id: a.vehicleId,
      teslaVehicleId: a.vehicleId,
      vin: a.vin ?? "",
      friendlyName: a.friendlyName,
      state: null as string | null,
      shared: true,
      accessId: a.id,
      ownerUserId: a.ownerUserId,
      expiresAt: a.expiresAt,
      permissions: a.permissions,
    }));
}

export async function vehiclesRoutes(app: FastifyInstance) {
  // ── GET /vehicles ───────────────────────────────────────
  // Lists the current user's Tesla vehicles using their per-user
  // OAuth access token from TeslaAccount (NOT the old global token).
  app.get("/vehicles", { schema: { tags: ["vehicles"] } }, async (req, reply) => {
    const userId = req.triggeredBy?.trim() ?? "system";

    req.log.info({ triggeredBy: userId }, "GET /vehicles: user identity");

    const tokenResult = await getUserAccessToken(userId);

    req.log.info(
      {
        hasAccount: tokenResult.ok,
        reason: tokenResult.ok ? undefined : tokenResult.reason,
        tokenRefreshed: tokenResult.ok ? tokenResult.refreshed : false,
      },
      "GET /vehicles: Tesla account lookup",
    );

    if (!tokenResult.ok) {
      // Not an owner (no working Tesla token) — return any vehicles shared with
      // this user as a guest. Pure guests reach the dashboard this way.
      const shared = await sharedVehiclesFor(userId, new Set());
      return ok(reply, shared);
    }

    const upstreamPath = "/api/1/vehicles";
    const upstreamBaseUrl = config.teslaBaseUrl;

    try {
      const vehicles = await fetchUserVehicles(tokenResult.accessToken);

      req.log.info(
        { vehicleCount: vehicles.length },
        "GET /vehicles: Tesla API vehicle list",
      );

      // Sync is best-effort — if the DB migration for new Vehicle columns
      // hasn't been applied yet, we still return the Tesla data.
      try {
        const sync = await syncVehiclesToDb(vehicles);
        req.log.info(sync, "GET /vehicles: DB sync result");
      } catch (syncErr) {
        req.log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr) },
          "GET /vehicles: DB sync failed (migration pending?), returning Tesla data without sync",
        );
      }

      const results = vehicles.map((v) => ({
        id: v.id,
        teslaVehicleId: v.id,
        vin: v.vin,
        friendlyName: v.displayName,
        state: v.state,
      }));

      // Append vehicles shared with this user as a guest (e.g. an owner who is
      // also a guest on someone else's vehicle), de-duped against owned ids.
      const ownedIds = new Set(results.map((r) => r.id));
      const shared = await sharedVehiclesFor(userId, ownedIds);

      return ok(reply, [...results, ...shared]);
    } catch (err: unknown) {
      const isAxios = err instanceof AxiosError;
      const status = isAxios ? err.response?.status ?? null : null;
      const body = isAxios ? redactBody(err.response?.data) : null;
      const axiosCode = isAxios ? err.code ?? null : null;
      const errMessage = err instanceof Error ? err.message : String(err);

      // Extract upstream error/message from body
      let teslaError: string | null = null;
      let teslaMessage: string | null = null;
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        teslaError = typeof b["error"] === "string" ? b["error"] : null;
        teslaMessage = typeof b["error_description"] === "string"
          ? b["error_description"]
          : typeof b["message"] === "string" ? b["message"] : null;
      }

      req.log.warn(
        {
          triggeredBy: userId,
          upstreamBaseUrl,
          upstreamPath,
          teslaStatus: status,
          teslaError,
          teslaMessage,
          teslaBody: body,
          axiosCode,
          errMessage,
        },
        "GET /vehicles: Tesla Fleet API call failed",
      );

      const details = { teslaStatus: status, teslaError, teslaMessage, axiosCode, upstreamPath };

      if (status === 401 || status === 403) {
        return fail(reply, new ApiError(401, "tesla_auth_error",
          "Tesla rejected the access token. Please re-link your Tesla account.", details));
      }
      if (status === 412) {
        return fail(reply, new ApiError(409, "tesla_pairing_required",
          "Your vehicle must be paired with this application. "
          + "Open your vehicle's touchscreen, go to Controls > Locks > "
          + "Allow Mobile Access, then tap \"Set Up\" for third-party apps "
          + "and approve this application.", details));
      }
      if (status === 429) {
        reply.header("Retry-After", "60");
        return fail(reply, new ApiError(429, "tesla_rate_limited",
          "Tesla Fleet API rate limit reached. Please try again in a few minutes.", details));
      }
      if (status !== null && status >= 500) {
        reply.header("Retry-After", "30");
        return fail(reply, new ApiError(502, "tesla_upstream_error",
          `Tesla Fleet API returned HTTP ${status}. Please try again later.`, details));
      }

      // Non-HTTP errors: network timeout, DNS failure, connection refused, etc.
      if (status === null) {
        return fail(reply, new ApiError(502, "tesla_upstream_error",
          `Tesla Fleet API unreachable: ${axiosCode ?? errMessage}`, details));
      }

      return fail(reply, new ApiError(502, "tesla_upstream_error",
        `Tesla Fleet API error (HTTP ${status}): ${teslaError ?? teslaMessage ?? "unknown"}`, details));
    }
  });

  // ── GET /vehicles/:id ──────────────────────────────────
  // Single vehicle detail by local DB ID.
  app.get("/vehicles/:id", { schema: { tags: ["vehicles"] } }, async (req, reply) => {
    const userId = req.triggeredBy?.trim() ?? "system";
    const id = z.object({ id: z.string() }).parse(req.params).id;
    const v = await getVehicleOrThrow(id);

    const tokenResult = await getUserAccessToken(userId);
    if (!tokenResult.ok) {
      return ok(reply, { id: v.id, teslaVehicleId: v.teslaVehicleId, vin: v.vin, friendlyName: v.friendlyName, state: null });
    }

    const tesla = new TeslaApi(createTeslaClient(tokenResult.accessToken), null, null, tokenResult.accessToken);
    const cached = await getCachedTelemetry(v.id);
    const state = cached ?? await refreshTelemetry(v.id, v.teslaVehicleId, tesla);
    return ok(reply, { id: v.id, teslaVehicleId: v.teslaVehicleId, vin: v.vin, friendlyName: v.friendlyName, state });
  });

  // ── GET /vehicles/:id/status ────────────────────────────
  // Live vehicle status from Tesla Fleet API using the per-user token.
  app.get("/vehicles/:id/status", { schema: { tags: ["vehicles"] } }, async (req, reply) => {
    const userId = req.triggeredBy?.trim() ?? "system";
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);

    req.log.info({ triggeredBy: userId, routeParamId: id }, "GET /vehicles/:id/status: request");

    // ── Share-aware authorization (owner or active guest) ──
    let auth;
    try {
      auth = await authorizeVehicleAction(userId, id, "status");
    } catch (err) {
      return fail(reply, err);
    }
    const tokenResult = auth.tokenResult;

    req.log.info(
      {
        triggeredBy: userId,
        role: auth.role,
        ownerUserId: auth.ownerUserId,
        accessId: auth.accessId,
        hasAccount: tokenResult.ok,
        reason: tokenResult.ok ? undefined : tokenResult.reason,
        tokenRefreshed: tokenResult.ok ? tokenResult.refreshed : false,
      },
      "GET /vehicles/:id/status: authorization + Tesla account lookup",
    );

    if (!tokenResult.ok) {
      return fail(
        reply,
        new ApiError(
          401,
          "tesla_auth_error",
          tokenResult.reason === "not_linked"
            ? "No Tesla account linked. Please link your Tesla account first."
            : "Tesla token expired and refresh failed. Please re-link your Tesla account.",
        ),
      );
    }

    // ── Vehicle resolution (DB pk → DB teslaVehicleId → raw id fallback) ──
    const vehicle = await resolveVehicle(id);
    const teslaVehicleId = vehicle?.teslaVehicleId ?? id;

    req.log.info(
      {
        routeParamId: id,
        resolvedVia: vehicle ? (vehicle.id === id ? "db_pk" : "db_tesla_id") : "tesla_id_fallback",
        teslaVehicleId,
      },
      "GET /vehicles/:id/status: vehicle resolution",
    );

    // ── Fetch live status from Tesla ──
    const tesla = new TeslaApi(createTeslaClient(tokenResult.accessToken), null, null, tokenResult.accessToken);

    try {
      const state = await tesla.getState(teslaVehicleId);

      req.log.info(
        {
          teslaVehicleId,
          onlineStatus: state.onlineStatus,
          batteryPercent: state.batteryPercent,
          chargingState: state.chargingState,
        },
        "GET /vehicles/:id/status: Tesla upstream result",
      );

      return ok(reply, {
        state: state.onlineStatus.toLowerCase(),
        batteryLevel: state.batteryPercent,
        isLocked: state.lockStatus === "LOCKED" ? true
                : state.lockStatus === "UNLOCKED" ? false
                : null,
        chargingState: state.chargingState,
        rangeKm: state.rangeKm,
        insideTemp: state.insideTemp,
        outsideTemp: state.outsideTemp,
        lastSeenAt: state.lastSeenAt,
        lastLat: state.lastLat,
        lastLng: state.lastLng,
      });
    } catch (err: unknown) {
      const apiErr = err instanceof ApiError ? err : new ApiError(502, "tesla_error", "Failed to fetch vehicle status");

      req.log.warn(
        {
          teslaVehicleId,
          errorReason: apiErr.reason,
          errorMessage: apiErr.message,
          teslaStatus: apiErr.details?.["teslaStatus"] ?? null,
        },
        "GET /vehicles/:id/status: Tesla upstream failed",
      );

      return fail(reply, apiErr);
    }
  });
}
