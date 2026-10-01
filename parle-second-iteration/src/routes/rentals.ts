import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ok, fail } from "../utils/http.js";
import { extractBearerToken, verifySupabaseAccessToken } from "../services/supabaseAuth.js";
import { claimPublicVehicle, endRide } from "../services/rentalService.js";

const ParamsSchema = z.object({ id: z.string().min(1) });
const ClaimBodySchema = z.object({
  durationMinutes: z.number().int().positive().optional(),
});

/**
 * Public-vehicle renter routes:
 *   • POST /vehicles/:id/claim     → claim a public fleet vehicle (Start Ride)
 *   • POST /vehicles/:id/end-ride  → lock + release the vehicle (End Ride)
 *
 * `:id` is the `source_vehicle_id`. Both routes require the x-parle-api-key
 * (enforced globally by authPlugin) AND a valid Supabase Bearer token; the
 * renter's identity is derived from the VERIFIED token, never from a header.
 */
export async function rentalRoutes(app: FastifyInstance) {
  // ── POST /vehicles/:id/claim ────────────────────────────
  app.post<{ Params: { id: string }; Body: { durationMinutes?: number } }>(
    "/vehicles/:id/claim",
    { schema: { tags: ["rentals"] } },
    async (req, reply) => {
      try {
        const { id } = ParamsSchema.parse(req.params);
        const body = ClaimBodySchema.parse(req.body ?? {});

        const { userId } = await verifySupabaseAccessToken(
          extractBearerToken(req.headers.authorization),
        );

        // Safe diagnostic if the client-sent header disagrees with the verified
        // token — we always trust the verified token.
        const headerUser = req.triggeredBy?.trim();
        if (headerUser && headerUser !== "system" && headerUser !== userId) {
          req.log.warn(
            { headerMatchesToken: false },
            "[rental] x-triggered-by differs from verified token; using verified identity",
          );
        }

        const grant = await claimPublicVehicle({
          renterUserId: userId,
          vehicleParamId: id,
          durationMinutes: body.durationMinutes ?? null,
          log: req.log,
        });

        return ok(reply, grant);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // ── POST /vehicles/:id/end-ride ─────────────────────────
  app.post<{ Params: { id: string } }>(
    "/vehicles/:id/end-ride",
    { schema: { tags: ["rentals"] } },
    async (req, reply) => {
      try {
        const { id } = ParamsSchema.parse(req.params);

        const { userId } = await verifySupabaseAccessToken(
          extractBearerToken(req.headers.authorization),
        );

        const result = await endRide({
          renterUserId: userId,
          vehicleParamId: id,
          log: req.log,
        });

        return ok(reply, result);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
