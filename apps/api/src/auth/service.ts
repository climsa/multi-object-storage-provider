import { randomUUID } from "node:crypto";

import {
  createRefreshToken,
  hashRefreshToken,
  type JwtService,
  type PasswordHasher,
} from "@mosp/auth";
import { authUserSchema, type AuthUser } from "@mosp/shared";

import type {
  AuthRepository,
  AuthUserRecord,
  CreateRefreshTokenInput,
} from "./repository.js";

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DUMMY_PASSWORD_HASH =
  "scrypt$v1$bW9zcC1kdW1teS1zYWx0IQ$O4FSWd6psDQh9sQ0MiVb3NsKlBkirh-o8O8ScWA5MglAD8HKavsWc5_sfPt-ROt4sLJmPnEdq7o7KW-nJod0nw";

export type AuthFailureCode =
  | "INVALID_CREDENTIALS"
  | "INVALID_REFRESH_TOKEN"
  | "UNAUTHENTICATED";

export class AuthFailure extends Error {
  public constructor(public readonly code: AuthFailureCode) {
    super(code);
    this.name = "AuthFailure";
  }
}

export interface AuthRequestMetadata {
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthTokenResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: AuthUser;
}

export interface AuthServiceDependencies {
  jwtService: JwtService;
  passwordHasher: PasswordHasher;
  repository: AuthRepository;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  now?: () => Date;
}

export class AuthService {
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private readonly now: () => Date;

  public constructor(private readonly dependencies: AuthServiceDependencies) {
    this.accessTokenTtlSeconds =
      dependencies.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTokenTtlSeconds =
      dependencies.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async login(
    email: string,
    password: string,
    metadata: AuthRequestMetadata,
  ): Promise<AuthTokenResult> {
    const user = await this.dependencies.repository.findUserByEmail(email);
    const validPassword = await this.dependencies.passwordHasher.verify(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || user.status !== "ACTIVE" || !validPassword) {
      throw new AuthFailure("INVALID_CREDENTIALS");
    }

    return this.issueSession(user, metadata);
  }

  public async refresh(
    refreshToken: string,
    metadata: AuthRequestMetadata,
  ): Promise<AuthTokenResult> {
    const newRefreshToken = createRefreshToken();
    const now = this.now();
    const refreshTokenExpiresAt = new Date(
      now.getTime() + this.refreshTokenTtlSeconds * 1000,
    );

    let session: { sessionId: string; user: AuthUserRecord };
    try {
      session = await this.dependencies.repository.rotateRefreshToken({
        currentTokenHash: hashRefreshToken(refreshToken),
        tokenHash: hashRefreshToken(newRefreshToken),
        expiresAt: refreshTokenExpiresAt,
        now,
        ...metadata,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_REFRESH_TOKEN") {
        throw new AuthFailure("INVALID_REFRESH_TOKEN");
      }

      throw error;
    }

    const accessToken = await this.issueAccessToken(session.user.id, session.sessionId);
    return {
      ...accessToken,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt,
      user: this.publicUser(session.user),
    };
  }

  public async logout(refreshToken: string): Promise<void> {
    await this.dependencies.repository.revokeRefreshToken(
      hashRefreshToken(refreshToken),
      this.now(),
    );
  }

  public async session(accessToken: string): Promise<AuthUser> {
    let verified;
    try {
      verified = await this.dependencies.jwtService.verifyAccessToken(accessToken);
    } catch {
      throw new AuthFailure("UNAUTHENTICATED");
    }

    const user = await this.dependencies.repository.findUserById(verified.userId);
    if (!user || user.status !== "ACTIVE") {
      throw new AuthFailure("UNAUTHENTICATED");
    }
    if (!(await this.dependencies.repository.isAccessSessionActive(verified.sessionId, user.id, this.now()))) {
      throw new AuthFailure("UNAUTHENTICATED");
    }

    return this.publicUser(user);
  }

  private async issueSession(
    user: AuthUserRecord,
    metadata: AuthRequestMetadata,
  ): Promise<AuthTokenResult> {
    const refreshToken = createRefreshToken();
    const now = this.now();
    const refreshTokenExpiresAt = new Date(
      now.getTime() + this.refreshTokenTtlSeconds * 1000,
    );
    const sessionId = randomUUID();
    const accessToken = await this.issueAccessToken(user.id, sessionId);
    const refreshInput: CreateRefreshTokenInput = {
      sessionId,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshTokenExpiresAt,
      ...metadata,
    };

    await this.dependencies.repository.createRefreshToken(refreshInput);

    return {
      ...accessToken,
      refreshToken,
      refreshTokenExpiresAt,
      user: this.publicUser(user),
    };
  }

  private async issueAccessToken(userId: string, sessionId: string) {
    const issued = await this.dependencies.jwtService.issueAccessToken({
      sessionId,
      userId,
    });

    return {
      accessToken: issued.token,
      accessTokenExpiresAt: issued.expiresAt,
    };
  }

  private publicUser(user: AuthUserRecord): AuthUser {
    return authUserSchema.parse({ id: user.id, email: user.email });
  }
}
