import "dotenv/config";
import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

const Env = z.object({
  PORT: z.string().default("8080"),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  PARLE_API_KEY: isProduction
    ? z.string().min(8)
    : z.string().default("dev_key_change_me"),
  // Optional second API key for the Vercel fleet web app. When set, the
  // backend accepts either PARLE_API_KEY or PARLE_EXTERNAL_API_KEY in the
  // x-parle-api-key header. Leaving it unset preserves single-key behavior.
  PARLE_EXTERNAL_API_KEY: z.string().min(8).optional(),
  DATABASE_URL: z.string().min(10),
  REDIS_URL: z.string().url().optional(),
  CACHE_TTL_SECONDS: z.string().default("10"),
  TESLA_BASE_URL: z.string().url(),
  TESLA_COMMAND_PROXY_URL: z.string().url().optional(),
  TESLA_BEARER_TOKEN: z.string().min(1).optional(),
  WAKE_TIMEOUT_SECONDS: z.string().default("25"),
  WAKE_POLL_INTERVAL_MS: z.string().default("1500"),
  COMMAND_RETRY_COUNT: z.string().default("1"),
  HTTP_TIMEOUT_MS: z.string().default("8000"),
  // Supabase — used to VERIFY a renter's Bearer token on the public-vehicle
  // claim / end-ride routes (identity is derived from the verified token, never
  // from client-supplied headers alone). Optional so existing deployments keep
  // booting; the claim route returns a clear misconfig error if unset.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
});

const env = Env.parse(process.env);

export const config = {
  port: Number(env.PORT),
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  parleApiKey: env.PARLE_API_KEY,
  parleExternalApiKey: env.PARLE_EXTERNAL_API_KEY,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS),
  teslaBaseUrl: env.TESLA_BASE_URL,
  teslaCommandProxyUrl: env.TESLA_COMMAND_PROXY_URL,
  teslaBearerToken: env.TESLA_BEARER_TOKEN,
  wakeTimeoutSeconds: Number(env.WAKE_TIMEOUT_SECONDS),
  wakePollIntervalMs: Number(env.WAKE_POLL_INTERVAL_MS),
  commandRetryCount: Number(env.COMMAND_RETRY_COUNT),
  httpTimeoutMs: Number(env.HTTP_TIMEOUT_MS),
  supabaseUrl: env.SUPABASE_URL,
  supabaseAnonKey: env.SUPABASE_ANON_KEY,
};
