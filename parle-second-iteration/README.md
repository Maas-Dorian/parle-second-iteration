# Parle Tesla Control Service (Supabase / No-Docker) — Second Iteration

This repo is **Tussa's Tesla abstraction layer**.
- Supabase OAuth login happens in **Char3's Marketplace API**
- This service is protected with **service-to-service auth**: `x-parle-api-key`
- This repo uses **Supabase Postgres** (hosted) so you **do not need Docker**.

What this service does:
- Normalized **telemetry**: list vehicles, get vehicle state (cached in-memory).
- Reliable **commands**: wake-first, unlock, enable-drive, lock, etc.
- **Idempotency**: safe for double-taps/retries via `requestId`.
- **Audit logs**: every command is recorded for debugging/ops.
- **Scale-ready**: stateless API design; add Redis later in production if desired.

---

## 1) One-time dependencies to install (on your computer)

### Required
- **Node.js 20+** (includes npm)

### Optional but helpful
- Git
- Postman (or just use curl)

---

## 2) Create a Supabase project (required)

1. Create a project in Supabase.
2. Go to **Project Settings → Database → Connection string**
3. Copy the **Postgres connection string**.
   - If you later see DB connection limit errors, use the **Session pooler** connection string.

---

## 3) Project dependencies (install inside the repo)

From the repo folder:

```bash
npm install
```

---

## 4) Run locally (no Docker)

### Step A — create env file
```powershell
Copy-Item .env.example .env
```

### Step B — edit `.env`
Set:
- `DATABASE_URL` to your Supabase Postgres connection string
- `PARLE_API_KEY` to a strong shared secret (you will share this with Char3 backend)

#### API keys: internal vs external

The backend accepts the `x-parle-api-key` header matching **either** of two keys:

- `PARLE_API_KEY` — existing/internal clients (e.g. Char3 backend). **Behavior unchanged.**
- `PARLE_EXTERNAL_API_KEY` — frontend/mobile external clients (e.g. the Vercel
  fleet web app and the Rork mobile app, which sends it as `EXPO_PUBLIC_PARLE_API_KEY`).

```bash
# Existing/internal shared secret (required)
PARLE_API_KEY=dev_key_change_me

# External frontend/mobile key (optional). When set, the backend accepts it in
# the same x-parle-api-key header. Leaving it unset preserves single-key behavior.
PARLE_EXTERNAL_API_KEY=<64-char-external-key>
```

A request is authorized if `x-parle-api-key` matches **either** key. Invalid or
missing keys still return `401` with the existing error shape. Key values are
never logged (only presence/length and which source matched).

> If a frontend/mobile client gets `401 Invalid x-parle-api-key`, confirm
> `PARLE_EXTERNAL_API_KEY` is set in the **deployed** environment (staging/prod)
> and exactly matches the value the client sends.

### Step C — run migrations + seed
```bash
npx prisma migrate deploy
npm run db:seed
```

### Step D — start Tesla mock (for local testing)
Open a **second** PowerShell window in the repo folder and run:
```powershell
$env:PORT=9090
node .\src\tesla-mock\server.js
```

### Step E — start the API
Back in the first PowerShell window:
```bash
npm run dev
```

Swagger UI: http://localhost:8080/docs  (no API key needed in dev)
Health check: http://localhost:8080/healthz  (no API key needed in dev)

---

## 5) How to test

### A) Run tests
```bash
npm test
```

### B) Testing /healthz

In **development** (`NODE_ENV=development`, the default), `/healthz` and `/docs` do **not** require an API key.
In **production**, every route including `/healthz` requires `x-parle-api-key`.

#### curl.exe (PowerShell — use curl.exe, not the curl alias)
```powershell
# Health check — no API key needed in dev
curl.exe http://localhost:8080/healthz

# With API key (always works)
curl.exe -H "x-parle-api-key: dev_key_change_me" http://localhost:8080/healthz
```

#### Invoke-WebRequest (native PowerShell)
```powershell
# Health check — no API key needed in dev
Invoke-WebRequest -Uri http://localhost:8080/healthz | Select-Object -ExpandProperty Content

# With API key
Invoke-WebRequest -Uri http://localhost:8080/healthz -Headers @{ "x-parle-api-key" = "dev_key_change_me" } | Select-Object -ExpandProperty Content
```

### C) Manual API tests (copy/paste)

All **vehicle / command / log** endpoints require the API key in every environment:
- `x-parle-api-key: <matches your .env PARLE_API_KEY>`

#### 1) List vehicles
```powershell
curl.exe -H "x-parle-api-key: dev_key_change_me" http://localhost:8080/vehicles
```

