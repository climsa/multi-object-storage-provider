import type { PrismaClient } from "@mosp/db";
import { randomUUID } from "node:crypto";

export interface AuthUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  status: "ACTIVE" | "DISABLED";
}

export interface CreateRefreshTokenInput {
  sessionId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RotateRefreshTokenInput
  extends Omit<CreateRefreshTokenInput, "sessionId" | "userId"> {
  currentTokenHash: string;
  now: Date;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserById(id: string): Promise<AuthUserRecord | null>;
  createRefreshToken(input: CreateRefreshTokenInput): Promise<void>;
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<{ sessionId: string; user: AuthUserRecord }>;
  revokeRefreshToken(tokenHash: string, revokedAt: Date): Promise<void>;
  isAccessSessionActive(sessionId: string, userId: string, now: Date): Promise<boolean>;
}

export class PrismaAuthRepository implements AuthRepository {
  public constructor(private readonly database: PrismaClient) {}

  public async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    return this.database.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
      },
    });
  }

  public async findUserById(id: string): Promise<AuthUserRecord | null> {
    return this.database.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
      },
    });
  }

  public async createRefreshToken(input: CreateRefreshTokenInput): Promise<void> {
    await this.database.refreshToken.create({
      data: {
        sessionId: input.sessionId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        deviceName: input.deviceName ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  public async rotateRefreshToken(
    input: RotateRefreshTokenInput,
  ): Promise<{ sessionId: string; user: AuthUserRecord }> {
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.refreshToken.findUnique({
        where: { tokenHash: input.currentTokenHash },
        include: { user: true },
      });

      if (
        !current ||
        current.revokedAt ||
        current.expiresAt <= input.now ||
        current.user.status !== "ACTIVE"
      ) {
        throw new Error("INVALID_REFRESH_TOKEN");
      }

      const sessionId = current.sessionId ?? randomUUID();
      const replacement = await transaction.refreshToken.create({
        data: {
          sessionId,
          userId: current.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          deviceName: input.deviceName ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
      const revoked = await transaction.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { replacedById: replacement.id, revokedAt: input.now },
      });

      if (revoked.count !== 1) {
        throw new Error("INVALID_REFRESH_TOKEN");
      }

      return {
        sessionId,
        user: {
          id: current.user.id,
          email: current.user.email,
          passwordHash: current.user.passwordHash,
          status: current.user.status,
        },
      };
    });
  }

  public async revokeRefreshToken(
    tokenHash: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.database.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt },
    });
  }

  public async isAccessSessionActive(
    sessionId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const session = await this.database.refreshToken.findFirst({
      where: {
        sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    return session !== null;
  }
}
