-- Seller details and tax basis frozen onto each order, so issued invoices never change.
ALTER TABLE "Order" ADD COLUMN "invoiceSnapshot" JSONB;
