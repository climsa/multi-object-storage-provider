import type { PrismaClient } from "@mosp/db";
import type {
  ActivityLogQuery,
  MemberAddRequest,
  MemberStatusUpdateRequest,
  OrganizationUpdateRequest,
  RoleCreateRequest,
  RoleAssignmentRequest,
  RoleUpdateRequest,
} from "@mosp/shared";

export interface OrganizationActionMetadata {
  actorId: string;
  requestId: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface MemberSummary {
  email: string;
  id: string;
  roles: string[];
  status: string;
  userId: string;
}

export interface RoleSummary {
  id: string;
  isSystem: boolean;
  name: string;
  permissionKeys: string[];
}

export interface ActivityLogSummary {
  action: string;
  actor: { email: string; id: string } | null;
  createdAt: string;
  entityId: string | null;
  entityType: string;
  id: string;
  metadata: unknown;
  requestId: string;
}

export interface ActivityLogPage {
  items: ActivityLogSummary[];
  nextCursor: string | null;
}

export class OrganizationNotFound extends Error {}
export class MemberNotFound extends Error {}
export class UserNotFound extends Error {}
export class RoleNotFound extends Error {}
export class PermissionNotFound extends Error {}
export class RoleInUse extends Error {}
export class SystemRoleProtected extends Error {}

type MemberRecord = {
  id: string;
  status: string;
  userId: string;
  user: { email: string };
  roles: Array<{ role: { name: string } }>;
};

export class OrganizationService {
  public constructor(private readonly database: PrismaClient) {}

  public async get(organizationId: string): Promise<OrganizationSummary> {
    const organization = await this.database.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization) throw new OrganizationNotFound();
    return this.toSummary(organization);
  }

  public async listActivityLogs(
    organizationId: string,
    input: ActivityLogQuery,
  ): Promise<ActivityLogPage> {
    const logs = await this.database.activityLog.findMany({
      where: {
        organizationId,
        ...(input.cursor ? { id: { lt: BigInt(input.cursor) } } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.entityType ? { entityType: input.entityType } : {}),
      },
      orderBy: { id: "desc" },
      take: input.limit + 1,
      select: {
        id: true,
        action: true,
        entityId: true,
        entityType: true,
        metadata: true,
        requestId: true,
        createdAt: true,
        actor: { select: { id: true, email: true } },
      },
    });

    const hasMore = logs.length > input.limit;
    const page = hasMore ? logs.slice(0, input.limit) : logs;
    return {
      items: page.map((log) => ({
        action: log.action,
        actor: log.actor,
        createdAt: log.createdAt.toISOString(),
        entityId: log.entityId,
        entityType: log.entityType,
        id: log.id.toString(),
        metadata: log.metadata,
        requestId: log.requestId,
      })),
      nextCursor: hasMore ? page.at(-1)!.id.toString() : null,
    };
  }

