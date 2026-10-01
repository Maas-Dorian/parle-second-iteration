"use client";

/**
 * Email/password auth screen with Sign in / Create account tabs.
 * Mirrors the Rork app's entry flow: authenticate first, connect Tesla after.
 */

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";

type Tab = "signin" | "signup";

export function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [tab, setTab] = useState<Tab>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchTab(next: Tab) {
    setTab(next);
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result =
        tab === "signin"
          ? await signIn(email.trim(), password)
          : await signUp(email.trim(), password);
      if (!result.ok) {
        // Sign-up with email confirmation returns an informational message.
        if (result.error.startsWith("Account created")) setNotice(result.error);
        else setError(result.error);
      }
      // On success the auth provider re-renders the page into the dashboard.
    } finally {
      setBusy(false);
    }
  }

  const tabClass = (active: boolean) =>
    `flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors ${
      active
        ? "bg-white text-accent-dark shadow-sm"
        : "text-desat-7 hover:text-accent-dark"
    }`;

  return (
    <main className="flex flex-1 items-center justify-center bg-desat-0 px-4 py-12">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <Image
            src="/assets/Parle_Logo.svg"
            alt="Parle"
            width={120}
            height={36}
            priority
          />
          <p className="text-center text-sm text-desat-7">
            Connect your Tesla and manage your fleet on the Parle network.
          </p>
        </div>

        <div className="rounded-2xl border border-desat-2 bg-white p-6 shadow-[0_13px_21px_rgba(211,164,255,0.06),0_6px_10px_rgba(211,164,255,0.05)]">
          {/* Tabs */}
          <div className="mb-6 flex gap-1 rounded-xl bg-desat-1 p-1">
            <button
              type="button"
              className={tabClass(tab === "signin")}
              onClick={() => switchTab("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={tabClass(tab === "signup")}
              onClick={() => switchTab("signup")}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-accent-dark">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="rounded-xl border border-desat-3 px-4 py-3 text-base text-accent-dark outline-none transition-colors placeholder:text-desat-4 focus:border-accent-primary"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-accent-dark">
                Password
              </span>
              <input
                type="password"
                required
                minLength={6}
                autoComplete={tab === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tab === "signup" ? "At least 6 characters" : "Your password"}
                className="rounded-xl border border-desat-3 px-4 py-3 text-base text-accent-dark outline-none transition-colors placeholder:text-desat-4 focus:border-accent-primary"
              />
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {error}
              </p>
            )}
            {notice && (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="mt-1 rounded-xl bg-accent-dark py-3.5 text-base font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy
                ? "Please wait…"
                : tab === "signin"
                ? "Sign in"
                : "Create account"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-desat-7">
          By continuing, you agree to Parle&apos;s Terms of Service and Privacy
          Policy.
        </p>
      </div>
    </main>
  );
}
