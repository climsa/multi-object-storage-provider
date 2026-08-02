ALTER TABLE "UsageCounter"
    ADD CONSTRAINT "UsageCounter_egressBytes_nonnegative_check"
    CHECK ("egressBytes" >= 0);