  public async update(
    organizationId: string,
    input: OrganizationUpdateRequest,
    metadata: OrganizationActionMetadata,
  ): Promise<OrganizationSummary> {
    const organization = await this.database.$transaction(async (transaction) => {
      const updated = await transaction.organization.update({
        where: { id: organizationId },
        data: { name: input.name },
      });
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "organizations.update",
          entityType: "Organization",
          entityId: organizationId,
          requestId: metadata.requestId,
          metadata: { nameChanged: true },
        },
      });
      return updated;
    });
    return this.toSummary(organization);
  }

  public async listMembers(organizationId: string): Promise<MemberSummary[]> {
    const memberships = await this.database.membership.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        userId: true,
        user: { select: { email: true } },
        roles: { select: { role: { select: { name: true } } } },
      },
    });

    return memberships.map((membership) => this.toMemberSummary(membership));
  }

  public async listRoles(organizationId: string): Promise<RoleSummary[]> {
    const roles = await this.database.role.findMany({
      where: { organizationId, scope: "ORGANIZATION" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        isSystem: true,
        name: true,
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });
    return roles.map((role) => this.toRoleSummary(role));
  }

  public async createRole(
    organizationId: string,
    input: RoleCreateRequest,
    metadata: OrganizationActionMetadata,
  ): Promise<RoleSummary> {
    const role = await this.database.$transaction(async (transaction) => {
      const permissions = await transaction.permission.findMany({
        where: { key: { in: input.permissionKeys } },
        select: { id: true, key: true },
      });
      if (permissions.length !== input.permissionKeys.length) {
        throw new PermissionNotFound();
      }

      const created = await transaction.role.create({
        data: {
          organizationId,
          name: input.name,
          scope: "ORGANIZATION",
          isSystem: false,
        },
      });
      if (permissions.length > 0) {
        await transaction.rolePermission.createMany({
          data: permissions.map((permission) => ({
            permissionId: permission.id,
            roleId: created.id,
          })),
        });
      }
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "roles.create",
          entityType: "Role",
          entityId: created.id,
          requestId: metadata.requestId,
          metadata: { name: input.name, permissionKeys: input.permissionKeys },
        },
      });
      return transaction.role.findFirstOrThrow({
        where: { id: created.id, organizationId, scope: "ORGANIZATION" },
        select: {
          id: true,
          isSystem: true,
          name: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      });
    });

    return this.toRoleSummary(role);
  }

  public async updateRole(
    organizationId: string,
    roleId: string,
    input: RoleUpdateRequest,
    metadata: OrganizationActionMetadata,
  ): Promise<RoleSummary> {
    const role = await this.database.$transaction(async (transaction) => {
      const current = await transaction.role.findFirst({
        where: { id: roleId, organizationId, scope: "ORGANIZATION" },
        select: { id: true, isSystem: true },
      });
      if (!current) throw new RoleNotFound();
      if (current.isSystem) throw new SystemRoleProtected();

      let permissions: Array<{ id: string; key: string }> = [];
      if (input.permissionKeys !== undefined) {
        permissions = await transaction.permission.findMany({
          where: { key: { in: input.permissionKeys } },
          select: { id: true, key: true },
        });
        if (permissions.length !== input.permissionKeys.length) {
          throw new PermissionNotFound();
        }
      }

      await transaction.role.update({
        where: { id: roleId },
        data: input.name !== undefined ? { name: input.name } : {},
      });
      if (input.permissionKeys !== undefined) {
        await transaction.rolePermission.deleteMany({ where: { roleId } });
        if (permissions.length > 0) {
          await transaction.rolePermission.createMany({
            data: permissions.map((permission) => ({
              permissionId: permission.id,
              roleId,
            })),
          });
        }
      }
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "roles.update",
          entityType: "Role",
          entityId: roleId,
          requestId: metadata.requestId,
          metadata: {
            ...(input.name !== undefined ? { nameChanged: true } : {}),
            ...(input.permissionKeys !== undefined
              ? { permissionKeys: input.permissionKeys }
              : {}),
          },
        },
      });
      return transaction.role.findFirstOrThrow({
        where: { id: roleId, organizationId, scope: "ORGANIZATION" },
        select: {
          id: true,
          isSystem: true,
          name: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      });
    });

    return this.toRoleSummary(role);
  }

  public async deleteRole(
    organizationId: string,
    roleId: string,
    metadata: OrganizationActionMetadata,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const role = await transaction.role.findFirst({
        where: { id: roleId, organizationId, scope: "ORGANIZATION" },
        select: { id: true, isSystem: true },
      });
      if (!role) throw new RoleNotFound();
      if (role.isSystem) throw new SystemRoleProtected();

      const assignments = await transaction.memberRole.count({
        where: { roleId, organizationId },
      });
      if (assignments > 0) throw new RoleInUse();

      await transaction.role.delete({ where: { id: roleId } });
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "roles.delete",
          entityType: "Role",
          entityId: roleId,
          requestId: metadata.requestId,
          metadata: { deleted: true },
        },
      });
    });
  }

  public async addMember(
    organizationId: string,
    input: MemberAddRequest,
    metadata: OrganizationActionMetadata,
  ): Promise<MemberSummary> {
    const membership = await this.database.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { email: input.email } });
      if (!user) throw new UserNotFound();

      if (input.roleId) {
        const role = await transaction.role.findFirst({
          where: { id: input.roleId, organizationId, scope: "ORGANIZATION" },
          select: { id: true },
        });
        if (!role) throw new RoleNotFound();
      }

      const created = await transaction.membership.create({
        data: { organizationId, status: "INVITED", userId: user.id },
      });
      if (input.roleId) {
        await transaction.memberRole.create({
          data: {
            membershipId: created.id,
            organizationId,
            roleId: input.roleId,
          },
        });
      }
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "members.create",
          entityType: "Membership",
          entityId: created.id,
          requestId: metadata.requestId,
          metadata: input.roleId
            ? { email: input.email, roleId: input.roleId }
            : { email: input.email },
        },
      });
      return transaction.membership.findFirstOrThrow({
        where: { id: created.id, organizationId },
        select: {
          id: true,
          status: true,
          userId: true,
          user: { select: { email: true } },
          roles: { select: { role: { select: { name: true } } } },
        },
      });
    });

    return this.toMemberSummary(membership);
  }

  public async assignRole(
    organizationId: string,
    membershipId: string,
    input: RoleAssignmentRequest,
    metadata: OrganizationActionMetadata,
  ): Promise<MemberSummary> {
    const membership = await this.database.$transaction(async (transaction) => {
      const current = await transaction.membership.findFirst({
        where: { id: membershipId, organizationId },
        select: { id: true },
      });
      if (!current) throw new MemberNotFound();

      const role = await transaction.role.findFirst({
        where: {
          id: input.roleId,
          organizationId,
          scope: "ORGANIZATION",
        },
        select: { id: true },
      });
      if (!role) throw new RoleNotFound();

      await transaction.memberRole.upsert({
        where: {
          membershipId_roleId: {
            membershipId,
            roleId: input.roleId,
          },
        },
        create: { membershipId, organizationId, roleId: input.roleId },
        update: {},
      });
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "roles.assign",
          entityType: "Membership",
          entityId: membershipId,
          requestId: metadata.requestId,
          metadata: { roleId: input.roleId },
        },
      });

      return transaction.membership.findFirstOrThrow({
        where: { id: membershipId, organizationId },
        select: {
          id: true,
          status: true,
          userId: true,
          user: { select: { email: true } },
          roles: { select: { role: { select: { name: true } } } },
        },
      });
    });

    return this.toMemberSummary(membership);
  }

  public async updateMemberStatus(
    organizationId: string,
    membershipId: string,
    input: MemberStatusUpdateRequest,
    metadata: OrganizationActionMetadata,
  ): Promise<MemberSummary> {
    const membership = await this.database.$transaction(async (transaction) => {
      const updated = await transaction.membership.updateMany({
        where: { id: membershipId, organizationId },
        data: { status: input.status },
      });
      if (updated.count !== 1) throw new MemberNotFound();

      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "members.update",
          entityType: "Membership",
          entityId: membershipId,
          requestId: metadata.requestId,
          metadata: { status: input.status },
        },
      });

      const current = await transaction.membership.findFirst({
        where: { id: membershipId, organizationId },
        select: {
          id: true,
          status: true,
          userId: true,
          user: { select: { email: true } },
          roles: { select: { role: { select: { name: true } } } },
        },
      });
      if (!current) throw new MemberNotFound();
      return current;
    });

    return this.toMemberSummary(membership);
  }

  private toMemberSummary(membership: MemberRecord): MemberSummary {
    return {
      email: membership.user.email,
      id: membership.id,
      roles: membership.roles.map((memberRole) => memberRole.role.name),
      status: membership.status,
      userId: membership.userId,
    };
  }

  private toRoleSummary(role: {
    id: string;
    isSystem: boolean;
    name: string;
    permissions: Array<{ permission: { key: string } }>;
  }): RoleSummary {
    return {
      id: role.id,
      isSystem: role.isSystem,
      name: role.name,
      permissionKeys: role.permissions.map((permission) => permission.permission.key),
    };
  }

  private toSummary(organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
  }): OrganizationSummary {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
    };
  }
}
