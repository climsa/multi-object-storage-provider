import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { PasswordHasher } from "@mosp/auth";
import { createPrismaClient, readDatabaseUrl } from "@mosp/db";
import { loginRequestSchema, permissionKeys } from "@mosp/shared";

const defaultEmail = "superadmin@example.test";
const globalPermissionKeys = new Set([
  "organizations:create",
  "organizations:read",
  "organizations:update",
  "organizations:suspend",
  "usage:read",
  "audit:read",
  "platform:read",
  "platform:manage",
]);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function promptSecret(question) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Use --generate-password or run this command in an interactive terminal");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    output.write(question);
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.setRawMode(false);
      input.off("data", onData);
      output.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password prompt cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    input.on("data", onData);
  });
}

const email = argumentValue("--email") ?? defaultEmail;
const organizationSlug = argumentValue("--organization-slug");
const generatedPassword = process.argv.includes("--generate-password");
const password = generatedPassword
  ? randomBytes(24).toString("base64url")
  : await promptSecret("Super admin password (minimum 12 characters): ");
const parsedLogin = loginRequestSchema.safeParse({ email, password });
if (!parsedLogin.success || password.length < 12) {
  throw new Error("Email or password is invalid; password must contain at least 12 characters");
}

let database;
try {
  database = createPrismaClient(await readDatabaseUrl());
  const organizations = await database.organization.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true },
  });
  const organization = organizationSlug
    ? organizations.find((candidate) => candidate.slug === organizationSlug)
    : organizations.length === 1
      ? organizations[0]
      : null;

  if (!organization) {
    if (organizationSlug) throw new Error(`Organization not found: ${organizationSlug}`);
    throw new Error("Specify --organization-slug because the database does not contain exactly one organization");
  }

  const existingUser = await database.user.findUnique({
    where: { email: parsedLogin.data.email },
    select: { id: true },
  });
  if (existingUser) throw new Error(`User already exists: ${parsedLogin.data.email}`);

  const passwordHash = await new PasswordHasher().hash(password);
  const result = await database.$transaction(async (transaction) => {
    const permissions = [];
    for (const key of permissionKeys) {
      permissions.push(
        await transaction.permission.upsert({
          where: { key },
          update: {},
          create: { key, description: `Permission ${key}` },
        }),
      );
    }

    const organizationOwner = await transaction.role.upsert({
      where: {
        organizationId_name: {
          organizationId: organization.id,
          name: "Organization Owner",
        },
      },
      update: { isSystem: true },
      create: {
        organizationId: organization.id,
        name: "Organization Owner",
        scope: "ORGANIZATION",
        isSystem: true,
      },
    });
    const existingPlatformAdmin = await transaction.role.findFirst({
      where: { name: "Platform Admin", scope: "GLOBAL" },
      select: { id: true },
    });
    const platformAdmin = existingPlatformAdmin
      ? await transaction.role.update({
          where: { id: existingPlatformAdmin.id },
          data: { isSystem: true },
        })
      : await transaction.role.create({
          data: { name: "Platform Admin", scope: "GLOBAL", isSystem: true },
        });

    for (const permission of permissions) {
      await transaction.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: organizationOwner.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: { roleId: organizationOwner.id, permissionId: permission.id },
      });
      if (globalPermissionKeys.has(permission.key)) {
        await transaction.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: platformAdmin.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: platformAdmin.id, permissionId: permission.id },
        });
      }
    }

    const user = await transaction.user.create({
      data: {
        email: parsedLogin.data.email,
        passwordHash,
        status: "ACTIVE",
      },
    });
    const membership = await transaction.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        status: "ACTIVE",
      },
    });
    await transaction.memberRole.create({
      data: {
        membershipId: membership.id,
        roleId: organizationOwner.id,
        organizationId: organization.id,
      },
    });
    await transaction.userRole.create({
      data: { userId: user.id, roleId: platformAdmin.id, roleScope: "GLOBAL" },
    });
    await transaction.activityLog.create({
      data: {
        organizationId: organization.id,
        actorId: user.id,
        action: "bootstrap.super_admin",
        entityType: "User",
        entityId: user.id,
        requestId: "bootstrap-super-admin",
        metadata: {
          globalRole: platformAdmin.name,
          organizationRole: organizationOwner.name,
        },
      },
    });

    return user;
  });

  console.log(`Created dedicated super admin ${result.email}`);
  console.log(`Organization access: ${organization.name} (${organization.slug})`);
  if (generatedPassword) console.log(`One-time password: ${password}`);
} finally {
  await database?.$disconnect();
}
