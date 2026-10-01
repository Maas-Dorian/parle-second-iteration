import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the public-vehicle claim / end-ride flow. Prisma and the
 * shared command runner are mocked so we can assert the concurrency guard,
 * ownership rejection, availability rejection, and End Ride lock→revoke→release
 * behavior without a database or Tesla.
 */

const txMock = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  temporaryVehicleAccess: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
};

const prismaMock = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  temporaryVehicleAccess: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../src/db/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/db/prisma.ts", () => ({ prisma: prismaMock }));

const runnerMock = { runVehicleCommandForUser: vi.fn() };
vi.mock("../src/services/vehicleCommandRunner.js", () => runnerMock);
vi.mock("../src/services/vehicleCommandRunner.ts", () => runnerMock);

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const fleetRow = {
  id: "row1",
  owner_user_id: "owner1",
  source_vehicle_id: "veh1",
  vin: "VIN123",
  display_name: "Owner Tesla",
  model: "Model 3",
  color: "White",
  battery_level: 80,
  range_miles: 200,
  is_locked: true,
  is_available: true,
};

// Dynamic import (no resetModules) keeps a single module graph, so the
// ApiError class thrown by the mocked runner matches the one rentalService uses.
async function importService() {
  return import("../src/services/rentalService.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Interactive transaction runs the callback with our tx mock.
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) =>
    cb(txMock),
  );
});

describe("claimPublicVehicle", () => {
  it("creates a time-boxed grant and flips availability on success", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...fleetRow }]);
    txMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce(null);
    txMock.$executeRaw.mockResolvedValueOnce(1); // CAS flip succeeded
    const now = new Date();
    txMock.temporaryVehicleAccess.create.mockResolvedValueOnce({
      id: "acc1",
      ownerUserId: "owner1",
      guestUserId: "renter1",
      vin: "VIN123",
      startsAt: now,
      expiresAt: new Date(now.getTime() + 120 * 60_000),
    });

    const { claimPublicVehicle } = await importService();
    const grant = await claimPublicVehicle({
      renterUserId: "renter1",
      vehicleParamId: "veh1",
      log,
    });

    expect(grant.accessId).toBe("acc1");
    expect(grant.vehicleId).toBe("veh1");
    expect(grant.ownerUserId).toBe("owner1");
    expect(grant.permissions).toMatchObject({ lock: true, unlock: true, ready: true, status: true });
    expect(grant.alreadyActive).toBe(false);
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(txMock.temporaryVehicleAccess.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an owner claiming their own vehicle (403)", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...fleetRow, owner_user_id: "renter1" }]);
    const { claimPublicVehicle } = await importService();
    await expect(
      claimPublicVehicle({ renterUserId: "renter1", vehicleParamId: "veh1", log }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(txMock.temporaryVehicleAccess.create).not.toHaveBeenCalled();
  });

  it("rejects an unavailable vehicle (409)", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...fleetRow, is_available: false }]);
    txMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce(null);
    const { claimPublicVehicle } = await importService();
    await expect(
      claimPublicVehicle({ renterUserId: "renter1", vehicleParamId: "veh1", log }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(txMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects when another renter already holds active access (409)", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...fleetRow }]);
    txMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce({
      id: "accX",
      guestUserId: "other",
    });
    const { claimPublicVehicle } = await importService();
    await expect(
      claimPublicVehicle({ renterUserId: "renter1", vehicleParamId: "veh1", log }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(txMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("is idempotent when the same renter re-claims their active grant", async () => {
    const now = new Date();
    txMock.$queryRaw.mockResolvedValueOnce([{ ...fleetRow }]);
    txMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce({
      id: "acc1",
      ownerUserId: "owner1",
      guestUserId: "renter1",
      vin: "VIN123",
      startsAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const { claimPublicVehicle } = await importService();
    const grant = await claimPublicVehicle({
      renterUserId: "renter1",
      vehicleParamId: "veh1",
      log,
    });
    expect(grant.alreadyActive).toBe(true);
    expect(txMock.$executeRaw).not.toHaveBeenCalled();
    expect(txMock.temporaryVehicleAccess.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the concurrency compare-and-set loses the race", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...fleetRow }]);
    txMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce(null);
    txMock.$executeRaw.mockResolvedValueOnce(0); // another claimer won the race
    const { claimPublicVehicle } = await importService();
    await expect(
      claimPublicVehicle({ renterUserId: "renter1", vehicleParamId: "veh1", log }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(txMock.temporaryVehicleAccess.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the vehicle isn't in the fleet", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([]);
    const { claimPublicVehicle } = await importService();
    await expect(
      claimPublicVehicle({ renterUserId: "renter1", vehicleParamId: "nope", log }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("endRide", () => {
  it("locks, revokes, and releases the vehicle back to the fleet", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ source_vehicle_id: "veh1", id: "row1" }]);
    prismaMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce({
      id: "acc1",
      shareCodeId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    runnerMock.runVehicleCommandForUser.mockResolvedValueOnce({ result: "SUCCESS" });
    txMock.temporaryVehicleAccess.update.mockResolvedValueOnce({});
    txMock.$executeRaw.mockResolvedValueOnce(1); // released

    const { endRide } = await importService();
    const res = await endRide({ renterUserId: "renter1", vehicleParamId: "veh1", log });

    expect(res.locked).toBe(true);
    expect(res.released).toBe(true);
    expect(res.alreadyEnded).toBe(false);
    expect(runnerMock.runVehicleCommandForUser).toHaveBeenCalledWith(
      expect.objectContaining({ command: "lock", triggeredBy: "renter1" }),
    );
  });

  it("is an idempotent no-op when there is no active access", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ source_vehicle_id: "veh1", id: "row1" }]);
    prismaMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce(null);

    const { endRide } = await importService();
    const res = await endRide({ renterUserId: "renter1", vehicleParamId: "veh1", log });

    expect(res.alreadyEnded).toBe(true);
    expect(res.released).toBe(false);
    expect(runnerMock.runVehicleCommandForUser).not.toHaveBeenCalled();
  });

  it("does not revoke access or release when locking fails", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ source_vehicle_id: "veh1", id: "row1" }]);
    prismaMock.temporaryVehicleAccess.findFirst.mockResolvedValueOnce({
      id: "acc1",
      shareCodeId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { ApiError } = await import("../src/utils/errors.js");
    runnerMock.runVehicleCommandForUser.mockRejectedValueOnce(
      new ApiError(409, "asleep_timeout", "asleep"),
    );

    const { endRide } = await importService();
    await expect(
      endRide({ renterUserId: "renter1", vehicleParamId: "veh1", log }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(txMock.temporaryVehicleAccess.update).not.toHaveBeenCalled();
  });
});
