"use client";

import { FormEvent, useMemo, useState } from "react";

import {
  DashboardApi,
  type DashboardSnapshot,
  type PlatformOrganization,
  type PlatformSetting,
} from "./api-client";

const emptySnapshot: DashboardSnapshot = {
  providers: [],
  buckets: [],
  namespaces: [],
  activityLogs: [],
  migrations: [],
  usage: null,
  members: [],
  roles: [],
  credentials: [],
  grants: [],
};

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function statusClass(value: unknown): string {
  const normalized = String(value ?? "unknown").toLowerCase();
  return normalized === "healthy" || normalized === "active" ? "status status-ok" : "status status-muted";
}

function formatBytes(value: string): string {
  try {
    const bytes = BigInt(value);
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let unit = 0;
    let scaled = bytes;
    while (scaled >= 1024n && unit < units.length - 1) {
      scaled /= 1024n;
      unit += 1;
    }
    return `${scaled.toString()} ${units[unit]}`;
  } catch {
    return "—";
  }
}

function platformSettingDescription(key: string): string | null {
  if (key === "proxy_max_object_size_bytes") return "1 byte–1 GiB; berlaku setelah API restart";
  if (key === "proxy_transfer_timeout_seconds") return "10–300 detik; berlaku setelah API restart";
  return null;
}

