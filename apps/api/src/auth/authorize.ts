import { type Request } from "express";
import { z } from "zod";

import { parseBearerToken } from "./cookies.js";
import { type AuthService } from "./service.js";
import { type OrganizationAccessRepository } from "./organization-access.js";

export interface AuthorizationDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
}

export interface PlatformAuthorizationDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
}

export async function authorize(
  request: Request,
  dependencies: AuthorizationDependencies,
  permission: string,
) {
  const token = parseBearerToken(request);
  const organizationId = z.string().uuid().safeParse(request.header("x-organization-id"));
  if (!token || !organizationId.success) {
    throw new Error("UNAUTHENTICATED");
  }

  let user;
  try {
    user = await dependencies.authService.session(token);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  const access = await dependencies.organizationAccess.findUserAccess(
    user.id,
    organizationId.data,
  );
  if (!access || access.membershipStatus !== "ACTIVE") {
    throw new Error("FORBIDDEN");
  }
  if (!access.permissions.has(permission)) {
    throw new Error("FORBIDDEN");
  }

  return { organizationId: organizationId.data, userId: user.id };
}

export async function authorizePlatform(
  request: Request,
  dependencies: PlatformAuthorizationDependencies,
  permission: string,
): Promise<{ userId: string }> {
  const token = parseBearerToken(request);
  if (!token) throw new Error("UNAUTHENTICATED");

  let user;
  try {
    user = await dependencies.authService.session(token);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  const access = await dependencies.organizationAccess.findGlobalAccess(user.id);
  if (!access || !access.permissions.has(permission)) {
    throw new Error("FORBIDDEN");
  }

  return { userId: user.id };
}
