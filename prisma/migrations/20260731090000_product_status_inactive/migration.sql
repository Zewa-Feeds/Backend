-- Add INACTIVE to ProductStatus: temporarily off sale, but not retired.
--
-- Postgres cannot add an enum value inside a transaction that also uses it, and
-- Prisma wraps migrations in one — hence the explicit COMMIT. Ordered after
-- COMING_SOON so the enum reads in lifecycle order rather than append order.
ALTER TYPE "ProductStatus" ADD VALUE IF NOT EXISTS 'INACTIVE' AFTER 'COMING_SOON';