export default function AdminDashboard() {
  const api = useMemo(() => new DashboardApi(), []);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [organizations, setOrganizations] = useState<PlatformOrganization[]>([]);
  const [platformSettings, setPlatformSettings] = useState<PlatformSetting[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api.login(email, password);
      setUser(result.user);
      setPassword("");
      try {
        const [platformOrganizations, settings] = await Promise.all([
          api.platformOrganizations(),
          api.platformSettings(),
        ]);
        setOrganizations(platformOrganizations);
        setPlatformSettings(settings);
        setPlatformAdmin(true);
        if (!organizationId && platformOrganizations[0]) {
          setOrganizationId(platformOrganizations[0].id);
        }
      } catch (platformError) {
        if (!(platformError instanceof Error) || platformError.message !== "forbidden") {
          throw platformError;
        }
        setPlatformAdmin(false);
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login gagal");
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboard(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!organizationId) {
      setError("Organization ID wajib diisi.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.snapshot(organizationId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Data dashboard gagal dimuat");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    try {
      await api.logout();
    } catch {
      // Clear the in-memory token even if the network is unavailable.
    } finally {
      setUser(null);
      setPlatformAdmin(false);
      setOrganizations([]);
      setPlatformSettings([]);
      setOrganizationId("");
      setSnapshot(emptySnapshot);
      setLoading(false);
    }
  }

  async function refreshMigrations() {
    if (!organizationId) return;
    try {
      const result = await api.snapshot(organizationId);
      setSnapshot(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Migration gagal dimuat");
    }
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="login-title">
          <p className="eyebrow">Control plane</p>
          <h1 id="login-title">Object storage admin</h1>
          <p className="summary">Masuk untuk mengelola provider, bucket, namespace, dan audit log.</p>
          <form onSubmit={handleLogin} className="stack">
            <label>
              Email
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button type="submit" disabled={loading}>{loading ? "Memproses…" : "Masuk"}</button>
          </form>
          <p className="security-note">Token akses hanya disimpan di memory tab ini. Refresh token dikelola oleh cookie HttpOnly.</p>
        </section>
      </main>
    );
  }

  const cards = [
    ["Providers", snapshot.providers.length],
    ["Buckets", snapshot.buckets.length],
    ["Namespaces", snapshot.namespaces.length],
    ["Recent events", snapshot.activityLogs.length],
    ["Migrations", snapshot.migrations.length],
  ] as const;

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Multi-provider object storage</p>
          <h1>Administration</h1>
        </div>
        <div className="user-actions"><span>{user.email}</span><button className="button-secondary" onClick={handleLogout} disabled={loading}>Keluar</button></div>
      </header>
      <section className="scope-card" aria-labelledby="scope-title">
        <div><h2 id="scope-title">Organization scope</h2><p>Semua query tenant tetap memakai organization scope eksplisit.</p></div>
        <form onSubmit={loadDashboard} className="scope-form">
          <label className="sr-only" htmlFor="organization-id">Organization ID</label>
          {platformAdmin && organizations.length > 0 ? <select id="organization-id" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} required><option value="">Pilih organisasi</option>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} ({organization.slug})</option>)}</select> : <input id="organization-id" value={organizationId} onChange={(event) => setOrganizationId(event.target.value.trim())} placeholder="UUID organization" pattern="[0-9a-fA-F-]{36}" required />}
          <button type="submit" disabled={loading}>{loading ? "Memuat…" : "Muat data"}</button>
        </form>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {platformAdmin && <PlatformSettingsPanel api={api} initialSettings={platformSettings} onChanged={setPlatformSettings} />}
      <section className="metric-grid" aria-label="Ringkasan">
        {cards.map(([label, value]) => <article className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></article>)}
      </section>
      <section className="panel-grid">
        <UsagePanel usage={snapshot.usage} />
        <ProviderCreatePanel api={api} organizationId={organizationId} onChanged={refreshMigrations} />
        <BucketImportPanel api={api} organizationId={organizationId} providers={snapshot.providers} onChanged={refreshMigrations} />
        <NamespaceCreatePanel api={api} organizationId={organizationId} onChanged={refreshMigrations} />
        <PlacementPolicyPanel api={api} organizationId={organizationId} namespaces={snapshot.namespaces} buckets={snapshot.buckets} onChanged={refreshMigrations} />
        <MembersPanel api={api} organizationId={organizationId} members={snapshot.members} roles={snapshot.roles} onChanged={refreshMigrations} />
        <CredentialGrantPanel api={api} organizationId={organizationId} namespaces={snapshot.namespaces} credentials={snapshot.credentials} grants={snapshot.grants} onChanged={refreshMigrations} />
        <DataPanel title="Provider connections" rows={snapshot.providers} fields={["displayName", "type", "status"]} />
        <DataPanel title="Bucket connections" rows={snapshot.buckets} fields={["bucketName", "providerConnectionId", "status"]} />
        <DataPanel title="Namespaces" rows={snapshot.namespaces} fields={["name", "slug", "status", "quotaBytes"]} />
        <DataPanel title="Audit log terbaru" rows={snapshot.activityLogs} fields={["action", "entityType", "createdAt"]} />
        <MigrationPanel api={api} organizationId={organizationId} snapshot={snapshot} onChanged={refreshMigrations} />
      </section>
    </main>
  );
}

