import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  expiresAt: Date;
}

export interface JwtServiceOptions {
  audience: string;
  issuer: string;
  secret: Uint8Array;
  ttlSeconds?: number;
}

export class JwtService {
  private readonly audience: string;
  private readonly issuer: string;
  private readonly secret: Uint8Array;
  private readonly ttlSeconds: number;

  public constructor(options: JwtServiceOptions) {
    if (options.secret.byteLength < 32) {
      throw new Error("JWT signing secret must contain at least 32 bytes");
    }

    this.audience = options.audience;
    this.issuer = options.issuer;
    this.secret = options.secret;
    this.ttlSeconds = options.ttlSeconds ?? 900;
  }

  public async issueAccessToken(
    claims: AccessTokenClaims,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const token = await new SignJWT({
      tokenType: "access",
      userId: claims.userId,
      sessionId: claims.sessionId,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(claims.userId)
      .setJti(claims.sessionId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.secret);

    return { token, expiresAt };
  }

  public async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        audience: this.audience,
        issuer: this.issuer,
      });

      const claims = this.parseClaims(payload);
      return {
        ...claims,
        expiresAt: new Date((payload.exp ?? 0) * 1000),
      };
    } catch {
      throw new Error("Invalid access token");
    }
  }

  private parseClaims(payload: JWTPayload): AccessTokenClaims {
    if (
      payload.tokenType !== "access" ||
      typeof payload.sub !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.exp !== "number"
    ) {
      throw new Error("Invalid access token claims");
    }

    return {
      sessionId: payload.jti,
      userId: payload.sub,
    };
  }
}
