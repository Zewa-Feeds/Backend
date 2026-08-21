-- Upload tickets: the ledger of every signature minted.
--
-- The browser uploads straight to Cloudinary, so between minting a signature and
-- the CMS saving the product an asset can exist in the account that no database
-- row references — the tab was closed, the network dropped, the save failed.
-- Nothing knew those assets existed, so nothing could clean them up and they
-- billed indefinitely.
--
-- A row is written BEFORE the browser is told where to upload, and the public_id
-- is generated server-side, so we always know exactly what may appear.
--
-- Purely additive: no existing table or column is touched, and the existing 171
-- assets are unaffected.

CREATE TYPE "UploadTicketStatus" AS ENUM ('SIGNED', 'UPLOADED', 'ATTACHED', 'FAILED', 'DISCARDED');

CREATE TABLE "UploadTicket" (
  "id"             TEXT NOT NULL,
  "publicId"       TEXT NOT NULL,
  "resourceType"   TEXT NOT NULL,
  "folder"         TEXT NOT NULL,
  "familyId"       TEXT,
  "status"         "UploadTicketStatus" NOT NULL DEFAULT 'SIGNED',
  "uploadedAt"     TIMESTAMP(3),
  "attachedAt"     TIMESTAMP(3),
  "failureReason"  TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "requestedById"  TEXT,

  CONSTRAINT "UploadTicket_pkey" PRIMARY KEY ("id")
);

-- One ticket per public_id. This is what makes webhook handling idempotent:
-- a duplicate notification updates the same row rather than inserting another.
CREATE UNIQUE INDEX "UploadTicket_publicId_key" ON "UploadTicket"("publicId");
CREATE INDEX "UploadTicket_status_createdAt_idx" ON "UploadTicket"("status", "createdAt");
CREATE INDEX "UploadTicket_familyId_idx" ON "UploadTicket"("familyId");

-- SetNull on both: deleting a product or an operator must not delete the record
-- of an asset that still exists in Cloudinary and still needs cleaning up.
ALTER TABLE "UploadTicket" ADD CONSTRAINT "UploadTicket_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UploadTicket" ADD CONSTRAINT "UploadTicket_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "CmsUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
