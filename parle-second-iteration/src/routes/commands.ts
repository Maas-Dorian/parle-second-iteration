import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runVehicleCommandForUser } from "../services/vehicleCommandRunner.js";
import type { CommandName } from "../services/commandService.js";
import { ok, fail } from "../utils/http.js";

const ParamsSchema = z.object({ id: z.string().min(1) });
const BodySchema = z.object({ requestId: z.string().min(8).optional() });

type CmdParams = { id: string };
type CmdBody = { requestId?: string };

async function handleCommand(
  req: FastifyRequest<{ Params: CmdParams; Body: CmdBody }>,
  reply: FastifyReply,
  command: CommandName,
) {
  const { id } = ParamsSchema.parse(req.params);
  const body = BodySchema.parse(req.body ?? {});

  const triggeredBy = req.triggeredBy?.trim() ?? "system";
  const requestId = body.requestId ?? req.requestId ?? randomUUID();

  try {
    // All authorization (owner or active guest/renter), token handling, wake,
    // VCP proxy auto-detect and auth-refresh retry live in the shared runner so
    // the HTTP routes and the server-side End Ride lock behave identically.
    const outcome = await runVehicleCommandForUser({
      triggeredBy,
      vehicleParamId: id,
      command,
      requestId,
      log: req.log,
    });
    return ok(reply, outcome);
  } catch (e) {
    return fail(reply, e);
  }
}

export async function commandsRoutes(app: FastifyInstance) {
  app.post("/vehicles/:id/wake", { schema: { tags: ["commands"] } }, (req, reply) =>
    handleCommand(req as FastifyRequest<{ Params: CmdParams; Body: CmdBody }>, reply, "wake")
  );

  app.post("/vehicles/:id/unlock", { schema: { tags: ["commands"] } }, (req, reply) =>
    handleCommand(req as FastifyRequest<{ Params: CmdParams; Body: CmdBody }>, reply, "unlock")
  );

  app.post("/vehicles/:id/enable-drive", { schema: { tags: ["commands"] } }, (req, reply) =>
    handleCommand(req as FastifyRequest<{ Params: CmdParams; Body: CmdBody }>, reply, "enable-drive")
  );

  app.post("/vehicles/:id/lock", { schema: { tags: ["commands"] } }, (req, reply) =>
    handleCommand(req as FastifyRequest<{ Params: CmdParams; Body: CmdBody }>, reply, "lock")
  );

  app.post("/vehicles/:id/ready", { schema: { tags: ["commands"] } }, (req, reply) =>
    handleCommand(req as FastifyRequest<{ Params: CmdParams; Body: CmdBody }>, reply, "ready-vehicle")
  );
}
