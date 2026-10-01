"use client";

/**
 * Root route — the whole app lives here so there is nothing to 404 on.
 * Shows the auth screen until the user signs in, then the dashboard.
 * The backend's Tesla OAuth web redirect also lands here (/?linked=1|0).
 */

import { useAuth } from "@/lib/auth";
import { AuthScreen } from "@/components/AuthScreen";
import { Dashboard } from "@/components/Dashboard";

export default function Home() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <main className="flex flex-1 items-center justify-center bg-desat-0">
        <p className="text-sm text-desat-7">Loading…</p>
      </main>
    );
  }

  return isAuthenticated ? <Dashboard /> : <AuthScreen />;
}
