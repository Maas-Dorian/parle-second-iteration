import type { FastifyReply } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "./errors.js";

export function ok(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

export function fail(reply: FastifyReply, err: unknown) {
  // Known, expected failures — return the structured envelope the clients parse.
  if (err instanceof ApiError) {
    return reply.code(err.statusCode).send({
      ok: false,
      error: { reason: err.reason, message: err.message, details: err.details ?? null }
    });
  }

  // Request validation (zod) → clean 400 instead of a leaked 500.
  if (err instanceof ZodError) {
    return reply.code(400).send({
      ok: false,
      error: {
        reason: "bad_request",
        message: "Invalid request. Please check the fields and try again.",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }

  // Anything else is unexpected. Log server-side for diagnostics, but never
  // leak internal details (DB hosts, stack traces, tokens) to the caller.
  reply.log.error({ err }, "unhandled error");
  return reply.code(500).send({
    ok: false,
    error: { reason: "unknown", message: "Internal error", details: null }
  });
}
