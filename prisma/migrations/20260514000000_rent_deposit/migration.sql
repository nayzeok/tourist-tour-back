-- AlterTable
ALTER TABLE "RentBooking"
  ADD COLUMN "depositAmount" DOUBLE PRECISION,
  ADD COLUMN "depositStatus" TEXT,
  ADD COLUMN "paykeeperPaymentId" TEXT;