#### 2) Get a vehicle + state
```powershell
curl.exe -H "x-parle-api-key: dev_key_change_me" http://localhost:8080/vehicles/derby-01
```

#### 3) Unlock (wake-first)
```powershell
curl.exe -X POST -H "x-parle-api-key: dev_key_change_me" http://localhost:8080/vehicles/derby-01/unlock
```

#### 4) Enable drive (wake-first)
```powershell
curl.exe -X POST -H "x-parle-api-key: dev_key_change_me" http://localhost:8080/vehicles/derby-01/enable-drive
```

#### 5) Ready shortcut (wake -> unlock -> enable-drive)
```powershell
curl.exe -X POST -H "x-parle-api-key: dev_key_change_me" http://localhost:8080/vehicles/derby-01/ready
```

#### 6) View command logs
```powershell
curl.exe -H "x-parle-api-key: dev_key_change_me" "http://localhost:8080/logs/commands?limit=20"
```

#### 7) Disconnect Tesla account
```bash
curl -X POST \
  -H "x-parle-api-key: dev_key_change_me" \
  -H "x-triggered-by: <supabase_user_id>" \
  http://localhost:8080/auth/tesla/disconnect
# Expected: {"ok":true,"data":{"disconnected":true}}
```

---

## 6) How Char3 should call this service

Required headers:
- `x-parle-api-key: <shared_secret>` — internal clients send `PARLE_API_KEY`; external frontend/mobile clients send `PARLE_EXTERNAL_API_KEY` (both are accepted)
- `x-triggered-by: <supabase_user_id | system | admin>` (for audit logs)
- `x-request-id: <uuid>` (recommended; idempotency + tracing)

---

## 7) Tesla Fleet Public Key Hosting

Tesla requires your domain to serve a public key at a well-known URL so it can verify your app.

**Final URL Tesla uses:**
```
https://api.parlekeys.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

**Where the file lives in this repo:**
```
public/.well-known/appspecific/com.tesla.3p.public-key.pem
```

**To replace the placeholder with your real key:**
1. Generate your key pair (if not already done):
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```
2. Paste the contents of `public-key.pem` into:
   `public/.well-known/appspecific/com.tesla.3p.public-key.pem`

**Test locally (no API key needed — this path is public in all environments):**
```powershell
npm run dev
curl.exe http://localhost:8080/.well-known/appspecific/com.tesla.3p.public-key.pem
# Expected: HTTP 200 with PEM content, no auth header required
```

**Smoke test in a browser:**
Open this URL directly — it must return 200 and show the PEM text with no login/headers:
- Local: `http://localhost:8080/.well-known/appspecific/com.tesla.3p.public-key.pem`
- Production: `https://api.parlekeys.com/.well-known/appspecific/com.tesla.3p.public-key.pem`

---

## Tesla OAuth redirect (mobile + web)

After Tesla OAuth completes, the backend redirects the browser back to either
the mobile app or the Vercel fleet web app. Which one is used is decided by the
`returnTo` value carried through the OAuth `state`:

- **Mobile (default):** `GET /auth/tesla/start?userId=<id>` → redirects to `APP_DEEP_LINK`.
- **Web:** `GET /auth/tesla/start?userId=<id>&returnTo=web` → redirects to `WEB_APP_DEEP_LINK`
  (falling back to `FRONTEND_URL` + `/?linked=1`).

Success returns with `linked=1`; failure returns with `linked=0` and an optional `error` param.

Relevant env vars:

```bash
# Mobile deep link (existing behavior — do not remove)
APP_DEEP_LINK=parle://auth/tesla/callback

# Web fleet app (Vercel) success redirect
WEB_APP_DEEP_LINK=https://parle-fleet-platform.vercel.app/?linked=1

# Local web fleet app success redirect (use as WEB_APP_DEEP_LINK when developing)
LOCAL_WEB_APP_DEEP_LINK=http://localhost:3000/?linked=1
```

> If `WEB_APP_DEEP_LINK` is unset, the backend falls back to `FRONTEND_URL` + `/?linked=1`.

---

## Notes
- This version uses **in-memory caching** for telemetry. That's fine for local dev.
- For production scale, add Redis later so multiple instances share cache.



## Optional: Redis (for production scale)

If you set `REDIS_URL`, this service will use Redis for shared telemetry cache across multiple instances.



## Quick load test (sanity check)

Install (dev dependency already included):
```powershell
npm i
```

Run:
```powershell
npx autocannon -c 50 -d 20 -H "x-parle-api-key=dev_key_change_me" http://localhost:8080/healthz
```