function UsagePanel({ usage }: { usage: DashboardSnapshot["usage"] }) {
  if (!usage) {
    return <article className="data-panel"><div className="panel-heading"><h2>Usage</h2></div><p className="muted">Usage tidak tersedia untuk permission saat ini.</p></article>;
  }
  const metrics = [
    ["Used", formatBytes(usage.totals.usedBytes)],
    ["Reserved", formatBytes(usage.totals.reservedBytes)],
    ["Egress", formatBytes(usage.totals.egressBytes)],
    ["Requests", usage.totals.requestCount],
  ] as const;
  return <article className="data-panel usage-panel">
    <div className="panel-heading"><h2>Usage organisasi</h2><span>{usage.namespaces.length} namespace</span></div>
    <div className="usage-metrics">{metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    {usage.namespaces.length === 0 ? <p className="muted">Belum ada usage counter.</p> : <div className="table-wrap"><table><thead><tr><th>Namespace</th><th>Used</th><th>Egress</th><th>Requests</th></tr></thead><tbody>{usage.namespaces.map((namespace) => <tr key={namespace.namespaceId}><td>{namespace.name}</td><td>{formatBytes(namespace.usedBytes)}</td><td>{formatBytes(namespace.egressBytes)}</td><td>{namespace.requestCount}</td></tr>)}</tbody></table></div>}
    {usage.nextCursor && <p className="muted">Masih ada namespace lain; gunakan export API untuk halaman berikutnya.</p>}
  </article>;
}

function PlatformSettingsPanel({ api, initialSettings, onChanged }: { api: DashboardApi; initialSettings: PlatformSetting[]; onChanged: (settings: PlatformSetting[]) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(initialSettings.map((setting) => [setting.key, setting.value === null ? "" : String(setting.value)])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function update(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    const payload: Record<string, unknown> = {};
    for (const setting of initialSettings) {
      const raw = values[setting.key] ?? "";
      if (setting.key === "maintenance_mode") payload[setting.key] = raw === "true";
      else if (setting.key === "default_transfer_mode") payload[setting.key] = raw;
      else if (setting.key === "default_max_object_size_bytes") payload[setting.key] = raw === "" ? null : raw;
      else if (setting.key === "proxy_max_object_size_bytes") payload[setting.key] = raw;
      else if (setting.key === "default_quota_bytes") payload[setting.key] = raw;
      else payload[setting.key] = Number(raw);
    }
    try {
      const expectedVersions = Object.fromEntries(initialSettings.map((setting) => [setting.key, setting.version]));
      const updated = await api.updatePlatformSettings(payload, expectedVersions);
      onChanged(updated);
      setMessage("Global settings tersimpan dan tercatat di audit log.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Settings gagal disimpan"); }
    finally { setBusy(false); }
  }

  return <article className="data-panel platform-settings-panel">
    <div className="panel-heading"><h2>Global Settings</h2><span>platform admin</span></div>
    <p className="muted">Policy runtime berlaku setelah API/worker restart. Database URL, key encryption, Redis, TLS, dan egress firewall tetap deployment-only.</p>
    <form onSubmit={save} className="settings-form">
      {initialSettings.map((setting) => <label key={setting.key}>{setting.key}{platformSettingDescription(setting.key) && <small className="muted"> ({platformSettingDescription(setting.key)})</small>}
        {setting.key === "maintenance_mode" ? <select value={values[setting.key] ?? "false"} onChange={(event) => update(setting.key, event.target.value)}><option value="false">false</option><option value="true">true</option></select> : setting.key === "default_transfer_mode" ? <select value={values[setting.key] ?? "DIRECT"} onChange={(event) => update(setting.key, event.target.value)}><option value="DIRECT">DIRECT</option><option value="PROXIED">PROXIED</option></select> : <input inputMode={setting.key.includes("bytes") || setting.key.includes("seconds") || setting.key.includes("in_flight") || setting.key.includes("concurrent") ? "numeric" : undefined} value={values[setting.key] ?? ""} onChange={(event) => update(setting.key, event.target.value)} required={setting.key !== "default_max_object_size_bytes"} />}
      </label>)}
      <button type="submit" disabled={busy}>{busy ? "Menyimpan…" : "Simpan global settings"}</button>
    </form>
    {message && <p className="muted" role="status">{message}</p>}
  </article>;
}

function ProviderCreatePanel({ api, organizationId, onChanged }: { api: DashboardApi; organizationId: string; onChanged: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState("MINIO");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [addressingMode, setAddressingMode] = useState("AUTO");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    setBusy(true); setMessage(null);
    try {
      await api.createProvider(organizationId, { displayName, type, endpoint, region, addressingMode, accessKeyId, secretAccessKey });
      setDisplayName(""); setEndpoint(""); setAccessKeyId(""); setSecretAccessKey(""); setMessage("Provider tersimpan. Credential secret tidak ditampilkan kembali."); await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider gagal dibuat"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Tambah provider</h2></div><form onSubmit={submit} className="compact-form">
    <input placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
    <select value={type} onChange={(event) => setType(event.target.value)}><option>MINIO</option><option>GENERIC_S3</option><option>AWS_S3</option><option>CLOUDFLARE_R2</option><option>BACKBLAZE_B2</option></select>
    <input type="url" placeholder="https://provider.example" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required />
    <input placeholder="Region" value={region} onChange={(event) => setRegion(event.target.value)} required />
    <select value={addressingMode} onChange={(event) => setAddressingMode(event.target.value)}><option>AUTO</option><option>VIRTUAL_HOSTED</option><option>PATH_STYLE</option></select>
    <input autoComplete="off" placeholder="Access key ID" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required />
    <input type="password" autoComplete="new-password" placeholder="Secret access key" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} required />
    <button type="submit" disabled={busy || !organizationId}>{busy ? "Menyimpan…" : "Tambah provider"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function BucketImportPanel({ api, organizationId, providers, onChanged }: { api: DashboardApi; organizationId: string; providers: Array<Record<string, unknown>>; onChanged: () => Promise<void> }) {
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    setBusy(true); setMessage(null);
    try { await api.importBucket(organizationId, { providerConnectionId, bucketName }); setBucketName(""); setMessage("Bucket berhasil di-import."); await onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Bucket gagal di-import"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Import bucket</h2></div><form onSubmit={submit} className="compact-form">
    <select value={providerConnectionId} onChange={(event) => setProviderConnectionId(event.target.value)} required><option value="">Pilih provider</option>{providers.map((provider) => <option key={String(provider.id)} value={String(provider.id)}>{display(provider.displayName)}</option>)}</select>
    <input placeholder="Bucket name" value={bucketName} onChange={(event) => setBucketName(event.target.value)} required />
    <button type="submit" disabled={busy || !organizationId}>{busy ? "Mengimpor…" : "Import bucket"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function NamespaceCreatePanel({ api, organizationId, onChanged }: { api: DashboardApi; organizationId: string; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(""); const [slug, setSlug] = useState(""); const [quotaBytes, setQuotaBytes] = useState("10737418240"); const [maxObjectSizeBytes, setMaxObjectSizeBytes] = useState(""); const [defaultTransferMode, setDefaultTransferMode] = useState("DIRECT"); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    setBusy(true); setMessage(null);
    try { await api.createNamespace(organizationId, { name, slug, quotaBytes, maxObjectSizeBytes: maxObjectSizeBytes || null, defaultTransferMode, versioningMode: "DISABLED" }); setName(""); setSlug(""); setMessage("Namespace berhasil dibuat."); await onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Namespace gagal dibuat"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Tambah namespace</h2></div><form onSubmit={submit} className="compact-form">
    <input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} required /><input placeholder="slug" pattern="[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?" value={slug} onChange={(event) => setSlug(event.target.value)} required />
    <input inputMode="numeric" placeholder="Quota bytes" value={quotaBytes} onChange={(event) => setQuotaBytes(event.target.value)} required /><input inputMode="numeric" placeholder="Max object bytes (optional)" value={maxObjectSizeBytes} onChange={(event) => setMaxObjectSizeBytes(event.target.value)} />
    <select value={defaultTransferMode} onChange={(event) => setDefaultTransferMode(event.target.value)}><option>DIRECT</option><option>PROXIED</option></select><button type="submit" disabled={busy || !organizationId}>{busy ? "Menyimpan…" : "Tambah namespace"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function PlacementPolicyPanel({ api, organizationId, namespaces, buckets, onChanged }: { api: DashboardApi; organizationId: string; namespaces: Array<Record<string, unknown>>; buckets: Array<Record<string, unknown>>; onChanged: () => Promise<void> }) {
  const [namespaceId, setNamespaceId] = useState(""); const [bucketConnectionId, setBucketConnectionId] = useState(""); const [priorityTier, setPriorityTier] = useState("0"); const [weight, setWeight] = useState("100"); const [thresholdPercent, setThresholdPercent] = useState("100"); const [capacity, setCapacity] = useState(""); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    const namespace = namespaces.find((row) => row.id === namespaceId);
    const policy = namespace?.placementPolicy as { targets?: Array<Record<string, unknown>> } | undefined;
    const existingTargets = Array.isArray(policy?.targets) ? policy.targets : [];
    const targets = existingTargets.filter((target) => target.bucketConnectionId !== bucketConnectionId).map((target) => ({ bucketConnectionId: String(target.bucketConnectionId), priorityTier: Number(target.priorityTier ?? 0), weight: Number(target.weight ?? 100), configuredCapacityBytes: target.configuredCapacityBytes === null ? null : String(target.configuredCapacityBytes ?? ""), thresholdPercent: Number(target.thresholdPercent ?? 100), enabled: target.enabled !== false }));
    targets.push({ bucketConnectionId, priorityTier: Number(priorityTier), weight: Number(weight), configuredCapacityBytes: capacity || null, thresholdPercent: Number(thresholdPercent), enabled: true });
    setBusy(true); setMessage(null);
    try { await api.updatePlacementPolicy(organizationId, namespaceId, { strategy: "PRIORITY_WEIGHTED", status: "ACTIVE", targets }); setMessage("Placement policy tersimpan."); await onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Placement policy gagal disimpan"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Placement policy</h2></div><form onSubmit={submit} className="compact-form">
    <select value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} required><option value="">Pilih namespace</option>{namespaces.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.name ?? row.slug)}</option>)}</select>
    <select value={bucketConnectionId} onChange={(event) => setBucketConnectionId(event.target.value)} required><option value="">Pilih target bucket</option>{buckets.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.bucketName)}</option>)}</select>
    <input inputMode="numeric" placeholder="Priority tier" value={priorityTier} onChange={(event) => setPriorityTier(event.target.value)} required /><input inputMode="numeric" placeholder="Weight" value={weight} onChange={(event) => setWeight(event.target.value)} required />
    <input inputMode="numeric" placeholder="Threshold %" value={thresholdPercent} onChange={(event) => setThresholdPercent(event.target.value)} required /><input inputMode="numeric" placeholder="Capacity bytes (optional)" value={capacity} onChange={(event) => setCapacity(event.target.value)} />
    <button type="submit" disabled={busy || !organizationId}>{busy ? "Menyimpan…" : "Simpan target"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function MembersPanel({ api, organizationId, members, roles, onChanged }: { api: DashboardApi; organizationId: string; members: Array<Record<string, unknown>>; roles: Array<Record<string, unknown>>; onChanged: () => Promise<void> }) {
  const [email, setEmail] = useState(""); const [roleId, setRoleId] = useState(""); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setMessage(null); try { await api.addMember(organizationId, { email, ...(roleId ? { roleId } : {}) }); setEmail(""); setMessage("Member ditambahkan sebagai INVITED."); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Member gagal ditambahkan"); } finally { setBusy(false); } }
  async function toggle(member: Record<string, unknown>) { const next = member.status === "ACTIVE" ? "DISABLED" : "ACTIVE"; setBusy(true); try { await api.updateMemberStatus(organizationId, String(member.id), next); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Status member gagal diubah"); } finally { setBusy(false); } }
  return <article className="data-panel"><div className="panel-heading"><h2>Members & roles</h2><span>{members.length}</span></div><form onSubmit={add} className="compact-form"><input type="email" placeholder="Existing user email" value={email} onChange={(event) => setEmail(event.target.value)} required /><select value={roleId} onChange={(event) => setRoleId(event.target.value)}><option value="">Tanpa role</option>{roles.map((role) => <option key={String(role.id)} value={String(role.id)}>{display(role.name)}</option>)}</select><button type="submit" disabled={busy || !organizationId}>{busy ? "Memproses…" : "Tambah member"}</button></form>{members.length === 0 ? <p className="muted">Belum ada member tambahan.</p> : <div className="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Roles</th><th /></tr></thead><tbody>{members.map((member) => <tr key={String(member.id)}><td>{display(member.email)}</td><td>{display(member.status)}</td><td>{Array.isArray(member.roles) ? member.roles.join(", ") : "—"}</td><td><button className="button-secondary" onClick={() => void toggle(member)} disabled={busy}>{member.status === "ACTIVE" ? "Disable" : "Activate"}</button></td></tr>)}</tbody></table></div>}{message && <p className="muted" role="status">{message}</p>}</article>;
}

function CredentialGrantPanel({ api, organizationId, namespaces, credentials, grants, onChanged }: { api: DashboardApi; organizationId: string; namespaces: Array<Record<string, unknown>>; credentials: Array<Record<string, unknown>>; grants: Array<Record<string, unknown>>; onChanged: () => Promise<void> }) {
  const [namespaceId, setNamespaceId] = useState(""); const [credentialId, setCredentialId] = useState(""); const [prefix, setPrefix] = useState(""); const [secret, setSecret] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function createCredential(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setMessage(null); try { const result = await api.createCredential(organizationId, { namespaceId, expiresAt: null }); setSecret(result.secret); setMessage("Credential dibuat. Simpan secret ini sekarang; secret tidak akan ditampilkan lagi."); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Credential gagal dibuat"); } finally { setBusy(false); } }
  async function createGrant(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setMessage(null); try { const credential = credentials.find((row) => row.id === credentialId); const credentialNamespace = credential?.namespace as Record<string, unknown> | undefined; await api.createFolderGrant(organizationId, { namespaceId: String(credentialNamespace?.id ?? namespaceId), principalType: "API_CREDENTIAL", principalId: credentialId, prefix, actions: ["list", "read", "write", "delete"] }); setPrefix(""); setMessage("Folder grant dibuat."); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Grant gagal dibuat"); } finally { setBusy(false); } }
  async function revoke(id: string) { setBusy(true); try { await api.revokeCredential(organizationId, id); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Credential gagal dicabut"); } finally { setBusy(false); } }
  async function removeGrant(id: string) { setBusy(true); try { await api.deleteFolderGrant(organizationId, id); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Grant gagal dihapus"); } finally { setBusy(false); } }
  return <article className="data-panel"><div className="panel-heading"><h2>API credentials & grants</h2><span>{credentials.length}</span></div><form onSubmit={createCredential} className="compact-form"><select value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} required><option value="">Namespace credential</option>{namespaces.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.name ?? row.slug)}</option>)}</select><button type="submit" disabled={busy || !organizationId}>{busy ? "Membuat…" : "Buat credential"}</button></form>{secret && <p className="secret-output" role="status">Secret sekali tampil: <code>{secret}</code></p>}<form onSubmit={createGrant} className="compact-form"><select value={credentialId} onChange={(event) => setCredentialId(event.target.value)} required><option value="">Credential grant</option>{credentials.filter((row) => row.status === "ACTIVE").map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.keyId)}</option>)}</select><input placeholder="Prefix (optional)" value={prefix} onChange={(event) => setPrefix(event.target.value)} /><button type="submit" disabled={busy || !organizationId}>{busy ? "Memproses…" : "Tambah grant"}</button></form>{credentials.length > 0 && <div className="table-wrap"><table><thead><tr><th>Key ID</th><th>Status</th><th>Namespace</th><th /></tr></thead><tbody>{credentials.map((credential) => <tr key={String(credential.id)}><td>{display(credential.keyId)}</td><td>{display(credential.status)}</td><td>{display((credential.namespace as Record<string, unknown> | undefined)?.slug)}</td><td>{credential.status === "ACTIVE" && <button className="button-danger" onClick={() => void revoke(String(credential.id))} disabled={busy}>Revoke</button>}</td></tr>)}</tbody></table></div>}{grants.length > 0 && <div className="table-wrap"><table><thead><tr><th>Principal</th><th>Prefix</th><th>Actions</th><th /></tr></thead><tbody>{grants.map((grant) => <tr key={String(grant.id)}><td>{display(grant.principalId)}</td><td>{display(grant.prefix)}</td><td>{Array.isArray(grant.actions) ? grant.actions.join(", ") : "—"}</td><td><button className="button-danger" onClick={() => void removeGrant(String(grant.id))} disabled={busy}>Delete</button></td></tr>)}</tbody></table></div>}{message && <p className="muted" role="status">{message}</p>}</article>;
}

function MigrationPanel({ api, organizationId, snapshot, onChanged }: { api: DashboardApi; organizationId: string; snapshot: DashboardSnapshot; onChanged: () => Promise<void> }) {
  const [namespaceId, setNamespaceId] = useState("");
  const [sourceBucketConnectionId, setSourceBucketConnectionId] = useState("");
  const [targetBucketConnectionId, setTargetBucketConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      await api.createMigration(organizationId, { namespaceId, sourceBucketConnectionId, targetBucketConnectionId });
      setMessage("Migration dibuat dalam status CREATED.");
      await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Migration gagal dibuat"); }
    finally { setBusy(false); }
  }
  async function control(id: string, action: "start" | "pause" | "cancel") {
    setBusy(true); setMessage(null);
    try { await api.controlMigration(organizationId, id, action); await onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Perubahan migration gagal"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel migration-panel">
    <div className="panel-heading"><h2>Cross-provider migration</h2><span>{snapshot.migrations.length}</span></div>
    <form onSubmit={create} className="migration-form">
      <select aria-label="Namespace" value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} required><option value="">Namespace</option>{snapshot.namespaces.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.name ?? row.slug)}</option>)}</select>
      <select aria-label="Source bucket" value={sourceBucketConnectionId} onChange={(event) => setSourceBucketConnectionId(event.target.value)} required><option value="">Source bucket</option>{snapshot.buckets.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.bucketName)}</option>)}</select>
      <select aria-label="Target bucket" value={targetBucketConnectionId} onChange={(event) => setTargetBucketConnectionId(event.target.value)} required><option value="">Target bucket</option>{snapshot.buckets.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.bucketName)}</option>)}</select>
      <button type="submit" disabled={busy}>Buat run</button>
    </form>
    {message && <p className="muted" role="status">{message}</p>}
    {snapshot.migrations.length === 0 ? <p className="muted">Belum ada migration.</p> : <div className="migration-list">{snapshot.migrations.slice(0, 8).map((row, index) => <div className="migration-row" key={String(row.id ?? index)}><span><strong>{display(row.state)}</strong><small>{display(row.completedItems)} / {display(row.totalItems)} object</small></span><span className="migration-actions">{row.state === "CREATED" || row.state === "PAUSED" ? <button onClick={() => control(String(row.id), "start")} disabled={busy}>Start</button> : null}{row.state === "RUNNING" ? <button className="button-secondary" onClick={() => control(String(row.id), "pause")} disabled={busy}>Pause</button> : null}{["CREATED", "RUNNING", "PAUSED"].includes(String(row.state)) ? <button className="button-danger" onClick={() => control(String(row.id), "cancel")} disabled={busy}>Cancel</button> : null}</span></div>)}</div>}
  </article>;
}

function DataPanel({ title, rows, fields }: { title: string; rows: Array<Record<string, unknown>>; fields: string[] }) {
  return (
    <article className="data-panel">
      <div className="panel-heading"><h2>{title}</h2><span>{rows.length}</span></div>
      {rows.length === 0 ? <p className="muted">Belum ada data atau permission belum diberikan.</p> : (
        <div className="table-wrap"><table><thead><tr>{fields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>
          {rows.slice(0, 8).map((row, index) => <tr key={String(row.id ?? index)}>{fields.map((field) => <td key={field}>{field === "status" ? <span className={statusClass(row[field])}>{display(row[field])}</span> : display(row[field])}</td>)}</tr>)}
        </tbody></table></div>
      )}
    </article>
  );
}
