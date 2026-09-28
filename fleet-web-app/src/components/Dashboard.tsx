"use client";

import Image from "next/image";
import {
  BookOpen,
  Car,
  ChevronRight,
  CircleHelp,
  KeyRound,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  disconnectTesla,
  getReadableErrorMessage,
  getTeslaStatus,
  getTemporaryAccess,
  getVehicles,
  startTeslaOAuth,
  type ShareAccess,
  type TemporaryAccess,
  type TeslaStatus,
  type Vehicle,
} from "@/lib/api";
import { VehicleControlCard } from "./VehicleControlCard";
import { RedeemCodeForm } from "./RedeemCodeForm";
import { ShareCodePanel } from "./ShareCodePanel";
import { syncSelectedFleetVehiclesToSupabase } from "@/lib/fleetAvailability";

type Banner = { kind: "success" | "error"; text: string } | null;
type Page = "overview" | "fleet" | "access" | "book";

type TutorialStep = {
  page: Page;
  eyebrow: string;
  title: string;
  body: string;
};

const SHARED_VEHICLE_IMAGE = "/assets/vehicle_white_thumbnail@2x.png";

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  overview: {
    title: "Overview",
    subtitle: "Your fleet, access and Tesla connection in one place.",
  },
  fleet: {
    title: "Fleet",
    subtitle: "Choose the cars renters can see and manage real vehicle controls.",
  },
  access: {
    title: "Access",
    subtitle: "Create ride-share codes and manage temporary vehicle access.",
  },
  book: {
    title: "Book a ride",
    subtitle: "A simpler renter booking flow is on the way.",
  },
};

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    page: "overview",
    eyebrow: "Welcome to Parlé",
    title: "Everything starts from your fleet",
    body: "This dashboard is live, not a mock. Your Tesla connection, real vehicles, command controls and share access continue to use the existing Parlé backend.",
  },
  {
    page: "fleet",
    eyebrow: "Step 1",
    title: "Connect Tesla",
    body: "Connect or reconnect your Tesla account here. Once linked, Parlé loads the vehicles returned by your Tesla account.",
  },
  {
    page: "fleet",
    eyebrow: "Step 2",
    title: "Choose your public fleet",
    body: "Select the vehicles you want to manage, then save the fleet. Saving publishes that selection for the renter experience without changing Tesla command identifiers.",
  },
  {
    page: "fleet",
    eyebrow: "Step 3",
    title: "Control real vehicles",
    body: "Open a selected vehicle to refresh status, wake, lock, unlock or make it ready. Parlé still sends those actions through the existing backend and Tesla command pipeline.",
  },
  {
    page: "access",
    eyebrow: "Step 4",
    title: "Share temporary access",
    body: "Create a code for an owned vehicle or redeem a code shared with you. Active grants remain time-boxed and permission-aware.",
  },
  {
    page: "book",
    eyebrow: "Coming soon",
    title: "Book a ride",
    body: "The next renter flow will make discovery and booking easier. It is intentionally marked Coming soon here and does not fake a live booking flow.",
  },
];

function fleetStorageKey(userId: string) {
  return "parle.fleet." + userId;
}

function loadFleetSelection(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(fleetStorageKey(userId));
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveFleetSelection(userId: string, ids: Set<string>) {
  try {
    localStorage.setItem(fleetStorageKey(userId), JSON.stringify([...ids]));
  } catch {
    // Local storage is a convenience. The Save fleet action remains the
    // source of truth for renter availability.
  }
}

function SummaryCard({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "rounded-[20px] border p-4 shadow-[0_12px_32px_rgba(29,6,51,0.04)] " +
        (accent
          ? "border-[#e2c7fb] bg-[#fbf7ff]"
          : "border-desat-2 bg-white")
      }
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-desat-7">
        {label}
      </p>
      <p className="mt-2 text-xl font-bold tracking-[-0.04em] text-accent-dark">
        {value}
      </p>
      <p className="mt-1 text-xs text-desat-7">{detail}</p>
    </div>
  );
}

