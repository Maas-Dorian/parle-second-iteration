import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import axios from "axios";
import { prisma } from "../db/prisma.js";
import { getTeslaLinkStatus } from "../services/teslaAccountService.js";
import { ApiError } from "../utils/errors.js";
import { ok } from "../utils/http.js";

function base64url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeVerifier() {
  return base64url(crypto.randomBytes(32));
}

function makeChallenge(verifier: string) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

interface StartQuery {
  userId?: string;
  returnTo?: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

interface TeslaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Where the OAuth flow originated. Mobile is the default/legacy behavior. */
type ReturnTo = "web" | "mobile";

const DEFAULT_APP_DEEP_LINK = "parle://auth/tesla/callback";

/** Normalize an arbitrary query value into a known ReturnTo. */
function parseReturnTo(value: unknown): ReturnTo {
  return value === "web" ? "web" : "mobile";
}

/**
 * Encode the originating platform into the OAuth state so the callback can
 * decide where to redirect. Format: "<returnTo>.<nonce>". The nonce keeps the
 * state unique (and unguessable); the prefix survives the Tesla round-trip.
 */
function encodeState(returnTo: ReturnTo, nonce: string): string {
  return `${returnTo}.${nonce}`;
}

/** Decode the originating platform from a state string. Defaults to mobile. */
function decodeReturnTo(state: string): ReturnTo {
  return state.split(".")[0] === "web" ? "web" : "mobile";
}

/**
 * Build the redirect target for the web fleet app.
 * - Success: WEB_APP_DEEP_LINK, falling back to FRONTEND_URL + "/?linked=1".
 * - Failure: same base but forced to linked=0 (+ optional error param).
 */
function webRedirect(success: boolean, error?: string): string {
  if (success) {
    if (process.env.WEB_APP_DEEP_LINK) return process.env.WEB_APP_DEEP_LINK;
    const frontend = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
    return `${frontend}/?linked=1`;
  }

  const base =
    process.env.WEB_APP_DEEP_LINK ??
    (process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL.replace(/\/+$/, "")}/`
      : null);

  if (base) {
    try {
      const url = new URL(base);
      url.searchParams.set("linked", "0");
      if (error) url.searchParams.set("error", error);
      else url.searchParams.delete("error");
      return url.toString();
    } catch {
      // fall through to relative fallback
    }
  }

  const query = new URLSearchParams({ linked: "0" });
  if (error) query.set("error", error);
  return `/?${query.toString()}`;
}

/**
 * Build the redirect target for the mobile app. Preserves existing behavior:
 * APP_DEEP_LINK (falling back to parle://auth/tesla/callback) + linked flag.
 */
function mobileRedirect(success: boolean, error?: string): string {
  const base = process.env.APP_DEEP_LINK ?? DEFAULT_APP_DEEP_LINK;
  if (success) return `${base}?linked=1`;
  const sep = base.includes("?") ? "&" : "?";
  let url = `${base}${sep}linked=0`;
  if (error) url += `&error=${encodeURIComponent(error)}`;
  return url;
}

/** Resolve the final redirect URL based on where the flow originated. */
function buildRedirect(
  returnTo: ReturnTo,
  success: boolean,
  error?: string,
): string {
  return returnTo === "web"
    ? webRedirect(success, error)
    : mobileRedirect(success, error);
}

export async function teslaAuthRoutes(app: FastifyInstance) {
  app.get<{ Querystring: StartQuery }>("/auth/tesla/start", async (req, reply) => {
    const userId = req.query.userId;

    if (!userId) {
      return reply.code(400).send({ ok: false, error: "missing userId" });
    }

    const returnTo = parseReturnTo(req.query.returnTo);
    const verifier = makeVerifier();
    const challenge = makeChallenge(verifier);
    const state = encodeState(returnTo, crypto.randomBytes(16).toString("hex"));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await prisma.teslaOAuthSession.create({
      data: {
        state,
        verifier,
        userId,
        expiresAt,
      },
    });

    const params = new URLSearchParams({
      client_id: process.env.TESLA_CLIENT_ID!,
      redirect_uri: process.env.TESLA_REDIRECT_URI!,
      response_type: "code",
      scope: process.env.TESLA_SCOPES ?? "openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authUrl = `${process.env.TESLA_AUTH_URL!}?${params.toString()}`;
    return reply.redirect(authUrl);
  });

  app.get<{ Querystring: CallbackQuery }>("/auth/tesla/callback", async (req, reply) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      const returnTo = state ? decodeReturnTo(state) : "mobile";
      return reply.redirect(
        buildRedirect(returnTo, false, error_description ?? error),
      );
    }

    req.log.info(
      {
        hasCode: Boolean(code),
        hasState: Boolean(state),
      },
      "tesla oauth callback query check"
    );

    if (!code || !state) {
      return reply.code(400).send({ ok: false, error: "invalid oauth state" });
    }

    const session = await prisma.teslaOAuthSession.findUnique({
      where: { state },
    });

    req.log.info(
      {
        hasSession: Boolean(session),
        hasVerifier: Boolean(session?.verifier),
        hasUserId: Boolean(session?.userId),
        expired: session ? session.expiresAt.getTime() < Date.now() : null,
      },
      "tesla oauth callback session lookup"
    );

    if (!session) {
      return reply.code(400).send({ ok: false, error: "invalid oauth state" });
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await prisma.teslaOAuthSession.delete({ where: { state } });
      return reply.code(400).send({ ok: false, error: "oauth session expired" });
    }

    try {
      const tokenRes = await axios.post(
        process.env.TESLA_TOKEN_URL!,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.TESLA_CLIENT_ID!,
          client_secret: process.env.TESLA_CLIENT_SECRET!,
          redirect_uri: process.env.TESLA_REDIRECT_URI!,
          code,
          code_verifier: session.verifier,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, refresh_token, expires_in } =
        tokenRes.data as TeslaTokenResponse;

      const expiresAt = new Date(Date.now() + Number(expires_in) * 1000);

      await prisma.teslaAccount.upsert({
        where: { userId: session.userId },
        update: {
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt,
        },
        create: {
          userId: session.userId,
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt,
        },
      });

      await prisma.teslaOAuthSession.delete({
        where: { state },
      });

      const returnTo = decodeReturnTo(state);
      return reply.redirect(buildRedirect(returnTo, true));
    } catch (err) {
      req.log.error(err, "Tesla token exchange failed");
      const returnTo = decodeReturnTo(state);
      return reply.redirect(
        buildRedirect(returnTo, false, "token_exchange_failed"),
      );
    }
  });

  // ── Status: is the current user's Tesla account linked? ──
  // Protected route — requires x-parle-api-key + x-triggered-by:<userId>
  app.get(
    "/auth/tesla/status",
    { schema: { tags: ["tesla-auth"] } },
    async (req, reply) => {
      const userId = req.triggeredBy?.trim();

      if (!userId || userId === "system") {
        throw new ApiError(
          400,
          "bad_request",
          "x-triggered-by header must contain the user ID",
        );
      }

      const status = await getTeslaLinkStatus(userId);
      return ok(reply, status);
    },
  );

  // ── Disconnect: remove stored Tesla tokens for a user ──
  // Protected route — requires x-parle-api-key + x-triggered-by:<userId>
  app.post(
    "/auth/tesla/disconnect",
    { schema: { tags: ["tesla-auth"] } },
    async (req, reply) => {
      const userId = req.triggeredBy?.trim();

      if (!userId || userId === "system") {
        throw new ApiError(
          400,
          "bad_request",
          "x-triggered-by header must contain the user ID",
        );
      }

      await prisma.teslaAccount.deleteMany({ where: { userId } });
      await prisma.teslaOAuthSession.deleteMany({ where: { userId } });

      return ok(reply, { disconnected: true });
    },
  );
}
