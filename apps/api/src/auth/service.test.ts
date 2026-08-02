import { randomBytes } from "node:crypto";

import { JwtService } from "@mosp/auth";
import { describe, expect, it } from "vitest";

import { AuthService } from "./service.js";

describe("AuthService access-session revocation", () => {
  it("rejects an access token after its refresh session is logged out", async () => {
    let activeSession = true;
    const user = {
      id: "10000000-0000-4000-8000-000000000001",
      email: "owner@example.com",
      passwordHash: "stored-hash",
      status: "ACTIVE" as const,
    };
    const repository = {
      findUserByEmail: async () => user,
      findUserById: async () => user,
      createRefreshToken: async () => undefined,
      revokeRefreshToken: async () => {
        activeSession = false;
      },
      isAccessSessionActive: async () => activeSession,
      rotateRefreshToken: async () => ({ sessionId: "session-id", user }),
    };
    const service = new AuthService({
      jwtService: new JwtService({
        audience: "mosp-api",
        issuer: "mosp",
        secret: randomBytes(32),
      }),
      passwordHasher: { verify: async () => true } as never,
      repository,
    });

    const issued = await service.login("owner@example.com", "password", {});
    await expect(service.session(issued.accessToken)).resolves.toMatchObject({
      id: user.id,
    });

    await service.logout(issued.refreshToken);
    await expect(service.session(issued.accessToken)).rejects.toThrow("UNAUTHENTICATED");
  });
});
