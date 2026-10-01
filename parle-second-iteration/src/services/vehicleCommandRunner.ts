import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { resolveVehicle, markVcpRequired } from "./vehicleService.js";
import { createTeslaClient, createTeslaProxyClient } from "../clients/teslaClient.js";
import { TeslaApi, type CommandMode } from "../tesla/teslaApi.js";
import { getUserAccessToken } from "./teslaAccountService.js";
import { authorizeVehicleAction } from "./shareService.js";
import { runCommand, type CommandName } from "./commandService.js";
import { ApiError } from "../utils/errors.js";

/**
 * Shared vehicle-command execution used by the HTTP command routes AND by the
 * server-side End Ride flow (which locks the car before releasing it). Keeping a
 * single implementation guarantees renters, guests, and owners all go through
 * the exact same authorization, token, wake, VCP proxy auto-detect, and
 * auth-refresh retry behavior.
 *
 * Throws ApiError on failure; returns the normalized command outcome on success.
 * Never logs tokens or secrets.
 */

export type CommandOutcome = {
  replay?: boolean;
  result: string;
  teslaStatus?: number | null;
  vehicleId: string;
  command: CommandName;
  requestId: string;
  role: "owner" | "guest";
  vcpAutoDetected?: boolean;
  authRefreshed?: boolean;
};

