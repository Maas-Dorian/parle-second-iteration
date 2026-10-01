"use client";

/**
 * Supabase email/password auth for the fleet web app.
 *
 * Wrap the app in <AuthProvider> (done in app/layout.tsx) and read auth state
 * anywhere with `useAuth()`. Sessions persist across refreshes automatically —
 * supabase-js stores them in localStorage and this provider re-hydrates on
 * mount via getSession() + onAuthStateChange().
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, SUPABASE_NOT_CONFIGURED_MESSAGE } from "./supabase";

export type AuthResult = { ok: true } | { ok: false; error: string };

type AuthContextValue = {
  user: User | null;
  userId: string | null;
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Only loading when there is a Supabase client to hydrate a session from.
  const [isLoading, setIsLoading] = useState(() => supabase !== null);

  useEffect(() => {
    if (!supabase) return;

    // Re-hydrate any persisted session, then stay in sync with auth events
    // (sign in, sign out, token refresh).
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setIsLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string): Promise<AuthResult> {
    if (!supabase) return { ok: false, error: SUPABASE_NOT_CONFIGURED_MESSAGE };
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  async function signUp(email: string, password: string): Promise<AuthResult> {
    if (!supabase) return { ok: false, error: SUPABASE_NOT_CONFIGURED_MESSAGE };
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    // When email confirmation is enabled, no session is returned yet.
    if (!data.session) {
      return {
        ok: false,
        error:
          "Account created. Check your email to confirm your address, then sign in.",
      };
    }
    return { ok: true };
  }

  async function signOut(): Promise<void> {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  const user = session?.user ?? null;

  return (
    <AuthContext.Provider
      value={{
        user,
        userId: user?.id ?? null,
        session,
        isLoading,
        isAuthenticated: user !== null,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
