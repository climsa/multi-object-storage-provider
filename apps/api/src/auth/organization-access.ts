import type { PrismaClient } from "@mosp/db";

export interface OrganizationAccess {
  membershipStatus: "INVITED" | "ACTIVE" | "DISABLED";
  permissions: Set<string>;
}

export interface OrganizationAccessRepository {
  findUserAccess(userId: string, organizationId: string): Promise<OrganizationAccess | null>;
  findGlobalAccess(userId: string): Promise<GlobalAccess | null>;
}

export interface GlobalAccess {
  permissions: Set<string>;
}

export class PrismaOrganizationAccessRepository
  implements OrganizationAccessRepository
{
  public constructor(private readonly database: PrismaClient) {}

  public async findUserAccess(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationAccess | null> {
    const membership = await this.database.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: {
        status: true,
        roles: {
          select: {
            role: {
              select: {
                permissions: {
                  select: { permission: { select: { key: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!membership) return null;

    return {
      membershipStatus: membership.status,
      permissions: new Set(
        membership.roles.flatMap((memberRole) =>
          memberRole.role.permissions.map((rolePermission) => rolePermission.permission.key),
        ),
      ),
    };
  }

  public async findGlobalAccess(userId: string): Promise<GlobalAccess | null> {
    const assignments = await this.database.userRole.findMany({
      where: {
        userId,
        roleScope: "GLOBAL",
        role: { scope: "GLOBAL" },
      },
      select: {
        role: {
          select: {
            permissions: {
              select: { permission: { select: { key: true } } },
            },
          },
        },
      },
    });

    if (assignments.length === 0) return null;
    return {
      permissions: new Set(
        assignments.flatMap((assignment) =>
          assignment.role.permissions.map((rolePermission) => rolePermission.permission.key),
        ),
      ),
    };
  }
}
