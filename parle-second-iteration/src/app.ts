import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cookie from "@fastify/cookie";

import { config } from "./config/env.js";
import { authPlugin } from "./middleware/auth.js";
import { vehiclesRoutes } from "./routes/vehicles.js";
import { commandsRoutes } from "./routes/commands.js";
import { rentalRoutes } from "./routes/rentals.js";
import { logsRoutes } from "./routes/logs.js";
import { teslaAuthRoutes } from "./routes/teslaAuth.js";
import { shareRoutes } from "./routes/share.js";

import { fail, ok } from "./utils/http.js";
import { checkProxyService } from "./utils/proxyDiagnostic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    trustProxy: config.nodeEnv !== "development",
    logger: {
      level: config.logLevel,
      transport:
        config.nodeEnv === "development"
          ? { target: "pino-pretty" }
          : undefined,
    },
  });

  // Cookies (must be before routes that use setCookie)
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET ?? "dev_cookie_secret_change_me",
  });

  // Security + CORS
  await app.register(helmet);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => String(req.headers["x-forwarded-for"] ?? req.ip),
  });

  // Static files — serves public/ at site root (Tesla Fleet public key, etc.)
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
    decorateReply: false, // avoid conflict with swagger-ui's own static plugin
    list: false,          // no directory listing
  });

  // Swagger
  await app.register(swagger, {
    openapi: {
      info: { title: "Parle Tesla Control Service", version: "0.1.0" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Service-to-service auth (x-parle-api-key)
  await app.register(authPlugin);

  // Central error handler — MUST be set before routes are registered so the
  // encapsulated route contexts inherit it (otherwise thrown ApiError/ZodError
  // fall through to Fastify's default handler, which 500s and leaks internals).
  app.setErrorHandler((err, _req, reply) => fail(reply, err));

  // Health (public in dev, protected in production — handled by authPlugin)
  app.get("/healthz", async (_req, reply) => ok(reply, { ok: true }));

  // ── Debug route (development only) ──────────────────────
  if (config.nodeEnv === "development") {
    app.get("/debug/env", async (_req, reply) => {
      return ok(reply, {
        NODE_ENV: config.nodeEnv,
        PORT: config.port,
        LOG_LEVEL: config.logLevel,
        PARLE_API_KEY_set: typeof config.parleApiKey === "string" && config.parleApiKey.length > 0,
        PARLE_API_KEY_length: config.parleApiKey?.length ?? 0,
        DATABASE_URL_set: typeof config.databaseUrl === "string" && config.databaseUrl.length > 0,
        TESLA_BASE_URL: config.teslaBaseUrl,
        TESLA_BEARER_TOKEN_set: typeof config.teslaBearerToken === "string" && config.teslaBearerToken.length > 0,
        REDIS_URL_set: typeof config.redisUrl === "string" && config.redisUrl.length > 0,
      });
    });
  }

  // Startup diagnostic: Tesla integration config
  const proxyUrl = config.teslaCommandProxyUrl;
  app.log.info(
    {
      teslaBaseUrl: config.teslaBaseUrl,
      teslaCommandProxyUrl: proxyUrl ?? "(not configured — VCP vehicles will fail until set)",
      proxyConfigured: !!proxyUrl,
      configuredScopes: process.env.TESLA_SCOPES ?? "(using default)",
      oauthClientConfigured: !!process.env.TESLA_CLIENT_ID,
      privateKeyPath: "private-key.pem (used by the Tesla Vehicle Command proxy, not by this API)",
    },
    "Tesla integration config",
  );

  // Routes
  await app.register(teslaAuthRoutes);
  await app.register(vehiclesRoutes);
  await app.register(commandsRoutes);
  await app.register(rentalRoutes);
  await app.register(logsRoutes);
  await app.register(shareRoutes);

  // ── On-demand proxy diagnostic ──
  // Always available (protected by authPlugin's x-parle-api-key requirement).
  if (proxyUrl) {
    app.get("/debug/proxy-check", { schema: { tags: ["debug"] } }, async (_req, reply) => {
      const result = await checkProxyService(proxyUrl);
      return ok(reply, result);
    });
  }

  // ── Non-blocking startup probe ──
  // After the app is fully ready, check whether the proxy URL actually points
  // at the official Tesla Vehicle Command proxy or at our own Fastify API.
  if (proxyUrl) {
    app.addHook("onReady", () => {
      checkProxyService(proxyUrl)
        .then((result) => {
          if (result.isFastifyApi) {
            app.log.error(
              {
                proxyUrl: result.proxyUrl,
                healthzStatus: result.healthzStatus,
                rootStatus: result.rootStatus,
                serverHeader: result.serverHeader,
                verdict: result.verdict,
              },
              "CRITICAL: TESLA_COMMAND_PROXY_URL points at the Parle Fastify API, NOT the Tesla Vehicle Command proxy. " +
              "Every proxy-mode command will fail with 401. You must deploy the official tesla-http-proxy " +
              "(github.com/teslamotors/vehicle-command) on a separate origin with the private key configured.",
            );
          } else if (!result.reachable) {
            app.log.warn(
              { proxyUrl: result.proxyUrl, error: result.error, verdict: result.verdict },
              "Proxy startup check: proxy URL is unreachable",
            );
          } else {
            app.log.info(
              {
                proxyUrl: result.proxyUrl,
                healthzStatus: result.healthzStatus,
                rootStatus: result.rootStatus,
                serverHeader: result.serverHeader,
                verdict: result.verdict,
              },
              "Proxy startup check: passed",
            );
          }
        })
        .catch((err) => {
          app.log.warn(
            { proxyUrl, error: err instanceof Error ? err.message : String(err) },
            "Proxy startup check: diagnostic failed (non-blocking)",
          );
        });
    });
  }

  return app;
}
