-- CreateTable
CREATE TABLE "VehicleShareCode" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "vin" TEXT,
    "friendlyName" TEXT,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleShareCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemporaryVehicleAccess" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "guestUserId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "vin" TEXT,
    "friendlyName" TEXT,
    "shareCodeId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TemporaryVehicleAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleShareCode_ownerUserId_idx" ON "VehicleShareCode"("ownerUserId");

-- CreateIndex
CREATE INDEX "VehicleShareCode_vehicleId_idx" ON "VehicleShareCode"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleShareCode_code_idx" ON "VehicleShareCode"("code");

-- CreateIndex
CREATE INDEX "TemporaryVehicleAccess_guestUserId_idx" ON "TemporaryVehicleAccess"("guestUserId");

-- CreateIndex
CREATE INDEX "TemporaryVehicleAccess_ownerUserId_idx" ON "TemporaryVehicleAccess"("ownerUserId");

-- CreateIndex
CREATE INDEX "TemporaryVehicleAccess_vehicleId_idx" ON "TemporaryVehicleAccess"("vehicleId");
