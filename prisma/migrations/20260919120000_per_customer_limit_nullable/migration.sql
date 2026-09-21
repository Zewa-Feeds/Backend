-- "Per-customer limit" now means unlimited when blank, matching the
-- "Total usage limit" field beside it in the CMS. The two sat side by side and
-- behaved oppositely: blanking the total meant unlimited, while blanking the
-- per-customer one silently coerced to 1.
--
-- Existing rows keep their value, so no coupon changes behaviour on deploy.
-- Only a coupon explicitly cleared in the CMS becomes unlimited.
ALTER TABLE "Coupon" ALTER COLUMN "perCustomerLimit" DROP NOT NULL;
