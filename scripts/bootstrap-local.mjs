import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { PasswordHasher } from "@mosp/auth";
import { createPrismaClient, readDatabaseUrl } from "@mosp/db";
import { loginRequestSchema, permissionKeys } from "@mosp/shared";

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function promptSecret(question) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("bootstrap-local requires an interactive terminal for the password prompt");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    output.write(question);
    input.setRawMode(true);
    input.resume();

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

    const cleanup = () => {
      input.setRawMode(false);
      input.off("data", onData);
      output.write("\n");
    };

    input.on("data", onData);
  });
}

const readline = createInterface({ input, output });
let database;

try {
  const emailInput = (await readline.question("Admin email [admin@example.test]: ")).trim();
  const organizationNameInput = (
    await readline.question("Organization name [Local Organization]: ")
  ).trim();
  readline.close();

  const email = emailInput || "admin@example.test";
  const organizationName = organizationNameInput || "Local Organization";
  const organizationSlug = slugify(organizationName);
  if (!organizationSlug) throw new Error("Organization name must contain letters or numbers");

  const password = await promptSecret("Admin password (minimum 12 characters): ");
  const parsedLogin = loginRequestSchema.safeParse({ email, password });
  if (!parsedLogin.success || password.length < 12) {
    throw new Error("Email or password is invalid; password must contain at least 12 characters");
  }

  database = createPrismaClient(await readDatabaseUrl());
  const passwordHash = await new PasswordHasher().hash(password);

  const result = await database.$transaction(async (transaction) => {
    const existingUser = await transaction.user.findUnique({
      where: { email: parsedLogin.data.email },
      select: { id: true },
    });
    if (existingUser) {
      throw new Error(`User already exists: ${parsedLogin.data.email}`);
    }

    const organization = await transaction.organization.upsert({
      where: { slug: organizationSlug },
      update: {},
      create: { name: organizationName, slug: organizationSlug },
    });
    const user = await transaction.user.create({
      data: {
        email: parsedLogin.data.email,
        passwordHash,
        status: "ACTIVE",
      },
    });

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

    const role = await transaction.role.upsert({
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

    const existingGlobalRole = await transaction.role.findFirst({
      where: { name: "Platform Admin", scope: "GLOBAL" },
      select: { id: true },
    });
    const globalRole = existingGlobalRole
      ? await transaction.role.update({ where: { id: existingGlobalRole.id }, data: { isSystem: true } })
      : await transaction.role.create({
          data: { name: "Platform Admin", scope: "GLOBAL", isSystem: true },
        });

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
    for (const permission of permissions) {
      await transaction.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
      if (globalPermissionKeys.has(permission.key)) {
        await transaction.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: globalRole.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: globalRole.id, permissionId: permission.id },
        });
      }
    }
    await transaction.rolePermission.deleteMany({
      where: {
        roleId: globalRole.id,
        permissionId: { notIn: permissions.filter((permission) => globalPermissionKeys.has(permission.key)).map((permission) => permission.id) },
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
        roleId: role.id,
        organizationId: organization.id,
      },
    });
    await transaction.userRole.create({
      data: { userId: user.id, roleId: globalRole.id, roleScope: "GLOBAL" },
    });
    await transaction.activityLog.create({
      data: {
        organizationId: organization.id,
        actorId: user.id,
        action: "bootstrap.local",
        entityType: "Organization",
        entityId: organization.id,
        requestId: "bootstrap-local",
        metadata: { role: role.name },
      },
    });

    return { organization, user };
  });

  console.log(`Created local admin ${result.user.email}`);
  console.log(`Organization: ${result.organization.name} (${result.organization.id})`);
  console.log("Use the normal /v1/auth/login endpoint to obtain an access token.");
} finally {
  readline.close();
  await database?.$disconnect();
}
