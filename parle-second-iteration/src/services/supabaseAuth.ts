import axios, { AxiosError } from "axios";
import { config } from "../config/env.js";
import { ApiError } from "../utils/errors.js";

/**
 * Verify a Supabase user access token (a JWT issued by Supabase Auth) and return
 * the authenticated user's id. Used by the public-vehicle claim / end-ride flow
 * so the renter's identity is derived from a VERIFIED token — never from a
 * client-supplied header (`x-triggered-by`) alone.
 *
 * We verify by calling Supabase Auth's `GET /auth/v1/user` with the caller's
 * bearer token plus the project anon key. This reuses `axios` (already a
 * dependency) and Supabase's own validation — no new package and no service-role
 * key are introduced. The returned `id` is the same `auth.uid()` the fleet web
 * app stores as `owner_user_id` and the mobile app sends as `x-triggered-by`.
 *
 * Never logs tokens.
 */

export interface SupabaseUser {
  userId: string;
  email: string | null;
}

interface SupabaseUserResponse {
  id?: string;
  email?: string | null;
}

/** Pull a raw bearer token out of an Authorization header value. */
export function extractBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Verify the given bearer token against Supabase Auth and return the user.
 * Throws ApiError(401) for a missing/invalid/expired token, ApiError(500) when
 * the server isn't configured for Supabase verification, and ApiError(502) when
 * Supabase Auth is unreachable.
 */
export async function verifySupabaseAccessToken(
  token: string | null,
): Promise<SupabaseUser> {
  if (!token) {
    throw new ApiError(
      401,
      "auth_error",
      "Sign in required. Missing Supabase access token.",
    );
  }

  const supabaseUrl = config.supabaseUrl;
  const anonKey = config.supabaseAnonKey;
  if (!supabaseUrl || !anonKey) {
    // Misconfiguration, not the caller's fault — surface a clear 500 so ops can
    // set SUPABASE_URL / SUPABASE_ANON_KEY and redeploy.
    throw new ApiError(
      500,
      "server_misconfigured",
      "Renter authentication is not configured on the server.",
    );
  }

  try {
    const res = await axios.get<SupabaseUserResponse>(
      `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anonKey,
        },
        timeout: config.httpTimeoutMs,
      },
    );

    const userId = res.data?.id?.trim();
    if (!userId) {
      throw new ApiError(
        401,
        "auth_error",
        "Your session is invalid. Please sign in again.",
      );
    }

    return { userId, email: res.data?.email ?? null };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const status = err instanceof AxiosError ? err.response?.status ?? null : null;
    if (status === 401 || status === 403) {
      throw new ApiError(
        401,
        "auth_error",
        "Your session has expired. Please sign out and sign back in.",
      );
    }
    throw new ApiError(
      502,
      "auth_upstream_error",
      "Couldn’t verify your session right now. Please try again.",
    );
  }
}
