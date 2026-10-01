-- Renter "public claim" access grants (POST /vehicles/:id/claim) create a
-- TemporaryVehicleAccess row that is NOT tied to a share code. Allow
-- shareCodeId to be null so those grants can be stored. Existing share-code
-- redemptions continue to set shareCodeId.
ALTER TABLE "TemporaryVehicleAccess" ALTER COLUMN "shareCodeId" DROP NOT NULL;

-- Speed up the "is there an active grant for this vehicle?" lookup used by the
-- concurrency-safe claim path and by End Ride.
CREATE INDEX IF NOT EXISTS "TemporaryVehicleAccess_vehicleId_revokedAt_idx"
  ON "TemporaryVehicleAccess" ("vehicleId", "revokedAt");
