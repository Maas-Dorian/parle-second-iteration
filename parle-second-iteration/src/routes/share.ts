import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../utils/errors.js";
import { ok } from "../utils/http.js";
import {
  getOrCreateActiveCode,
  regenerateCode,
  redeemCode,
  getActiveAccessAsGuest,
  getActiveAccessAsOwner,
  revokeAccess,
} from "../services/shareService.js";

/** Pull the Supabase user id from the identity header, rejecting "system". */
function requireUserId(req: FastifyRequest): string {
  const userId = req.triggeredBy?.trim();
  if (!userId || userId === "system") {
    throw new ApiError(
      400,
      "bad_request",
      "x-triggered-by header must contain the user ID",
    );
  }
  return userId;
}

export async function shareRoutes(app: FastifyInstance) {
  // ── GET /share/code?vehicleId= ──────────────────────────
  // Owner only. Returns (or creates) the active 24h code for the vehicle.
  app.get<{ Querystring: { vehicleId?: string } }>(
    "/share/code",
    { schema: { tags: ["share"] } },
    async (req, reply) => {
      const userId = requireUserId(req);
      const vehicleId = z
        .object({ vehicleId: z.string().min(1) })
        .parse(req.query).vehicleId;

      const code = await getOrCreateActiveCode(userId, vehicleId);
      return ok(reply, code);
    },
  );

  // ── POST /share/code/regenerate ─────────────────────────
  // Owner only. Deactivates the old code and mints a fresh one.
  app.post<{ Body: { vehicleId?: string } }>(
    "/share/code/regenerate",
    { schema: { tags: ["share"] } },
    async (req, reply) => {
      const userId = requireUserId(req);
      const vehicleId = z
        .object({ vehicleId: z.string().min(1) })
        .parse(req.body ?? {}).vehicleId;

      const code = await regenerateCode(userId, vehicleId);
      return ok(reply, code);
    },
  );

  // ── POST /share/redeem ──────────────────────────────────
  // Guest. Redeems a code into a time-boxed access record.
  //
  // Accepts the web app + mobile body shapes:
  //   { code: "ZV8-7RH" } | { shareCode: "ZV8-7RH" }
  // durationMinutes is optional (mobile may omit it) and defaults to 1 hour.
  // Bad input returns a clean 400 — never a generic 500.
  app.post<{
    Body: { code?: string; shareCode?: string; durationMinutes?: number };
  }>("/share/redeem", { schema: { tags: ["share"] } }, async (req, reply) => {
    const userId = requireUserId(req);

    const body = (req.body ?? {}) as {
      code?: unknown;
      shareCode?: unknown;
      durationMinutes?: unknown;
    };

    const rawCode =
      typeof body.code === "string"
        ? body.code
        : typeof body.shareCode === "string"
          ? body.shareCode
          : "";
    const codeInput = rawCode.trim();

    // Safe diagnostics only — never the raw code value, tokens, or API keys.
    const codeCleanLength = codeInput.toUpperCase().replace(/[^A-Z0-9]/g, "").length;
    const codeFormatValid = codeCleanLength === 6;
    req.log.info(
      { guestUserIdPresent: Boolean(userId), codeFormatValid },
      "share: redeem requested",
    );

    if (!codeInput) {
      throw new ApiError(400, "bad_request", "A ride-share code is required.");
    }
    if (!codeFormatValid) {
      throw new ApiError(
        400,
        "bad_request",
        "Ride-share codes look like ZV8-7RH (6 letters/numbers).",
      );
    }

    // durationMinutes is optional; default to 1 hour when absent/blank.
    let durationMinutes = 60;
    if (body.durationMinutes !== undefined && body.durationMinutes !== null) {
      const parsed = Number(body.durationMinutes);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ApiError(
          400,
          "bad_request",
          "durationMinutes must be a positive whole number.",
        );
      }
      durationMinutes = parsed;
    }

    try {
      const access = await redeemCode(userId, codeInput, durationMinutes);
      req.log.info(
        {
          guestUserId: userId,
          ownerUserId: access.ownerUserId,
          vehicleId: access.vehicleId,
          accessId: access.id,
          codeFound: true,
          expired: false,
        },
        "share: code redeemed",
      );
      return ok(reply, access);
    } catch (err) {
      if (err instanceof ApiError) {
        // 404 → not found, 410 → expired/inactive. No secrets logged.
        req.log.info(
          {
            guestUserIdPresent: true,
            statusCode: err.statusCode,
            reason: err.reason,
            codeFound: err.statusCode !== 404,
            expired: err.statusCode === 410,
          },
          "share: redeem rejected",
        );
      }
      throw err;
    }
  });

  // ── GET /share/access ───────────────────────────────────
  // Active access records for the current user, split by role.
  app.get("/share/access", { schema: { tags: ["share"] } }, async (req, reply) => {
    const userId = requireUserId(req);
    const [asGuest, asOwner] = await Promise.all([
      getActiveAccessAsGuest(userId),
      getActiveAccessAsOwner(userId),
    ]);
    return ok(reply, { asGuest, asOwner });
  });

  // ── POST /share/revoke ──────────────────────────────────
  // Owner only. Revokes a guest's access by id.
  app.post<{ Body: { accessId?: string } }>(
    "/share/revoke",
    { schema: { tags: ["share"] } },
    async (req, reply) => {
      const userId = requireUserId(req);
      const accessId = z
        .object({ accessId: z.string().min(1) })
        .parse(req.body ?? {}).accessId;

      await revokeAccess(userId, accessId);
      req.log.info({ ownerUserId: userId, accessId }, "share: access revoked");
      return ok(reply, { revoked: true });
    },
  );
}
