-- ============================================================================
-- Drop CustomerPhoneOtp — Zewa has no SMS provider.
--
-- The table was added speculatively to satisfy ZSOP004's "verified mobile"
-- language. There is no SMS provider and none is being built, so an empty table
-- modelling a flow that cannot run is worse than no table: it implies a control
-- exists when it does not.
--
-- Guest claiming (§3.4) is gated on the customer's VERIFIED EMAIL instead, which
-- is the identifier guest orders are actually keyed by in this codebase
-- (`Order.email`). The three requirements that name OTP for reasons email cannot
-- satisfy — §12.1 large-redemption re-verification, §13.3 backfill release,
-- §8.4 #29 migrated customers — are recorded as blockers in
-- src/modules/loyalty/README.md rather than approximated with a weaker control.
--
-- `Customer.phoneVerifiedAt` is KEPT. It is unused today, but it is the switch
-- those gates turn on the day an SMS provider exists, and adding it later would
-- mean a migration against live balances.
-- ============================================================================

-- DropForeignKey
ALTER TABLE "CustomerPhoneOtp" DROP CONSTRAINT "CustomerPhoneOtp_customerId_fkey";

-- DropTable
DROP TABLE "CustomerPhoneOtp";

