export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: AuthUser;
}

export interface DashboardSnapshot {
  providers: Array<Record<string, unknown>>;
  buckets: Array<Record<string, unknown>>;
  namespaces: Array<Record<string, unknown>>;
  activityLogs: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
  usage: DashboardUsage | null;
  members: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  credentials: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
}

export interface DashboardUsageTotals {
  activeUploadCount: number;
  egressBytes: string;
  ingressBytes: string;
  objectCount: string;
  requestCount: string;
  reservedBytes: string;
  usedBytes: string;
}

export interface DashboardUsage {
  namespaces: Array<DashboardUsageTotals & {
    name: string;
    namespaceId: string;
    quotaBytes: string;
    slug: string;
    status: string;
    updatedAt: string | null;
  }>;
  nextCursor: string | null;
  totals: DashboardUsageTotals;
}

export interface PlatformOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

export interface PlatformSetting {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

function csrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const entry = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("mosp_csrf="));
  return entry ? decodeURIComponent(entry.slice("mosp_csrf=".length)) : null;
}

export class DashboardApi {
  public constructor(private accessToken: string | null = null) {}

  public setAccessToken(accessToken: string | null): void {
    this.accessToken = accessToken;
  }

  public async login(email: string, password: string): Promise<AuthResult> {
    const result = await this.request<AuthResult>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }, false);
    this.accessToken = result.accessToken;
    return result;
  }

  public async logout(): Promise<void> {
    await this.request<void>("/v1/auth/logout", {
      method: "POST",
      headers: this.csrfHeaders(),
    }, false);
    this.accessToken = null;
  }

  public async refresh(): Promise<AuthResult> {
    const result = await this.request<AuthResult>("/v1/auth/refresh", {
      method: "POST",
      headers: this.csrfHeaders(),
    }, false);
    this.accessToken = result.accessToken;
    return result;
  }

  public async snapshot(organizationId: string): Promise<DashboardSnapshot> {
    const headers = { "x-organization-id": organizationId };
    const optional = <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch((error: unknown) => {
      if (error instanceof Error && error.message === "forbidden") return fallback;
      throw error;
    });
    const [providers, buckets, namespaces, activity, migrations, usage, members, roles, credentials, grants] = await Promise.all([
      this.request<{ providers: Array<Record<string, unknown>> }>("/v1/providers", { headers }),
      this.request<{ buckets: Array<Record<string, unknown>> }>("/v1/buckets", { headers }),
      this.request<{ namespaces: Array<Record<string, unknown>> }>("/v1/namespaces", { headers }),
      this.request<{ activityLogs: Array<Record<string, unknown>> }>(
        `/v1/organizations/${encodeURIComponent(organizationId)}/activity-logs?limit=10`,
        { headers },
      ),
      this.request<{ migrations: Array<Record<string, unknown>> }>("/v1/migrations", { headers }),
      this.request<{ usage: DashboardUsage }>(
        `/v1/organizations/${encodeURIComponent(organizationId)}/usage?limit=8`,
        { headers },
      ).catch((error: unknown) => {
        // Usage is intentionally optional for roles that only have operational
        // read permissions; the API still enforces usage:read server-side.
        if (error instanceof Error && error.message === "forbidden") return null;
        throw error;
      }),
      optional(this.request<{ members: Array<Record<string, unknown>> }>(`/v1/organizations/${encodeURIComponent(organizationId)}/members`, { headers }), { members: [] }),
      optional(this.request<{ roles: Array<Record<string, unknown>> }>(`/v1/organizations/${encodeURIComponent(organizationId)}/roles`, { headers }), { roles: [] }),
      optional(this.request<{ credentials: Array<Record<string, unknown>> }>("/v1/api-credentials", { headers }), { credentials: [] }),
      optional(this.request<{ grants: Array<Record<string, unknown>> }>("/v1/folder-grants", { headers }), { grants: [] }),
    ]);
    return {
      providers: providers.providers,
      buckets: buckets.buckets,
      namespaces: namespaces.namespaces,
      activityLogs: activity.activityLogs,
      migrations: migrations.migrations,
      usage: usage?.usage ?? null,
      members: members.members,
      roles: roles.roles,
      credentials: credentials.credentials,
      grants: grants.grants,
    };
  }

  public async platformOrganizations(): Promise<PlatformOrganization[]> {
    const result = await this.request<{ organizations: PlatformOrganization[] }>(
      "/v1/platform/organizations",
    );
    return result.organizations;
  }

  public async platformSettings(): Promise<PlatformSetting[]> {
    const result = await this.request<{ settings: PlatformSetting[] }>(
      "/v1/platform/settings",
    );
    return result.settings;
  }

  public async updatePlatformSettings(
    values: Record<string, unknown>,
    expectedVersions: Record<string, number>,
  ): Promise<PlatformSetting[]> {
    const result = await this.request<{ settings: PlatformSetting[] }>(
      "/v1/platform/settings",
      {
        method: "PUT",
        body: JSON.stringify({ values, expectedVersions }),
      },
    );
    return result.settings;
  }

  public async createProvider(
    organizationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request<{ provider: Record<string, unknown> }>(
      "/v1/providers",
      { method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input) },
    );
    return result.provider;
  }

  public async importBucket(
    organizationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request<{ bucket: Record<string, unknown> }>(
      "/v1/buckets/import",
      { method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input) },
    );
    return result.bucket;
  }

  public async createNamespace(
    organizationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request<{ namespace: Record<string, unknown> }>(
      "/v1/namespaces",
      { method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input) },
    );
    return result.namespace;
  }

  public async updatePlacementPolicy(organizationId: string, namespaceId: string, input: Record<string, unknown>) {
    return this.request<{ placementPolicy: Record<string, unknown> }>(`/v1/namespaces/${encodeURIComponent(namespaceId)}/placement-policy`, {
      method: "PUT", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input),
    });
  }

  public async createCredential(organizationId: string, input: Record<string, unknown>) {
    return this.request<{ credential: Record<string, unknown>; secret: string }>("/v1/api-credentials", {
      method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input),
    });
  }

  public async revokeCredential(organizationId: string, credentialId: string) {
    return this.request<{ credential: Record<string, unknown> }>(`/v1/api-credentials/${encodeURIComponent(credentialId)}/revoke`, {
      method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify({}),
    });
  }

  public async createFolderGrant(organizationId: string, input: Record<string, unknown>) {
    return this.request<{ grant: Record<string, unknown> }>("/v1/folder-grants", {
      method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input),
    });
  }

  public async deleteFolderGrant(organizationId: string, grantId: string) {
    await this.request<void>(`/v1/folder-grants/${encodeURIComponent(grantId)}`, {
      method: "DELETE", headers: { "x-organization-id": organizationId },
    });
  }

  public async addMember(organizationId: string, input: Record<string, unknown>) {
    return this.request<{ member: Record<string, unknown> }>(`/v1/organizations/${encodeURIComponent(organizationId)}/members`, {
      method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify(input),
    });
  }

  public async updateMemberStatus(organizationId: string, membershipId: string, status: string) {
    return this.request<{ member: Record<string, unknown> }>(`/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`, {
      method: "PATCH", headers: { "x-organization-id": organizationId }, body: JSON.stringify({ status }),
    });
  }

  public async assignMemberRole(organizationId: string, membershipId: string, roleId: string) {
    return this.request<{ member: Record<string, unknown> }>(`/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}/roles`, {
      method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify({ roleId }),
    });
  }

  public async createMigration(organizationId: string, input: { namespaceId: string; sourceBucketConnectionId: string; targetBucketConnectionId: string }) {
    return this.request<{ migration: Record<string, unknown> }>("/v1/migrations", {
      method: "POST",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify(input),
    });
  }

  public async controlMigration(organizationId: string, migrationId: string, action: "start" | "pause" | "cancel") {
    return this.request<{ migration: Record<string, unknown> }>(`/v1/migrations/${encodeURIComponent(migrationId)}/control`, {
      method: "POST",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify({ action }),
    });
  }

  private csrfHeaders(): Record<string, string> {
    const token = csrfToken();
    return token ? { "x-csrf-token": token } : {};
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    retryOnUnauthorized = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(path, { ...init, headers, credentials: "include", cache: "no-store" });
    if (response.status === 401 && retryOnUnauthorized && path !== "/v1/auth/refresh") {
      await this.refresh();
      return this.request<T>(path, init, false);
    }
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Preserve the status-only message for empty/non-JSON responses.
      }
      throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
