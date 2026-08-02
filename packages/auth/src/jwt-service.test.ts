import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { JwtService } from "./jwt-service.js";

describe("JwtService", () => {
  it("issues and verifies an access token", async () => {
    const service = new JwtService({
      audience: "mosp-api",
      issuer: "mosp",
      secret: randomBytes(32),
    });
    const issued = await service.issueAccessToken({
      sessionId: "session-1",
      userId: "user-1",
    });

    await expect(service.verifyAccessToken(issued.token)).resolves.toMatchObject({
      sessionId: "session-1",
      userId: "user-1",
    });
  });

  it("rejects a token signed by another key", async () => {
    const service = new JwtService({
      audience: "mosp-api",
      issuer: "mosp",
      secret: randomBytes(32),
    });
    const otherService = new JwtService({
      audience: "mosp-api",
      issuer: "mosp",
      secret: randomBytes(32),
    });
    const issued = await otherService.issueAccessToken({
      sessionId: "session-1",
      userId: "user-1",
    });

    await expect(service.verifyAccessToken(issued.token)).rejects.toThrow(
      "Invalid access token",
    );
  });
});