function SharedVehicles({
  userId,
  guestAccess,
}: {
  userId: string;
  guestAccess: TemporaryAccess[];
}) {
  if (guestAccess.length === 0) return null;

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
          Temporary access
        </p>
        <h2 className="mt-1 text-xl font-bold tracking-[-0.03em] text-accent-dark">
          Shared with you
        </h2>
        <p className="mt-1 text-sm text-desat-7">
          Real command access shared by another fleet owner.
        </p>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {guestAccess.map((access) => {
          const vehicle: Vehicle = {
            id: access.vehicleId,
            name: access.friendlyName ?? "Shared Tesla",
            image: SHARED_VEHICLE_IMAGE,
            vin: access.vin ?? "",
            state: "",
          };

          return (
            <VehicleControlCard
              key={access.id}
              userId={userId}
              vehicle={vehicle}
              shared
              permissions={access.permissions}
              expiresAt={access.expiresAt}
            />
          );
        })}
      </div>
    </section>
  );
}

function TutorialOverlay({
  step,
  index,
  total,
  onBack,
  onNext,
  onClose,
}: {
  step: TutorialStep;
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const last = index === total - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#14041d]/35 p-4 backdrop-blur-[2px] sm:items-center">
      <section className="w-full max-w-lg overflow-hidden rounded-[26px] border border-white/30 bg-white shadow-[0_30px_90px_rgba(29,6,51,0.28)]">
        <div className="flex items-start justify-between gap-4 bg-[#1d0633] p-6 text-white">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#c98fff]">
              {step.eyebrow}
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-[-0.04em]">
              {step.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tutorial"
            className="rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6">
          <p className="text-sm leading-6 text-desat-7">{step.body}</p>
          <div className="mt-6 flex items-center gap-1.5">
            {Array.from({ length: total }, (_, dotIndex) => (
              <span
                key={dotIndex}
                className={
                  "h-1.5 rounded-full transition-all " +
                  (dotIndex === index
                    ? "w-8 bg-accent-primary"
                    : "w-3 bg-desat-2")
                }
              />
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onBack}
              disabled={index === 0}
              className="rounded-xl border border-desat-3 px-4 py-2.5 text-sm font-semibold text-accent-dark transition hover:bg-desat-0 disabled:cursor-not-allowed disabled:opacity-35"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onNext}
              className="inline-flex items-center gap-2 rounded-xl bg-accent-primary px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(145,28,255,0.18)]"
            >
              {last ? "Finish" : "Next"}
              {!last && <ChevronRight size={15} />}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function Dashboard() {
  const { user, userId, signOut } = useAuth();

  const [page, setPage] = useState<Page>("overview");
  const [banner, setBanner] = useState<Banner>(null);

  const [status, setStatus] = useState<TeslaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusVersion, setStatusVersion] = useState(0);

  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [vehiclesError, setVehiclesError] = useState<string | null>(null);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [vehiclesVersion, setVehiclesVersion] = useState(0);

  const [fleet, setFleet] = useState<Set<string>>(new Set());
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingFleet, setSavingFleet] = useState(false);

  const [access, setAccess] = useState<ShareAccess | null>(null);
  const [accessVersion, setAccessVersion] = useState(0);

  const [tutorialIndex, setTutorialIndex] = useState<number | null>(null);

  const linked = status?.linked === true;
  const refreshAccess = useCallback(
    () => setAccessVersion((value) => value + 1),
    [],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedParam = params.get("linked");
    if (linkedParam === null) return;

    const reason = params.get("error");
    window.history.replaceState(null, "", window.location.pathname);

    const next: Banner =
      linkedParam === "1"
        ? { kind: "success", text: "Tesla account connected." }
        : {
            kind: "error",
            text: reason
              ? "Tesla connection failed: " + reason.replace(/_/g, " ")
              : "Tesla connection failed. Please try again.",
          };

    const timer = window.setTimeout(() => setBanner(next), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    getTeslaStatus(userId)
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setStatusError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus(null);
        setStatusError(getReadableErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, statusVersion]);

  useEffect(() => {
    if (!userId || !linked) return;
    let cancelled = false;

    getVehicles(userId)
      .then((list) => {
        if (cancelled) return;
        setVehicles(list);
        setVehiclesError(null);
        setFleet(loadFleetSelection(userId));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setVehicles(null);
        setVehiclesError(getReadableErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setVehiclesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, linked, vehiclesVersion]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    getTemporaryAccess(userId)
      .then((nextAccess) => {
        if (!cancelled) setAccess(nextAccess);
      })
      .catch(() => {
        if (!cancelled) setAccess({ asGuest: [], asOwner: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [userId, accessVersion]);

  if (!userId) return null;

  const selectedVehicles =
    vehicles?.filter((vehicle) => fleet.has(vehicle.id)) ?? [];
  const guestAccess = access?.asGuest ?? [];
  const ownerGrants = access?.asOwner ?? [];
  const meta = PAGE_META[page];

  const navItems: {
    id: Page;
    label: string;
    icon: typeof LayoutDashboard;
    comingSoon?: boolean;
  }[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "fleet", label: "Fleet", icon: Car },
    { id: "access", label: "Access", icon: KeyRound },
    { id: "book", label: "Book a ride", icon: BookOpen, comingSoon: true },
  ];

  function retryStatus() {
    setStatusLoading(true);
    setStatusError(null);
    setStatusVersion((value) => value + 1);
  }

  function refreshVehicles() {
    setVehiclesLoading(true);
    setVehiclesError(null);
    setVehiclesVersion((value) => value + 1);
  }

  function toggleFleet(vehicleId: string) {
    setFleet((current) => {
      const next = new Set(current);
      if (next.has(vehicleId)) next.delete(vehicleId);
      else next.add(vehicleId);
      saveFleetSelection(userId, next);
      return next;
    });
  }

  async function saveFleet() {
    if (!vehicles || savingFleet) return;

    setSavingFleet(true);
    try {
      await syncSelectedFleetVehiclesToSupabase({
        ownerUserId: userId,
        allVehicles: vehicles,
        selectedVehicleIds: [...fleet],
      });

      setBanner({
        kind: "success",
        text:
          fleet.size > 0
            ? "Fleet saved. " +
              fleet.size +
              " car" +
              (fleet.size === 1 ? "" : "s") +
              " now visible to renters."
            : "Fleet saved. No cars are listed for renters right now.",
      });
    } catch (error) {
      setBanner({
        kind: "error",
        text: getReadableErrorMessage(error),
      });
    } finally {
      setSavingFleet(false);
    }
  }

  async function handleDisconnect() {
    if (disconnecting) return;
    if (!window.confirm("Disconnect your Tesla account from Parlé?")) return;

    setDisconnecting(true);
    try {
      await disconnectTesla(userId);
      setVehicles(null);
      setFleet(new Set());
      setBanner({ kind: "success", text: "Tesla account disconnected." });
      retryStatus();
    } catch (error) {
      setBanner({
        kind: "error",
        text: getReadableErrorMessage(error),
      });
    } finally {
      setDisconnecting(false);
    }
  }

  function startTutorial() {
    setPage(TUTORIAL_STEPS[0].page);
    setTutorialIndex(0);
  }

  function moveTutorial(direction: 1 | -1) {
    if (tutorialIndex === null) return;

    const nextIndex = tutorialIndex + direction;
    if (nextIndex < 0) return;

    if (nextIndex >= TUTORIAL_STEPS.length) {
      setTutorialIndex(null);
      return;
    }

    setPage(TUTORIAL_STEPS[nextIndex].page);
    setTutorialIndex(nextIndex);
  }

  function renderTeslaConnectionCard(compact = false) {
    return (
      <section className="rounded-[22px] border border-desat-2 bg-white p-5 shadow-[0_14px_38px_rgba(29,6,51,0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative size-11 shrink-0 rounded-2xl bg-desat-1">
              <Image
                src="/assets/Tesla logo@2x.png"
                alt="Tesla"
                fill
                sizes="44px"
                className="object-contain p-2.5"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2
                  className={
                    compact
                      ? "text-sm font-bold text-accent-dark"
                      : "text-base font-bold text-accent-dark"
                  }
                >
                  Tesla account
                </h2>
                {!statusLoading && !statusError && linked && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    Connected
                  </span>
                )}
              </div>

              {statusLoading ? (
                <p className="mt-1 text-sm text-desat-7">
                  Checking connection…
                </p>
              ) : statusError ? (
                <p className="mt-1 max-w-xl text-sm text-red-600">
                  {statusError}
                </p>
              ) : linked ? (
                <p className="mt-1 text-sm text-desat-7">
                  {status?.tokenExpired
                    ? "Your Tesla session expired. Reconnect before sending commands."
                    : String(status?.vehicleCount ?? 0) +
                      " vehicle" +
                      ((status?.vehicleCount ?? 0) === 1 ? "" : "s") +
                      " available from Tesla."}
                </p>
              ) : (
                <p className="mt-1 text-sm text-desat-7">
                  Link Tesla to load and control your real vehicles.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {statusError && (
              <button
                type="button"
                onClick={retryStatus}
                className="rounded-xl border border-desat-3 bg-white px-4 py-2.5 text-sm font-semibold text-accent-dark transition hover:bg-desat-1"
              >
                Retry
              </button>
            )}

            {!statusLoading && !statusError && !linked && (
              <button
                type="button"
                onClick={() => startTeslaOAuth(userId)}
                className="rounded-xl bg-accent-dark px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
              >
                Connect Tesla
              </button>
            )}

            {linked && (
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
                className="rounded-xl border border-desat-3 bg-white px-4 py-2.5 text-sm font-semibold text-accent-dark transition hover:bg-desat-1 disabled:opacity-50"
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderFleetSelector() {
    if (!linked) {
      return (
        <div className="rounded-[22px] border border-dashed border-desat-3 bg-white p-8 text-center">
          <p className="font-semibold text-accent-dark">Connect Tesla first</p>
          <p className="mt-1 text-sm text-desat-7">
            Once linked, your Tesla vehicles will appear here.
          </p>
        </div>
      );
    }

    return (
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold tracking-[-0.03em] text-accent-dark">
              Choose your fleet
            </h2>
            <p className="mt-1 text-sm text-desat-7">
              Selected cars are the vehicles you manage and publish to renters.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshVehicles}
            disabled={vehiclesLoading}
            className="inline-flex items-center gap-2 rounded-xl border border-desat-3 bg-white px-4 py-2.5 text-sm font-semibold text-accent-dark transition hover:bg-desat-1 disabled:opacity-50"
          >
            <RefreshCw
              size={15}
              className={vehiclesLoading ? "animate-spin" : ""}
            />
            Refresh
          </button>
        </div>

        {vehiclesError && (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{vehiclesError}</span>
            <button
              type="button"
              onClick={refreshVehicles}
              className="font-semibold"
            >
              Retry
            </button>
          </div>
        )}

        {vehiclesLoading && vehicles === null && (
          <div className="rounded-[22px] border border-desat-2 bg-white p-10 text-center text-sm text-desat-7">
            Loading your cars…
          </div>
        )}

        {!vehiclesLoading &&
          vehicles !== null &&
          vehicles.length === 0 && (
            <div className="rounded-[22px] border border-dashed border-desat-3 bg-white p-10 text-center">
              <p className="font-semibold text-accent-dark">No cars found</p>
              <p className="mt-1 text-sm text-desat-7">
                Make sure the vehicle appears in the Tesla app, then refresh.
              </p>
            </div>
          )}

        {vehicles !== null && vehicles.length > 0 && (
          <>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {vehicles.map((vehicle) => {
                const inFleet = fleet.has(vehicle.id);

                return (
                  <li key={vehicle.id}>
                    <button
                      type="button"
                      onClick={() => toggleFleet(vehicle.id)}
                      aria-pressed={inFleet}
                      className={
                        "group flex w-full items-center gap-3 rounded-[20px] border bg-white p-4 text-left shadow-[0_10px_30px_rgba(29,6,51,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_14px_36px_rgba(29,6,51,0.07)] " +
                        (inFleet
                          ? "border-accent-primary ring-1 ring-accent-primary/20"
                          : "border-desat-2 hover:border-desat-3")
                      }
                    >
                      <div className="relative h-14 w-20 shrink-0 rounded-xl bg-desat-0">
                        <Image
                          src={vehicle.image}
                          alt={vehicle.name}
                          fill
                          sizes="80px"
                          className="object-contain p-1"
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-accent-dark">
                          {vehicle.name}
                        </p>
                        <p className="mt-1 truncate font-mono text-[10px] text-desat-7">
                          {vehicle.vin || vehicle.state || "Tesla vehicle"}
                        </p>
                      </div>

                      <span
                        className={
                          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition " +
                          (inFleet
                            ? "border-accent-primary bg-accent-primary text-white"
                            : "border-desat-3 text-transparent group-hover:border-accent-light")
                        }
                      >
                        ✓
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-desat-2 bg-white p-4">
              <p className="text-sm text-desat-7">
                {fleet.size === 0
                  ? "No cars selected. Saving will hide your cars from the renter fleet."
                  : String(fleet.size) +
                    " car" +
                    (fleet.size === 1 ? "" : "s") +
                    " selected. Save when you are ready to publish this fleet."}
              </p>
              <button
                type="button"
                onClick={() => void saveFleet()}
                disabled={savingFleet}
                className="rounded-xl bg-accent-primary px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(145,28,255,0.18)] transition hover:opacity-90 disabled:opacity-50"
              >
                {savingFleet ? "Saving…" : "Save fleet"}
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  function renderVehicleControls(heading = "Vehicle controls") {
    if (!linked || selectedVehicles.length === 0) return null;

    return (
      <section className="space-y-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
            Live controls
          </p>
          <h2 className="mt-1 text-xl font-bold tracking-[-0.03em] text-accent-dark">
            {heading}
          </h2>
          <p className="mt-1 text-sm text-desat-7">
            Status and commands below use the existing production Parlé backend.
          </p>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          {selectedVehicles.map((vehicle) => (
            <VehicleControlCard
              key={vehicle.id}
              userId={userId}
              vehicle={vehicle}
              guestAccesses={ownerGrants.filter(
                (grant) => grant.vehicleId === vehicle.id,
              )}
              onAccessChanged={refreshAccess}
            />
          ))}
        </div>
      </section>
    );
  }

  function renderOverviewPage() {
    return (
      <div className="parle-page-enter space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="Tesla"
            value={linked ? "Connected" : "Not linked"}
            detail={
              linked
                ? String(status?.vehicleCount ?? 0) +
                  " vehicle" +
                  ((status?.vehicleCount ?? 0) === 1 ? "" : "s")
                : "Connect to get started"
            }
          />
          <SummaryCard
            label="Fleet"
            value={String(selectedVehicles.length)}
            detail="Selected vehicles"
          />
          <SummaryCard
            label="Temporary access"
            value={String(ownerGrants.length + guestAccess.length)}
            detail={
              String(ownerGrants.length) +
              " shared out · " +
              String(guestAccess.length) +
              " shared with you"
            }
          />
          <SummaryCard
            label="Bookings"
            value="Coming soon"
            detail="Renter discovery and booking"
            accent
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          {renderTeslaConnectionCard(true)}

          <section className="rounded-[22px] border border-desat-2 bg-white p-5 shadow-[0_14px_38px_rgba(29,6,51,0.05)]">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
                  Quick access
                </p>
                <h2 className="mt-1 text-base font-bold text-accent-dark">
                  Have a ride-share code?
                </h2>
              </div>
              <KeyRound size={20} className="text-accent-primary" />
            </div>

            <RedeemCodeForm
              userId={userId}
              onRedeemed={() => {
                setBanner({
                  kind: "success",
                  text: "Ride-share access added.",
                });
                refreshAccess();
              }}
            />
          </section>
        </div>

        {linked && vehicles !== null && vehicles.length > 0 && (
          <section className="rounded-[22px] border border-desat-2 bg-white p-5 shadow-[0_14px_38px_rgba(29,6,51,0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
                  Your fleet
                </p>
                <h2 className="mt-1 text-lg font-bold tracking-[-0.03em] text-accent-dark">
                  {selectedVehicles.length > 0
                    ? String(selectedVehicles.length) + " selected"
                    : "Choose vehicles to manage"}
                </h2>
                <p className="mt-1 text-sm text-desat-7">
                  Use Fleet to update which cars are published to renters.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setPage("fleet")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-desat-3 px-4 py-2.5 text-sm font-semibold text-accent-dark transition hover:bg-desat-1"
              >
                Open fleet
                <ChevronRight size={15} />
              </button>
            </div>
          </section>
        )}

        {renderVehicleControls()}
        <SharedVehicles userId={userId} guestAccess={guestAccess} />
      </div>
    );
  }

  function renderFleetPage() {
    return (
      <div className="parle-page-enter space-y-7">
        {renderTeslaConnectionCard()}
        {renderFleetSelector()}
        {renderVehicleControls("Manage selected vehicles")}
      </div>
    );
  }

  function renderAccessPage() {
    return (
      <div className="parle-page-enter space-y-7">
        <div className="grid gap-5 xl:grid-cols-[0.75fr_1.25fr]">
          <section className="rounded-[22px] border border-desat-2 bg-white p-5 shadow-[0_14px_38px_rgba(29,6,51,0.05)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
              Redeem
            </p>
            <h2 className="mt-1 text-lg font-bold text-accent-dark">
              Enter a ride-share code
            </h2>
            <p className="mb-4 mt-1 text-sm text-desat-7">
              Temporary access is still enforced by the backend.
            </p>

            <RedeemCodeForm
              userId={userId}
              onRedeemed={() => {
                setBanner({
                  kind: "success",
                  text: "Ride-share access added.",
                });
                refreshAccess();
              }}
            />
          </section>

          <section className="rounded-[22px] border border-desat-2 bg-[#1d0633] p-6 text-white shadow-[0_16px_42px_rgba(29,6,51,0.15)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#c98fff]">
                  Secure sharing
                </p>
                <h2 className="mt-2 max-w-lg text-2xl font-bold tracking-[-0.04em]">
                  Give a renter only the access they need.
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-white/65">
                  Codes create time-boxed access. Vehicle commands continue to
                  pass through Parlé authorization before Tesla receives
                  anything.
                </p>
              </div>
              <KeyRound className="shrink-0 text-[#bd77ff]" size={28} />
            </div>
          </section>
        </div>

        {linked && selectedVehicles.length > 0 ? (
          <section className="space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
                Owned vehicles
              </p>
              <h2 className="mt-1 text-xl font-bold tracking-[-0.03em] text-accent-dark">
                Share access
              </h2>
              <p className="mt-1 text-sm text-desat-7">
                Create a code or revoke active guest access for each selected
                vehicle.
              </p>
            </div>

            <div className="grid gap-5 xl:grid-cols-2">
              {selectedVehicles.map((vehicle) => (
                <article
                  key={vehicle.id}
                  className="rounded-[22px] border border-desat-2 bg-white p-5 shadow-[0_14px_38px_rgba(29,6,51,0.05)]"
                >
                  <div className="mb-4 flex items-center gap-3">
                    <div className="relative h-12 w-20 rounded-xl bg-desat-0">
                      <Image
                        src={vehicle.image}
                        alt={vehicle.name}
                        fill
                        sizes="80px"
                        className="object-contain p-1"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-accent-dark">
                        {vehicle.name}
                      </p>
                      <p className="truncate font-mono text-[10px] text-desat-7">
                        {vehicle.vin || "Tesla vehicle"}
                      </p>
                    </div>
                  </div>

                  <ShareCodePanel
                    userId={userId}
                    vehicleId={vehicle.id}
                    guestAccesses={ownerGrants.filter(
                      (grant) => grant.vehicleId === vehicle.id,
                    )}
                    onChanged={refreshAccess}
                  />
                </article>
              ))}
            </div>
          </section>
        ) : (
          <div className="rounded-[22px] border border-dashed border-desat-3 bg-white p-8 text-center">
            <p className="font-semibold text-accent-dark">
              No owned vehicle selected
            </p>
            <p className="mt-1 text-sm text-desat-7">
              Select a vehicle on the Fleet page before creating owner share
              codes.
            </p>
            <button
              type="button"
              onClick={() => setPage("fleet")}
              className="mt-4 rounded-xl bg-accent-dark px-4 py-2.5 text-sm font-semibold text-white"
            >
              Go to Fleet
            </button>
          </div>
        )}

        <SharedVehicles userId={userId} guestAccess={guestAccess} />
      </div>
    );
  }

  function renderBookPage() {
    return (
      <div className="parle-page-enter">
        <section className="overflow-hidden rounded-[28px] border border-desat-2 bg-white shadow-[0_18px_50px_rgba(29,6,51,0.07)]">
          <div className="grid min-h-[520px] lg:grid-cols-[1.05fr_0.95fr]">
            <div className="flex flex-col justify-center p-8 sm:p-12">
              <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full bg-[#f3e7ff] px-3 py-1.5 text-xs font-bold text-accent-primary">
                <Sparkles size={14} />
                Coming soon
              </div>

              <h2 className="max-w-xl text-4xl font-bold tracking-[-0.055em] text-accent-dark sm:text-5xl">
                Find a nearby Parlé vehicle and book the ride.
              </h2>

              <p className="mt-5 max-w-xl text-base leading-7 text-desat-7">
                This section is a roadmap preview only. It does not reserve a
                car, charge a renter or create Tesla access yet.
              </p>

              <div className="mt-7 grid gap-3 sm:grid-cols-3">
                {[
                  "Discover nearby cars",
                  "Book a time window",
                  "Start a ride from the app",
                ].map((item) => (
                  <div
                    key={item}
                    className="rounded-2xl border border-desat-2 bg-desat-0 p-4 text-sm font-semibold text-accent-dark"
                  >
                    {item}
                  </div>
                ))}
              </div>

              <button
                type="button"
                disabled
                className="mt-8 w-fit cursor-not-allowed rounded-xl bg-accent-primary px-5 py-3 text-sm font-semibold text-white opacity-45"
              >
                Book a ride · Coming soon
              </button>
            </div>

            <div className="relative min-h-[360px] overflow-hidden bg-[#1d0633]">
              <div className="absolute -right-20 -top-20 size-72 rounded-full bg-accent-primary/45 blur-3xl" />
              <div className="absolute -bottom-28 -left-14 size-80 rounded-full bg-[#bd77ff]/25 blur-3xl" />
              <div className="relative flex h-full items-center justify-center p-10">
                <div className="w-full max-w-sm rounded-[26px] border border-white/10 bg-white/10 p-5 text-white backdrop-blur">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d8afff]">
                    Planned renter flow
                  </p>
                  <div className="mt-5 space-y-3">
                    {[
                      "Browse available vehicles",
                      "See vehicle details and price",
                      "Reserve a ride",
                      "Receive time-boxed command access",
                    ].map((item, index) => (
                      <div
                        key={item}
                        className="flex items-center gap-3 rounded-2xl bg-white/10 p-3"
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#911cff] text-xs font-bold">
                          {index + 1}
                        </span>
                        <span className="text-sm text-white/80">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f4f7] text-accent-dark">
      <div className="lg:grid lg:min-h-screen lg:grid-cols-[240px_1fr]">
        <aside className="hidden border-r border-desat-2 bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
          <div className="p-6">
            <Image
              src="/assets/Parle_Logo.svg"
              alt="Parlé"
              width={106}
              height={32}
              priority
            />
          </div>

          <div className="px-4">
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-desat-7">
              Workspace
            </p>
            <nav className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = page === item.id;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPage(item.id)}
                    className={
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition " +
                      (active
                        ? "bg-[#f8f1ff] text-accent-primary"
                        : "text-[#6f6677] hover:bg-desat-0 hover:text-accent-dark")
                    }
                  >
                    <Icon size={18} />
                    <span className="flex-1">{item.label}</span>
                    {item.comingSoon && (
                      <span className="rounded-md bg-[#f2e5ff] px-1.5 py-0.5 text-[9px] font-bold uppercase text-accent-primary">
                        Soon
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="mt-6 border-t border-desat-2 px-4 pt-5">
            <button
              type="button"
              onClick={startTutorial}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-[#6f6677] transition hover:bg-desat-0 hover:text-accent-dark"
            >
              <CircleHelp size={18} />
              Tutorial
            </button>
          </div>

          <div className="mt-auto border-t border-desat-2 p-4">
            <div className="rounded-2xl border border-desat-2 bg-desat-0 p-3">
              <p className="truncate text-xs font-bold text-accent-dark">
                {user?.email}
              </p>
              <p className="mt-1 text-[10px] text-desat-7">
                {linked ? "Tesla connected" : "Tesla not connected"}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void signOut()}
              className="mt-2 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-desat-7 transition hover:bg-desat-0 hover:text-accent-dark"
            >
              <LogOut size={16} />
              Log out
            </button>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-30 border-b border-desat-2 bg-white/90 backdrop-blur-xl">
            <div className="flex h-[74px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-accent-dark">
                  {meta.title}
                </h1>
                <p className="hidden truncate text-xs text-desat-7 sm:block">
                  {meta.subtitle}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={startTutorial}
                  className="inline-flex items-center gap-2 rounded-xl border border-desat-3 bg-white px-3.5 py-2 text-sm font-semibold text-accent-dark transition hover:bg-desat-0"
                >
                  <CircleHelp size={16} />
                  <span className="hidden sm:inline">Tutorial</span>
                </button>

                <button
                  type="button"
                  onClick={() => setPage("access")}
                  className="hidden rounded-xl bg-accent-primary px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(145,28,255,0.15)] transition hover:opacity-90 sm:block"
                >
                  Share access
                </button>
              </div>
            </div>

            <div className="flex gap-2 overflow-x-auto border-t border-desat-2 px-4 py-2 lg:hidden">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setPage(item.id)}
                  className={
                    "shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition " +
                    (page === item.id
                      ? "bg-accent-primary text-white"
                      : "bg-desat-0 text-desat-7")
                  }
                >
                  {item.label}
                  {item.comingSoon ? " · Soon" : ""}
                </button>
              ))}
            </div>
          </header>

          <main className="mx-auto w-full max-w-[1420px] p-4 sm:p-6 lg:p-8">
            {banner && (
              <div
                role="status"
                className={
                  "mb-5 flex items-start justify-between gap-4 rounded-2xl border px-4 py-3 text-sm " +
                  (banner.kind === "success"
                    ? "border-emerald-100 bg-emerald-50 text-emerald-800"
                    : "border-red-100 bg-red-50 text-red-700")
                }
              >
                <span>{banner.text}</span>
                <button
                  type="button"
                  onClick={() => setBanner(null)}
                  className="shrink-0 font-semibold"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="mb-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
                Parlé fleet
              </p>
              <h2 className="mt-1 text-3xl font-bold tracking-[-0.055em] text-accent-dark sm:text-4xl">
                {meta.title}
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-desat-7">
                {meta.subtitle}
              </p>
            </div>

            {page === "overview" && renderOverviewPage()}
            {page === "fleet" && renderFleetPage()}
            {page === "access" && renderAccessPage()}
            {page === "book" && renderBookPage()}
          </main>
        </div>
      </div>

      {tutorialIndex !== null && (
        <TutorialOverlay
          step={TUTORIAL_STEPS[tutorialIndex]}
          index={tutorialIndex}
          total={TUTORIAL_STEPS.length}
          onBack={() => moveTutorial(-1)}
          onNext={() => moveTutorial(1)}
          onClose={() => setTutorialIndex(null)}
        />
      )}
    </div>
  );
}
