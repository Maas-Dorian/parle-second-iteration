# Parle Fleet Web App

Next.js web app for fleet owners: create an account (Supabase email/password),
connect a Tesla through the Parle backend OAuth flow, and manage the cars in
your fleet. Mirrors the Rork mobile app flow.

The whole app lives on the root route `/` — auth screen when signed out,
dashboard when signed in. The backend's Tesla OAuth web redirect also lands on
`/` with `?linked=1` (success) or `?linked=0&error=...` (failure).

## Architecture

- **Auth:** Supabase email/password (`src/lib/supabase.ts`, `src/lib/auth.tsx`).
  Sessions persist across refreshes via supabase-js localStorage.
- **Backend API:** all calls go to `NEXT_PUBLIC_API_BASE_URL` (`src/lib/api.ts`)
  with headers:
  - `x-parle-api-key: NEXT_PUBLIC_PARLE_API_KEY` (frontend-safe external key)
  - `x-triggered-by: <supabase user id>`
- **Tesla OAuth:** "Connect Tesla" does a full-page redirect to
  `${NEXT_PUBLIC_API_BASE_URL}/auth/tesla/start?userId=<id>&returnTo=web`.
  The backend handles the entire OAuth handshake and redirects back here.
- No Tesla secrets and no Supabase service-role key in this app — only public
  `NEXT_PUBLIC_*` values.

## Local development

1. Create `.env.local` in this folder:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.parlekeys.com
NEXT_PUBLIC_PARLE_API_KEY=<external api key>
NEXT_PUBLIC_SUPABASE_URL=<supabase project url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase anon key>
```

2. Install and run:

```bash
npm install
npm run dev
```

Open http://localhost:3000.

> To return to localhost after Tesla OAuth, the backend's
> `WEB_APP_DEEP_LINK` env must point at `http://localhost:3000/?linked=1`.

## Deploy on Vercel

- Set the project **Root Directory** to `fleet-web-app`.
- Add the same four `NEXT_PUBLIC_*` env vars in Project Settings → Environment
  Variables.
- The backend's `WEB_APP_DEEP_LINK` should be the production URL, e.g.
  `https://parle-fleet-platform.vercel.app/?linked=1`.

## Scripts

```bash
npm run dev     # local dev server
npm run build   # production build (type-checks)
npm run lint    # eslint
```
