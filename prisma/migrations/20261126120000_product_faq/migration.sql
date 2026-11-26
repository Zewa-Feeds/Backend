-- Product FAQs: an ordered list of { "q": ..., "a": ... } per product family.
-- Defaults to an empty list, so existing products are unaffected until FAQs are added.
ALTER TABLE "ProductFamily" ADD COLUMN "faq" JSONB NOT NULL DEFAULT '[]';
