-- Link refresh-token rotation families to the access-token session identifier.
-- Existing rows remain NULL and therefore cannot authorize new session checks;
-- users with pre-migration tokens must sign in again.
ALTER TABLE "RefreshToken" ADD COLUMN "sessionId" UUID;

CREATE INDEX "RefreshToken_userId_sessionId_revokedAt_idx"
ON "RefreshToken"("userId", "sessionId", "revokedAt");