export async function runVehicleCommandForUser(params: {
  /** Identity issuing the command (owner or guest/renter user id). */
  triggeredBy: string;
  /** The `:id` route param (source_vehicle_id / DB id / Tesla id). */
  vehicleParamId: string;
  command: CommandName;
  requestId?: string;
  log: FastifyBaseLogger;
}): Promise<CommandOutcome> {
  const { triggeredBy, vehicleParamId: id, command, log } = params;
  const requestId = params.requestId ?? randomUUID();

  log.info({ triggeredBy, command }, "runVehicleCommand: user identity");

  // ── Share-aware authorization (owner or active guest) ──
  // Owners use their own Tesla token; authorized guests run with the owner's
  // token. Throws 403 when the caller isn't allowed or lacks the permission.
  const auth = await authorizeVehicleAction(triggeredBy, id, command);
  const tokenUserId = auth.tokenUserId;
  const tokenResult = auth.tokenResult;

  log.info(
    {
      triggeredBy,
      role: auth.role,
      ownerUserId: auth.ownerUserId,
      accessId: auth.accessId,
      tokenUserId,
      hasAccount: tokenResult.ok,
      reason: tokenResult.ok ? undefined : tokenResult.reason,
      tokenRefreshed: tokenResult.ok ? tokenResult.refreshed : false,
      tokenExpiresAt: tokenResult.ok ? tokenResult.expiresAt.toISOString() : null,
      authFlow: auth.role === "guest" ? "guest_via_owner" : "per_user",
    },
    "runVehicleCommand: authorization + Tesla account lookup",
  );

  if (!tokenResult.ok) {
    throw new ApiError(
      401,
      "tesla_auth_error",
      tokenResult.reason === "not_linked"
        ? "No Tesla account linked. Please link your Tesla account first."
        : "Tesla token expired and refresh failed. Please re-link your Tesla account.",
    );
  }

  // ── Vehicle resolution ──
  const vehicle = await resolveVehicle(id);
  const vehicleId = vehicle?.id ?? undefined;
  const teslaVehicleId = vehicle?.teslaVehicleId ?? id;
  const vin = vehicle?.vin ?? null;

  // ── Build TeslaApi with both clients ──
  let currentAccessToken = tokenResult.accessToken;
  const fleetClient = createTeslaClient(currentAccessToken);
  const proxyClient = createTeslaProxyClient(currentAccessToken);
  const tesla = new TeslaApi(fleetClient, proxyClient, vin, currentAccessToken);

  // ── Per-vehicle command mode selection ──
  const vcpFlag = vehicle?.vcpRequired ?? null;
  let chosenMode: CommandMode;
  if (vcpFlag === true && tesla.proxyConfigured) {
    chosenMode = "command_protocol_proxy";
  } else {
    chosenMode = "direct_fleet_rest";
  }
  tesla.commandMode = chosenMode;

  log.info(
    {
      routeParamId: id,
      command,
      resolvedVia: vehicle ? (vehicle.id === id ? "db_pk" : "db_tesla_id") : "tesla_id_fallback",
      vehicleId: vehicleId ?? null,
      teslaVehicleId,
      vin,
      vcpRequired: vcpFlag,
      commandMode: chosenMode,
      proxyConfigured: tesla.proxyConfigured,
      lastCapabilityCheckedAt: vehicle?.lastCapabilityCheckedAt?.toISOString() ?? null,
    },
    "runVehicleCommand: vehicle + command routing",
  );

  const runParams = { vehicleId, teslaVehicleId, command, requestId, triggeredBy, tesla };

  // Re-fetch the user's Tesla token and update both Axios clients when it has
  // been refreshed since we last captured it.
  const refreshTokenForRetry = async (reason: string): Promise<boolean> => {
    const fresh = await getUserAccessToken(tokenUserId);
    if (!fresh.ok) {
      log.warn(
        { triggeredBy, tokenUserId, reason: fresh.reason, retryReason: reason },
        "runVehicleCommand: token re-fetch failed before retry",
      );
      return false;
    }
    if (fresh.accessToken !== currentAccessToken) {
      currentAccessToken = fresh.accessToken;
      tesla.refreshAuthHeader(currentAccessToken);
      log.info(
        { triggeredBy, tokenRefreshed: true, commandMode: tesla.commandMode, retryReason: reason },
        "runVehicleCommand: refreshed auth header before retry",
      );
    }
    return true;
  };

  try {
    const res = await runCommand(runParams);
    return {
      ...res,
      vehicleId: vehicleId ?? teslaVehicleId,
      command,
      requestId,
      role: auth.role,
    };
  } catch (e: unknown) {
    const err = e instanceof ApiError ? e : new ApiError(502, "unknown", "Command failed");

    // ── VCP auto-detection: direct REST failed → retry via proxy ──
    if (
      err.reason === "vcp_required" &&
      chosenMode === "direct_fleet_rest" &&
      tesla.proxyConfigured &&
      vin
    ) {
      log.info(
        { vehicleId: vehicleId ?? null, teslaVehicleId, vin, command,
          previousMode: "direct_fleet_rest", retryMode: "command_protocol_proxy" },
        "runVehicleCommand: VCP required — auto-switching to command_protocol_proxy",
      );

      if (vehicleId) {
        await markVcpRequired(vehicleId).catch((dbErr) =>
          log.warn({ vehicleId, err: String(dbErr) }, "runVehicleCommand: failed to persist vcpRequired flag"),
        );
      }

      tesla.commandMode = "command_protocol_proxy";
      await refreshTokenForRetry("vcp_proxy_switch");

      try {
        const retryRes = await runCommand(runParams);
        return {
          ...retryRes,
          vehicleId: vehicleId ?? teslaVehicleId,
          command,
          requestId,
          role: auth.role,
          vcpAutoDetected: true,
        };
      } catch (retryE: unknown) {
        const retryErr = retryE instanceof ApiError ? retryE : new ApiError(502, "unknown", "Command failed");
        log.warn(
          { triggeredBy, command, teslaVehicleId, vin, via: "command_protocol_proxy",
            errorReason: retryErr.reason, errorMessage: retryErr.message,
            teslaStatus: retryErr.details?.["teslaStatus"] ?? null, retryAfterVcpDetect: true },
          "runVehicleCommand: command failed after VCP retry",
        );
        throw retryErr;
      }
    }

    // ── Auth failure in proxy mode → refresh token + one retry ──
    if (
      err.reason === "auth_expired_or_invalid" &&
      tesla.commandMode === "command_protocol_proxy"
    ) {
      log.info(
        { triggeredBy, command, teslaVehicleId, vin, commandMode: tesla.commandMode,
          teslaStatus: err.details?.["teslaStatus"] ?? null },
        "runVehicleCommand: auth failed in proxy mode, attempting token refresh + retry",
      );

      const tokenOk = await refreshTokenForRetry("proxy_auth_401");
      if (tokenOk) {
        try {
          const retryRes = await runCommand(runParams);
          return {
            ...retryRes,
            vehicleId: vehicleId ?? teslaVehicleId,
            command,
            requestId,
            role: auth.role,
            authRefreshed: true,
          };
        } catch (retryE: unknown) {
          const retryErr = retryE instanceof ApiError ? retryE : new ApiError(502, "unknown", "Command failed");
          log.warn(
            { triggeredBy, command, teslaVehicleId, vin, via: tesla.commandMode,
              errorReason: retryErr.reason, errorMessage: retryErr.message,
              teslaStatus: retryErr.details?.["teslaStatus"] ?? null, retryAfterAuthRefresh: true },
            "runVehicleCommand: command still failed after auth refresh retry",
          );
          throw retryErr;
        }
      }
    }

    log.warn(
      { triggeredBy, command, teslaVehicleId, vin,
        via: err.details?.["via"] ?? chosenMode,
        errorReason: err.reason, errorMessage: err.message,
        teslaStatus: err.details?.["teslaStatus"] ?? null,
        commandMode: tesla.commandMode,
        origin: err.details?.["teslaStatus"] != null ? "tesla_upstream" : "pre_tesla" },
      "runVehicleCommand: command failed",
    );

    throw err;
  }
}
