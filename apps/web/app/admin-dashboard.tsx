"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  FormEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  DashboardApi,
  type AuthUser,
  type BucketBrowserListing,
  type BucketBrowserObject,
  type DashboardSnapshot,
  type ObjectExplorerNamespace,
  type ObjectExplorerObject,
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
  return platformSettingInfo[key]?.help ?? null;
}

const platformSettingInfo: Record<string, { label: string; help: string }> = {
  maintenance_mode: {
    label: "Maintenance mode",
    help: "Alihkan operasi aplikasi ke mode pemeliharaan; gunakan hanya saat ada pekerjaan terjadwal.",
  },
  default_quota_bytes: {
    label: "Default quota (bytes)",
    help: "Quota awal untuk namespace baru. Isi bilangan bulat dalam bytes, misalnya 10737418240 untuk 10 GiB.",
  },
  default_max_object_size_bytes: {
    label: "Default max object size (bytes)",
    help: "Batas ukuran object untuk namespace baru. Kosongkan jika tidak ingin memberi batas default.",
  },
  default_transfer_mode: {
    label: "Default transfer mode",
    help: "DIRECT mengarahkan client ke object storage; PROXIED melewatkan transfer melalui API.",
  },
  proxy_max_object_size_bytes: {
    label: "Proxy max object size (bytes)",
    help: "Batas object yang boleh melewati API proxy; 1 byte–1 GiB dan berlaku setelah API restart.",
  },
  proxy_transfer_timeout_seconds: {
    label: "Proxy transfer timeout (seconds)",
    help: "Batas waktu transfer melalui API, 10–300 detik; berlaku setelah API restart.",
  },
  storage_max_in_flight: {
    label: "Storage max in-flight",
    help: "Jumlah maksimum operasi storage yang berjalan bersamaan. Isi angka 1–10.000.",
  },
  migration_max_concurrent_per_provider: {
    label: "Migration concurrency per provider",
    help: "Jumlah object migration yang diproses bersamaan untuk satu provider. Isi angka 1–20.",
  },
  migration_retry_delay_seconds: {
    label: "Migration retry delay (seconds)",
    help: "Jeda sebelum object migration yang gagal dicoba ulang. Isi angka 1–86.400 detik.",
  },
  provider_health_check_interval_seconds: {
    label: "Provider health check interval (seconds)",
    help: "Interval pemeriksaan kesehatan provider. Isi angka 5–86.400 detik.",
  },
};

const tableFieldLabels: Record<string, string> = {
  action: "Action",
  bucketName: "Bucket name",
  createdAt: "Created at",
  displayName: "Display name",
  entityType: "Entity type",
  name: "Name",
  providerConnectionId: "Provider connection",
  quotaBytes: "Quota (bytes)",
  slug: "Slug",
  status: "Status",
  type: "Provider type",
};

function tableFieldLabel(field: string): string {
  return tableFieldLabels[field] ?? field;
}

function FormField({ label, help, children, className }: { label: string; help: string; children: ReactNode; className?: string }) {
  return <label className={className ? `form-field ${className}` : "form-field"}>
    <span className="field-label">{label}</span>
    <small className="field-help">{help}</small>
    {children}
  </label>;
}

function PanelDescription({ children }: { children: ReactNode }) {
  return <p className="panel-description">{children}</p>;
}

function Modal({ label, onClose, children, compact = false }: { label: string; onClose: () => void; children: ReactNode; compact?: boolean }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={compact ? "modal-dialog modal-dialog-compact" : "modal-dialog"} role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="modal-close" onClick={onClose} aria-label="Tutup modal">×</button>
      {children}
    </div>
  </div>;
}

const navigation = [
  { href: "/dashboard", label: "Dashboard", description: "Ringkasan operasional" },
  { href: "/providers", label: "Providers", description: "Hubungkan object storage" },
  { href: "/buckets", label: "Buckets", description: "Import bucket provider" },
  { href: "/bucket-browser", label: "Bucket Browser", description: "Lihat data existing bucket" },
  { href: "/namespaces", label: "Namespaces", description: "Buat ruang logical" },
  { href: "/file-explorer", label: "File Explorer", description: "Jelajahi object namespace" },
  { href: "/placement-policy", label: "Placement Policy", description: "Atur target penyimpanan" },
  { href: "/api-credentials", label: "API Credentials", description: "Beri akses aplikasi" },
  { href: "/members", label: "Members & Roles", description: "Kelola akses user" },
  { href: "/migrations", label: "Migrations", description: "Pindahkan object" },
  { href: "/audit-log", label: "Audit Log", description: "Tinjau aktivitas" },
  { href: "/settings", label: "Settings", description: "Konfigurasi platform" },
] as const;

const organizationStorageKey = "mosp_organization_id";

interface AdminContextValue {
  api: DashboardApi;
  organizationId: string;
  platformAdmin: boolean;
  platformSettings: PlatformSetting[];
  refreshDashboard: () => Promise<void>;
  setPlatformSettings: (settings: PlatformSetting[]) => void;
  snapshot: DashboardSnapshot;
}

const AdminContext = createContext<AdminContextValue | null>(null);

function useAdminContext(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("Admin page must be rendered inside AdminDashboard");
  return value;
}

export default function AdminDashboard({ children }: { children: ReactNode }) {
  const api = useMemo(() => new DashboardApi(), []);
  const pathname = usePathname();
  const restoreAttempted = useRef(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [organizations, setOrganizations] = useState<PlatformOrganization[]>([]);
  const [platformSettings, setPlatformSettings] = useState<PlatformSetting[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadSnapshot(targetOrganizationId: string, showLoading = true) {
    if (!targetOrganizationId) {
      setError("Organization ID wajib diisi.");
      return;
    }
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.snapshot(targetOrganizationId));
      window.localStorage.setItem(organizationStorageKey, targetOrganizationId);
    } catch (loadError) {
      setSnapshot(emptySnapshot);
      setError(loadError instanceof Error ? loadError.message : "Data dashboard gagal dimuat");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function initializeAuthenticatedUser(authenticatedUser: AuthUser) {
    setUser(authenticatedUser);
    let targetOrganizationId = window.localStorage.getItem(organizationStorageKey) ?? "";

    try {
      const [platformOrganizations, settings] = await Promise.all([
        api.platformOrganizations(),
        api.platformSettings(),
      ]);
      setOrganizations(platformOrganizations);
      setPlatformSettings(settings);
      setPlatformAdmin(true);
      if (!platformOrganizations.some((organization) => organization.id === targetOrganizationId)) {
        targetOrganizationId = platformOrganizations[0]?.id ?? "";
      }
    } catch (platformError) {
      if (!(platformError instanceof Error) || platformError.message !== "forbidden") {
        throw platformError;
      }
      setOrganizations([]);
      setPlatformSettings([]);
      setPlatformAdmin(false);
    }

    setOrganizationId(targetOrganizationId);
    if (targetOrganizationId) await loadSnapshot(targetOrganizationId, false);
  }

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;

    void (async () => {
      try {
        const result = await api.refresh();
        await initializeAuthenticatedUser(result.user);
      } catch (restoreError) {
        api.setAccessToken(null);
        setUser(null);
        if (
          restoreError instanceof Error &&
          !["unauthenticated", "csrf_failed"].includes(restoreError.message)
        ) {
          setError("Session tidak dapat dipulihkan. Silakan masuk kembali.");
        }
      } finally {
        setRestoringSession(false);
      }
    })();
  }, [api]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api.login(email, password);
      await initializeAuthenticatedUser(result.user);
      setPassword("");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login gagal");
    } finally {
      setLoading(false);
    }
  }

  async function handleOrganizationChange(targetOrganizationId: string) {
    setOrganizationId(targetOrganizationId);
    setSnapshot(emptySnapshot);
    if (!targetOrganizationId) {
      window.localStorage.removeItem(organizationStorageKey);
      setError(null);
      return;
    }
    await loadSnapshot(targetOrganizationId);
  }

  async function handleLogout() {
    setLoading(true);
    try {
      await api.logout();
    } catch {
      // Clear the in-memory token even if the network is unavailable.
    } finally {
      window.localStorage.removeItem(organizationStorageKey);
      window.location.href = "/dashboard";
    }
  }

  async function refreshDashboard() {
    if (!organizationId) return;
    await loadSnapshot(organizationId, false);
  }

  if (restoringSession) {
    return (
      <main className="auth-shell">
        <section className="auth-card session-card" aria-live="polite">
          <p className="eyebrow">Control plane</p>
          <h1>Memulihkan session</h1>
          <p className="summary">Memeriksa session yang tersimpan dengan aman…</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="login-title">
          <p className="eyebrow">Control plane</p>
          <h1 id="login-title">Object storage admin</h1>
          <p className="summary">Masuk untuk mengelola provider, bucket, namespace, dan audit log.</p>
          <form onSubmit={handleLogin} className="stack">
            <FormField label="Email" help="Alamat email akun administrator yang sudah terdaftar.">
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
            </FormField>
            <FormField label="Password" help="Password akun administrator. Tidak disimpan oleh halaman ini.">
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </FormField>
            {error && <p className="error" role="alert">{error}</p>}
            <button type="submit" disabled={loading}>{loading ? "Memproses…" : "Masuk"}</button>
          </form>
          <p className="security-note">Token akses hanya disimpan di memory tab ini. Refresh token dikelola oleh cookie HttpOnly.</p>
        </section>
      </main>
    );
  }

  const currentNavigation = navigation.find((item) => item.href === pathname) ?? navigation[0];

  return (
    <main className="admin-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">MO</span>
          <div><strong>Object Storage</strong><small>Control plane</small></div>
        </div>
        <nav className="sidebar-nav" aria-label="Menu administrasi">
          {navigation.map((item, index) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "sidebar-link sidebar-link-active" : "sidebar-link"}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-user"><small>Masuk sebagai</small><strong>{user.email}</strong></div>
      </aside>
      <section className="dashboard-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Multi-provider object storage</p>
            <h1>{currentNavigation.label}</h1>
            <p className="page-subtitle">{currentNavigation.description}</p>
          </div>
          <div className="user-actions">
            <div className="organization-switcher">
              {platformAdmin && organizations.length > 0 ? (
                <select
                  id="organization-id"
                  value={organizationId}
                  onChange={(event) => void handleOrganizationChange(event.target.value)}
                  disabled={loading}
                  aria-label="Pilih organization"
                >
                  <option value="">Pilih organisasi</option>
                  {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} ({organization.slug})</option>)}
                </select>
              ) : (
                <form onSubmit={(event) => { event.preventDefault(); void handleOrganizationChange(organizationId); }}>
                  <input
                    id="organization-id"
                    value={organizationId}
                    onChange={(event) => setOrganizationId(event.target.value.trim())}
                    placeholder="UUID organization lalu Enter"
                    pattern="[0-9a-fA-F-]{36}"
                    disabled={loading}
                    aria-label="Organization ID"
                    required
                  />
                </form>
              )}
            </div>
            <span className="user-email">{user.email}</span>
            <button className="button-secondary" onClick={handleLogout} disabled={loading}>Keluar</button>
          </div>
        </header>
        {error && <p className="error" role="alert">{error}</p>}
        <AdminContext.Provider value={{ api, organizationId, platformAdmin, platformSettings, refreshDashboard, setPlatformSettings, snapshot }}>
          <div className="page-content" key={user.id}>{children}</div>
        </AdminContext.Provider>
      </section>
    </main>
  );
}

export function DashboardPage() {
  const { snapshot } = useAdminContext();
  const cards = [
    ["Providers", snapshot.providers.length, "Koneksi ke object storage yang terdaftar."],
    ["Buckets", snapshot.buckets.length, "Bucket yang sudah di-import ke control plane."],
    ["Namespaces", snapshot.namespaces.length, "Ruang logical dan quota untuk client."],
    ["Recent events", snapshot.activityLogs.length, "Aktivitas terbaru yang tercatat di audit log."],
    ["Migrations", snapshot.migrations.length, "Run pemindahan object antar bucket/provider."],
  ] as const;
  return <>
    <section className="metric-grid" aria-label="Ringkasan">
      {cards.map(([label, value, help]) => <article className="metric-card" key={label}><span>{label}</span><strong>{value}</strong><small>{help}</small></article>)}
    </section>
    <section className="panel-grid">
      <UsagePanel usage={snapshot.usage} />
      <DataPanel title="Aktivitas terbaru" description="Aktivitas administratif terbaru untuk organisasi yang dipilih." rows={snapshot.activityLogs} fields={["action", "entityType", "createdAt"]} />
    </section>
  </>;
}

export function ProvidersPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  const [createModalOpen, setCreateModalOpen] = useState(false);

  return <>
    <div className="page-toolbar">
      <p className="muted">Kelola seluruh koneksi object storage untuk organisasi yang dipilih.</p>
      <button type="button" onClick={() => setCreateModalOpen(true)} disabled={!organizationId}>Tambah provider</button>
    </div>
    <section className="panel-grid panel-grid-single">
      <DataPanel title="Provider connections" description="Daftar koneksi object storage yang tersedia untuk organisasi ini." rows={snapshot.providers} fields={["displayName", "type", "status"]} />
    </section>
    {createModalOpen && <Modal label="Tambah provider" onClose={() => setCreateModalOpen(false)}>
        <ProviderCreatePanel api={api} organizationId={organizationId} onChanged={refreshDashboard} onCreated={() => setCreateModalOpen(false)} />
    </Modal>}
  </>;
}

export function BucketsPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  const [importModalOpen, setImportModalOpen] = useState(false);

  return <>
    <div className="page-toolbar">
      <p className="muted">Kelola bucket provider yang tersedia untuk namespace organisasi.</p>
      <button type="button" onClick={() => setImportModalOpen(true)} disabled={!organizationId || snapshot.providers.length === 0}>Import bucket</button>
    </div>
    <section className="panel-grid panel-grid-single">
      <DataPanel title="Bucket connections" description="Bucket yang sudah di-import dan status akses terakhirnya." rows={snapshot.buckets} fields={["bucketName", "providerConnectionId", "status"]} />
    </section>
    {importModalOpen && <Modal label="Import bucket" onClose={() => setImportModalOpen(false)}>
      <BucketImportPanel api={api} organizationId={organizationId} providers={snapshot.providers} onChanged={refreshDashboard} onImported={() => setImportModalOpen(false)} />
    </Modal>}
  </>;
}

function bucketBreadcrumbs(prefix: string): Array<{ label: string; prefix: string }> {
  const segments = prefix.split("/").filter(Boolean);
  return segments.map((label, index) => ({
    label,
    prefix: `${segments.slice(0, index + 1).join("/")}/`,
  }));
}

function isFolderMarker(object: BucketBrowserObject): boolean {
  return object.key.endsWith("/") && object.sizeBytes === "0";
}

function directBucketFolders(prefix: string, folders: string[]): Array<{ label: string; prefix: string }> {
  const uniqueFolders = new Map<string, { label: string; prefix: string }>();

  for (const folder of folders) {
    if (!folder.startsWith(prefix)) continue;
    const label = folder.slice(prefix.length).replace(/^\/+|\/+$/g, "").split("/")[0];
    if (!label) continue;
    const folderPrefix = `${prefix}${label}/`;
    uniqueFolders.set(folderPrefix, { label, prefix: folderPrefix });
  }

  return [...uniqueFolders.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function directExplorerFolders(prefix: string, folders: string[]): Array<{ label: string; prefix: string }> {
  return directBucketFolders(prefix, folders);
}

export function BucketBrowserPage() {
  const { api, organizationId, snapshot } = useAdminContext();
  const requestIdRef = useRef(0);
  const bucketOptions = snapshot.buckets
    .map((bucket) => ({
      id: String(bucket.id ?? ""),
      name: String(bucket.bucketName ?? ""),
      status: String(bucket.status ?? ""),
    }))
    .filter((bucket) => bucket.id && bucket.name);
  const activeBuckets = bucketOptions.filter((bucket) => bucket.status === "ACTIVE");
  const [bucketId, setBucketId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState<BucketBrowserListing | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadListing(
    targetBucketId: string,
    targetPrefix: string,
    cursor: string | null = null,
  ) {
    if (!organizationId || !targetBucketId) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setListing(null);
    setMessage(null);
    try {
      const result = await api.listBucketObjects(organizationId, targetBucketId, {
        limit: 100,
        prefix: targetPrefix,
        ...(cursor ? { cursor } : {}),
      });
      if (requestId !== requestIdRef.current) return;
      setListing(result);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      const errorMessage = error instanceof Error ? error.message : "Isi bucket gagal dimuat";
      setMessage(errorMessage === "bucket_access_failed"
        ? "Provider menolak listing object. Pastikan credential memiliki izin s3:ListBucket."
        : errorMessage === "bucket_not_active"
          ? "Bucket harus berstatus ACTIVE sebelum dapat dibuka."
          : errorMessage);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  function openPrefix(targetPrefix: string) {
    setPrefix(targetPrefix);
    setCurrentCursor(null);
    setCursorHistory([]);
    void loadListing(bucketId, targetPrefix);
  }

  useEffect(() => {
    requestIdRef.current += 1;
    setListing(null);
    setPrefix("");
    setCurrentCursor(null);
    setCursorHistory([]);
    setMessage(null);
    setBucketId((current) => activeBuckets.some((bucket) => bucket.id === current)
      ? current
      : activeBuckets[0]?.id ?? "");
  }, [organizationId, snapshot.buckets]);

  useEffect(() => {
    if (bucketId) void loadListing(bucketId, "");
  }, [bucketId]);

  function nextPage() {
    if (!listing?.nextCursor) return;
    const nextCursor = listing.nextCursor;
    setCursorHistory((current) => [...current, currentCursor]);
    setCurrentCursor(nextCursor);
    void loadListing(bucketId, prefix, nextCursor);
  }

  function previousPage() {
    if (cursorHistory.length === 0) return;
    const previousCursor = cursorHistory[cursorHistory.length - 1] ?? null;
    setCursorHistory((current) => current.slice(0, -1));
    setCurrentCursor(previousCursor);
    void loadListing(bucketId, prefix, previousCursor);
  }

  const breadcrumbs = listing ? bucketBreadcrumbs(listing.prefix) : [];
  const visibleFolders = listing ? directBucketFolders(listing.prefix, listing.folders) : [];
  const visibleObjects = listing?.objects
    .filter((object) => !isFolderMarker(object))
    .sort((left, right) => left.key.localeCompare(right.key)) ?? [];

  return <section className="panel-grid">
    <article className="data-panel bucket-browser-panel">
      <div className="panel-heading"><h2>Bucket Browser</h2><span>Physical view</span></div>
      <PanelDescription>Lihat object existing langsung dari bucket provider. Data ini tidak masuk ke namespace atau object index aplikasi.</PanelDescription>
      {bucketOptions.length === 0 ? <p className="muted">Belum ada bucket yang di-import. Import bucket terlebih dahulu dari menu <Link href="/buckets">Buckets</Link>.</p> : <>
        <div className="bucket-browser-toolbar">
          <FormField label="Bucket" help="Hanya bucket ACTIVE yang dapat dibuka."><select value={bucketId} onChange={(event) => { setBucketId(event.target.value); setPrefix(""); setCurrentCursor(null); setCursorHistory([]); }} required><option value="">Pilih bucket</option>{bucketOptions.map((bucket) => <option key={bucket.id} value={bucket.id} disabled={bucket.status !== "ACTIVE"}>{bucket.name}{bucket.status !== "ACTIVE" ? ` (${bucket.status})` : ""}</option>)}</select></FormField>
          <button type="button" className="button-secondary bucket-refresh-button" onClick={() => void loadListing(bucketId, prefix, currentCursor)} disabled={loading || !bucketId}>{loading ? "Memuat…" : "Muat ulang"}</button>
        </div>
        {message && <p className="error" role="alert">{message}</p>}
        {!message && loading && <p className="muted" role="status">Membaca isi bucket langsung dari provider…</p>}
        {listing && <>
          <nav className="bucket-breadcrumbs" aria-label="Lokasi bucket">
            <button type="button" className="bucket-breadcrumb" onClick={() => openPrefix("")} aria-current={listing.prefix ? undefined : "page"}>
              <span className="bucket-folder-icon bucket-root-icon" aria-hidden="true" />
              <span>{listing.bucket.name}</span>
            </button>
            {breadcrumbs.map((breadcrumb) => <span className="bucket-breadcrumb-segment" key={breadcrumb.prefix}>
              <span className="bucket-breadcrumb-separator" aria-hidden="true">›</span>
              <button type="button" className="bucket-breadcrumb" onClick={() => openPrefix(breadcrumb.prefix)} aria-current={breadcrumb.prefix === listing.prefix ? "page" : undefined}>{breadcrumb.label}</button>
            </span>)}
          </nav>
          {visibleFolders.length > 0 || visibleObjects.length > 0 ? <section className="bucket-drive-section" aria-labelledby="bucket-items-heading">
            <div className="bucket-items-heading"><h3 id="bucket-items-heading">Isi folder</h3><span>{visibleFolders.length + visibleObjects.length} item</span></div>
            <div className="table-wrap bucket-files-table"><table><caption className="sr-only">Isi bucket {listing.bucket.name}</caption><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Storage class</th></tr></thead><tbody>
              {visibleFolders.map((folder) => <tr className="bucket-folder-row" key={folder.prefix}>
                <td className="object-key"><button type="button" className="bucket-item-button" onClick={() => openPrefix(folder.prefix)} title={`Buka ${folder.label}`}><span className="bucket-folder-icon" aria-hidden="true" /><span>{folder.label}</span></button></td>
                <td>Folder</td><td>—</td><td>—</td><td>—</td>
              </tr>)}
              {visibleObjects.map((object) => {
              const label = object.key.startsWith(listing.prefix) ? object.key.slice(listing.prefix.length) : object.key;
              return <tr key={object.key}><td className="object-key" title={object.key}><span className="bucket-file-icon" aria-hidden="true" />{label || object.key}</td><td>File</td><td>{formatBytes(object.sizeBytes)}</td><td>{object.lastModified ? new Date(object.lastModified).toLocaleString() : "—"}</td><td>{display(object.storageClass)}</td></tr>;
            })}</tbody></table></div>
          </section> : <p className="bucket-empty-state muted">Folder ini kosong.</p>}
          <div className="browser-pagination">
            <button type="button" className="button-secondary" onClick={previousPage} disabled={loading || cursorHistory.length === 0}>Sebelumnya</button>
            <span>Halaman {cursorHistory.length + 1}</span>
            <button type="button" className="button-secondary" onClick={nextPage} disabled={loading || !listing.nextCursor}>Berikutnya</button>
          </div>
        </>}
        {activeBuckets.length === 0 && <p className="muted">Tidak ada bucket ACTIVE yang dapat dibuka.</p>}
      </>}
    </article>
  </section>;
}

export function FileExplorerPage() {
  const { api, organizationId } = useAdminContext();
  const [namespaces, setNamespaces] = useState<ObjectExplorerNamespace[]>([]);
  const [namespaceSlug, setNamespaceSlug] = useState("");
  const [prefix, setPrefix] = useState("");
  const [objects, setObjects] = useState<ObjectExplorerObject[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderModalOpen, setNewFolderModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadNamespaces() {
    if (!organizationId) return;
    setMessage(null);
    try {
      const nextNamespaces = await api.listExplorerNamespaces(organizationId);
      setNamespaces(nextNamespaces);
      setNamespaceSlug((current) => current || nextNamespaces[0]?.slug || "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Namespace gagal dimuat");
    }
  }

  async function loadObjects(event?: FormEvent<HTMLFormElement>) {
    return loadObjectsForPrefix(prefix, event);
  }

  async function loadObjectsForPrefix(requestedPrefix: string, event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!organizationId || !namespaceSlug) return;
    setLoading(true);
    setMessage(null);
    try {
      const normalizedPrefix = requestedPrefix.trim();
      const [nextObjects, nextFolders] = await Promise.all([
        api.listExplorerObjects(organizationId, namespaceSlug, normalizedPrefix),
        api.listExplorerFolders(organizationId, namespaceSlug, normalizedPrefix),
      ]);
      setObjects(nextObjects);
      setFolders(nextFolders);
    } catch (error) {
      setObjects([]);
      setMessage(error instanceof Error ? error.message : "Object gagal dimuat");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setObjects([]);
    setFolders([]);
    setNamespaceSlug("");
    void loadNamespaces();
  }, [organizationId]);

  useEffect(() => {
    if (namespaceSlug) void loadObjects();
  }, [namespaceSlug]);

  async function download(key: string) {
    if (!organizationId || !namespaceSlug) return;
    setBusyKey(key);
    setMessage(null);
    try {
      const transfer = await api.downloadExplorerObject(organizationId, namespaceSlug, key);
      window.open(transfer.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download gagal dibuat");
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(key: string) {
    if (!organizationId || !namespaceSlug || !window.confirm(`Hapus object ${key}?`)) return;
    setBusyKey(key);
    setMessage(null);
    try {
      await api.deleteExplorerObject(organizationId, namespaceSlug, key);
      setObjects((current) => current.filter((object) => object.key !== key));
      setMessage("Object dihapus dan tercatat di audit log.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Object gagal dihapus");
    } finally {
      setBusyKey(null);
    }
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !namespaceSlug || !newFolderName.trim()) return;
    const parentPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
    const targetPrefix = parentPrefix
      ? `${parentPrefix}/${newFolderName.trim()}`
      : newFolderName.trim();
    setCreatingFolder(true);
    setMessage(null);
    try {
      await api.createExplorerFolder(organizationId, namespaceSlug, targetPrefix);
      setNewFolderName("");
      setNewFolderModalOpen(false);
      await loadObjectsForPrefix(prefix);
      setMessage("Folder berhasil dibuat.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Folder gagal dibuat");
    } finally {
      setCreatingFolder(false);
    }
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !namespaceSlug || !selectedFile) return;
    const targetPrefix = prefix.trim() ? `${prefix.trim().replace(/\/+$/, "")}/` : "";
    const key = `${targetPrefix}${selectedFile.name}`;
    setUploading(true);
    setMessage(null);
    try {
      await api.uploadExplorerObject(organizationId, namespaceSlug, key, selectedFile);
      setSelectedFile(null);
      const fileInput = document.getElementById("explorer-file") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      setUploadModalOpen(false);
      await loadObjectsForPrefix(prefix);
      setMessage(`File ${key} berhasil di-upload.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload file gagal");
    } finally {
      setUploading(false);
    }
  }

  const breadcrumbs = bucketBreadcrumbs(prefix);
  const visibleFolders = directExplorerFolders(prefix, folders);
  const visibleObjects = objects
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key));

  return <section className="panel-grid">
    <article className="data-panel file-explorer-panel bucket-browser-panel">
      <div className="panel-heading"><h2>File Explorer</h2><span>Logical view</span></div>
      <PanelDescription>Jelajahi object berdasarkan namespace logical. Tampilan ini memakai object index aplikasi; download menggunakan URL presigned dan delete dicatat di audit log.</PanelDescription>
      <form onSubmit={loadObjects} className="bucket-browser-toolbar explorer-toolbar">
        <FormField label="Namespace" help="Namespace aktif yang ingin dijelajahi."><select value={namespaceSlug} onChange={(event) => setNamespaceSlug(event.target.value)} required><option value="">Pilih namespace</option>{namespaces.map((namespace) => <option key={namespace.id} value={namespace.slug}>{namespace.name} ({namespace.slug})</option>)}</select></FormField>
        <FormField label="Prefix (optional)" help="Filter awalan key, misalnya camera/2026/. Path traversal dan key tidak aman ditolak API."><input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="folder/" /></FormField>
        <button type="submit" disabled={loading || !namespaceSlug}>{loading ? "Memuat…" : "Muat object"}</button>
      </form>
      <div className="explorer-actions-toolbar">
        <button type="button" onClick={() => { setNewFolderName(""); setNewFolderModalOpen(true); }} disabled={!namespaceSlug}>＋ New folder</button>
        <button type="button" className="button-secondary" onClick={() => { setSelectedFile(null); setUploadModalOpen(true); }} disabled={!namespaceSlug}>↑ Upload file</button>
      </div>
      {message && <p className="muted" role="status">{message}</p>}
      {namespaces.length === 0 ? <p className="muted">Belum ada namespace aktif atau permission objects:list belum diberikan.</p> : <>
        <nav className="bucket-breadcrumbs" aria-label="Lokasi namespace">
          <button type="button" className="bucket-breadcrumb" onClick={() => { setPrefix(""); void loadObjectsForPrefix(""); }} aria-current={prefix ? undefined : "page"}><span className="bucket-folder-icon bucket-root-icon" aria-hidden="true" /><span>{namespaceSlug || "Namespace"}</span></button>
          {breadcrumbs.map((breadcrumb) => <span className="bucket-breadcrumb-segment" key={breadcrumb.prefix}><span className="bucket-breadcrumb-separator" aria-hidden="true">›</span><button type="button" className="bucket-breadcrumb" onClick={() => { setPrefix(breadcrumb.prefix); void loadObjectsForPrefix(breadcrumb.prefix); }} aria-current={breadcrumb.prefix === prefix ? "page" : undefined}>{breadcrumb.label}</button></span>)}
        </nav>
        {visibleFolders.length > 0 || visibleObjects.length > 0 ? <section className="bucket-drive-section" aria-labelledby="explorer-items-heading">
          <div className="bucket-items-heading"><h3 id="explorer-items-heading">Isi folder</h3><span>{visibleFolders.length + visibleObjects.length} item</span></div>
          <div className="table-wrap bucket-files-table"><table><caption className="sr-only">Isi namespace {namespaceSlug}</caption><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Actions</th></tr></thead><tbody>
            {visibleFolders.map((folder) => <tr className="bucket-folder-row" key={folder.prefix}><td className="object-key"><button type="button" className="bucket-item-button" onClick={() => { setPrefix(folder.prefix); void loadObjectsForPrefix(folder.prefix); }} title={`Buka ${folder.label}`}><span className="bucket-folder-icon" aria-hidden="true" /><span>{folder.label}</span></button></td><td>Folder</td><td>—</td><td>—</td><td>—</td></tr>)}
            {visibleObjects.map((object) => { const label = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : object.key; return <tr key={object.key}><td className="object-key" title={object.key}><span className="bucket-file-icon" aria-hidden="true" />{label || object.key}</td><td>{display(object.contentType) || "File"}</td><td>{formatBytes(object.sizeBytes)}</td><td>{new Date(object.modifiedAt).toLocaleString()}</td><td><span className="explorer-actions"><button className="button-secondary" onClick={() => void download(object.key)} disabled={busyKey !== null}>{busyKey === object.key ? "Memproses…" : "Download"}</button><button className="button-danger" onClick={() => void remove(object.key)} disabled={busyKey !== null}>Delete</button></span></td></tr>; })}
          </tbody></table></div>
        </section> : <p className="bucket-empty-state muted">Folder ini kosong.</p>}
      </>}
    </article>
    {newFolderModalOpen && <Modal compact label="New folder" onClose={() => { if (!creatingFolder) setNewFolderModalOpen(false); }}>
      <article className="data-panel explorer-modal-panel">
        <div className="panel-heading"><h2>New folder</h2></div>
        <PanelDescription>Buat folder baru di <strong>{prefix.trim() || "root"}</strong>.</PanelDescription>
        <form onSubmit={createFolder} className="stack">
          <FormField label="Folder name" help="Gunakan satu nama folder tanpa karakter slash."><input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="Untitled folder" pattern="[^/\\]+" required /></FormField>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={() => setNewFolderModalOpen(false)} disabled={creatingFolder}>Batal</button>
            <button type="submit" disabled={creatingFolder || !newFolderName.trim()}>{creatingFolder ? "Membuat…" : "Buat folder"}</button>
          </div>
        </form>
      </article>
    </Modal>}
    {uploadModalOpen && <Modal compact label="Upload file" onClose={() => { if (!uploading) setUploadModalOpen(false); }}>
      <article className="data-panel explorer-modal-panel">
        <div className="panel-heading"><h2>Upload file</h2></div>
        <PanelDescription>Upload ke <strong>{prefix.trim() || "root"}</strong>. Ukuran mengikuti batas namespace dan proxy admin.</PanelDescription>
        <form onSubmit={uploadFile} className="stack">
          <FormField label="Choose file" help={selectedFile ? `${selectedFile.name} · ${formatBytes(String(selectedFile.size))}` : "Pilih satu file dari perangkat Anda."}><input id="explorer-file" type="file" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} required /></FormField>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={() => setUploadModalOpen(false)} disabled={uploading}>Batal</button>
            <button type="submit" disabled={uploading || !selectedFile}>{uploading ? "Meng-upload…" : "Upload"}</button>
          </div>
        </form>
      </article>
    </Modal>}
  </section>;
}

export function NamespacesPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  return <>
    <div className="page-toolbar"><p className="muted">Namespace membatasi quota, transfer mode, credential, dan object access.</p><button type="button" onClick={() => setCreateModalOpen(true)} disabled={!organizationId}>Tambah namespace</button></div>
    <section className="panel-grid panel-grid-single"><DataPanel title="Namespaces" description="Namespace, slug, status, dan quota yang menjadi scope client." rows={snapshot.namespaces} fields={["name", "slug", "status", "quotaBytes"]} /></section>
    {createModalOpen && <Modal label="Tambah namespace" onClose={() => setCreateModalOpen(false)}><NamespaceCreatePanel api={api} organizationId={organizationId} onChanged={refreshDashboard} onCreated={() => setCreateModalOpen(false)} /></Modal>}
  </>;
}

interface PlacementPolicyTableRow {
  bucketName: string;
  capacityBytes: string | null;
  id: string;
  namespaceName: string;
  policyStatus: string;
  priorityTier: number | null;
  providerName: string;
  targetEnabled: boolean | null;
  thresholdPercent: number | null;
  weight: number | null;
}

function placementPolicyTableRows(
  namespaces: Array<Record<string, unknown>>,
  buckets: Array<Record<string, unknown>>,
  providers: Array<Record<string, unknown>>,
): PlacementPolicyTableRow[] {
  const providerNames = new Map(
    providers.map((provider) => [String(provider.id ?? ""), String(provider.displayName ?? provider.id ?? "Unknown provider")]),
  );
  const bucketDetails = new Map(
    buckets.map((bucket) => [String(bucket.id ?? ""), {
      bucketName: String(bucket.bucketName ?? bucket.id ?? "Unknown bucket"),
      providerName: providerNames.get(String(bucket.providerConnectionId ?? "")) ?? "Unknown provider",
    }]),
  );
  const rows: PlacementPolicyTableRow[] = [];

  for (const namespace of namespaces) {
    const namespaceName = String(namespace.name ?? namespace.slug ?? "Unknown namespace");
    const policy = namespace.placementPolicy && typeof namespace.placementPolicy === "object"
      ? namespace.placementPolicy as Record<string, unknown>
      : null;
    const targets = Array.isArray(policy?.targets)
      ? policy.targets.filter((target): target is Record<string, unknown> => Boolean(target) && typeof target === "object")
      : [];
    const policyStatus = String(policy?.status ?? "NOT CONFIGURED");

    if (targets.length === 0) {
      rows.push({
        bucketName: "Belum ada target",
        capacityBytes: null,
        id: `${String(namespace.id ?? namespaceName)}-empty`,
        namespaceName,
        policyStatus,
        priorityTier: null,
        providerName: "—",
        targetEnabled: null,
        thresholdPercent: null,
        weight: null,
      });
      continue;
    }

    targets.forEach((target, index) => {
      const bucketConnectionId = String(target.bucketConnectionId ?? "");
      const bucket = bucketDetails.get(bucketConnectionId);
      rows.push({
        bucketName: bucket?.bucketName ?? `Unknown (${bucketConnectionId.slice(0, 8)}…)`,
        capacityBytes: target.configuredCapacityBytes === null || target.configuredCapacityBytes === undefined
          ? null
          : String(target.configuredCapacityBytes),
        id: String(target.id ?? `${String(namespace.id ?? namespaceName)}-${bucketConnectionId}-${index}`),
        namespaceName,
        policyStatus,
        priorityTier: Number(target.priorityTier ?? 0),
        providerName: bucket?.providerName ?? "Unknown provider",
        targetEnabled: target.enabled !== false,
        thresholdPercent: Number(target.thresholdPercent ?? 100),
        weight: Number(target.weight ?? 100),
      });
    });
  }

  return rows.sort((left, right) => left.namespaceName.localeCompare(right.namespaceName)
    || (left.priorityTier ?? Number.MAX_SAFE_INTEGER) - (right.priorityTier ?? Number.MAX_SAFE_INTEGER)
    || left.bucketName.localeCompare(right.bucketName));
}

export function PlacementPolicyPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const policyRows = placementPolicyTableRows(snapshot.namespaces, snapshot.buckets, snapshot.providers);
  const targetCount = policyRows.filter((row) => row.targetEnabled !== null).length;
  return <>
    <div className="page-toolbar"><p className="muted">Atur target bucket, prioritas, bobot, dan threshold kapasitas untuk setiap namespace.</p><button type="button" onClick={() => setEditModalOpen(true)} disabled={!organizationId || snapshot.namespaces.length === 0}>Atur placement policy</button></div>
    <section className="panel-grid panel-grid-single"><article className="data-panel"><div className="panel-heading"><h2>Placement policy</h2><span>{targetCount} target</span></div><PanelDescription>Setiap baris menunjukkan target penyimpanan aktual beserta urutan failover, bobot distribusi, dan batas kapasitasnya.</PanelDescription>{snapshot.namespaces.length === 0 ? <p className="muted">Buat namespace terlebih dahulu.</p> : <div className="table-wrap placement-policy-table"><table><caption className="sr-only">Konfigurasi placement policy dan target bucket per namespace</caption><thead><tr><th>Namespace</th><th>Provider</th><th>Target bucket</th><th>Priority tier</th><th>Weight</th><th>Threshold</th><th>Configured capacity</th><th>Policy</th><th>Target</th></tr></thead><tbody>{policyRows.map((row) => <tr key={row.id}><td className="placement-namespace-name">{row.namespaceName}</td><td>{row.providerName}</td><td>{row.bucketName}</td><td>{row.priorityTier ?? "—"}</td><td>{row.weight ?? "—"}</td><td>{row.thresholdPercent === null ? "—" : `${row.thresholdPercent}%`}</td><td>{row.targetEnabled === null ? "—" : row.capacityBytes === null ? "Tanpa batas policy" : formatBytes(row.capacityBytes)}</td><td><span className={statusClass(row.policyStatus)}>{row.policyStatus}</span></td><td>{row.targetEnabled === null ? "—" : <span className={row.targetEnabled ? "status status-ok" : "status status-muted"}>{row.targetEnabled ? "ENABLED" : "DISABLED"}</span>}</td></tr>)}</tbody></table></div>}</article></section>
    {editModalOpen && <Modal label="Atur placement policy" onClose={() => setEditModalOpen(false)}><PlacementPolicyPanel api={api} organizationId={organizationId} namespaces={snapshot.namespaces} buckets={snapshot.buckets} onChanged={refreshDashboard} onSaved={() => setEditModalOpen(false)} /></Modal>}
  </>;
}

export function ApiCredentialsPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  return <section className="panel-grid">
    <CredentialGrantPanel api={api} organizationId={organizationId} namespaces={snapshot.namespaces} credentials={snapshot.credentials} grants={snapshot.grants} onChanged={refreshDashboard} />
  </section>;
}

export function MembersPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  return <section className="panel-grid">
    <MembersPanel api={api} organizationId={organizationId} members={snapshot.members} roles={snapshot.roles} onChanged={refreshDashboard} />
  </section>;
}

export function MigrationsPage() {
  const { api, organizationId, refreshDashboard, snapshot } = useAdminContext();
  return <section className="panel-grid">
    <MigrationPanel api={api} organizationId={organizationId} snapshot={snapshot} onChanged={refreshDashboard} />
  </section>;
}

export function AuditLogPage() {
  const { snapshot } = useAdminContext();
  return <section className="panel-grid">
    <DataPanel title="Audit log terbaru" description="Aktivitas administratif terbaru untuk penelusuran dan review keamanan." rows={snapshot.activityLogs} fields={["action", "entityType", "createdAt"]} />
  </section>;
}

export function SettingsPage() {
  const { api, platformAdmin, platformSettings, setPlatformSettings } = useAdminContext();
  if (!platformAdmin) {
    return <article className="data-panel"><div className="panel-heading"><h2>Global Settings</h2></div><p className="muted">Menu ini memerlukan role Platform Admin.</p></article>;
  }
  return <PlatformSettingsPanel api={api} initialSettings={platformSettings} onChanged={setPlatformSettings} />;
}

function UsagePanel({ usage }: { usage: DashboardSnapshot["usage"] }) {
  if (!usage) {
    return <article className="data-panel"><div className="panel-heading"><h2>Usage organisasi</h2></div><PanelDescription>Ringkasan kapasitas, object, request, dan egress untuk organisasi yang dipilih.</PanelDescription><p className="muted">Usage tidak tersedia untuk permission saat ini.</p></article>;
  }
  const metrics = [
    ["Used", formatBytes(usage.totals.usedBytes), "Bytes yang sudah terpakai oleh object."],
    ["Reserved", formatBytes(usage.totals.reservedBytes), "Quota yang sedang dicadangkan untuk upload."],
    ["Egress", formatBytes(usage.totals.egressBytes), "Bytes yang dikirim keluar melalui storage."],
    ["Requests", usage.totals.requestCount, "Jumlah request storage yang tercatat."],
  ] as const;
  return <article className="data-panel usage-panel">
    <div className="panel-heading"><h2>Usage organisasi</h2><span>{usage.namespaces.length} namespace</span></div>
    <PanelDescription>Ringkasan kapasitas, object, request, dan egress untuk organisasi yang dipilih.</PanelDescription>
    <div className="usage-metrics">{metrics.map(([label, value, help]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{help}</small></div>)}</div>
    {usage.namespaces.length === 0 ? <p className="muted">Belum ada usage counter.</p> : <div className="table-wrap"><table><thead><tr><th>Namespace</th><th>Used</th><th>Egress</th><th>Requests</th></tr></thead><tbody>{usage.namespaces.map((namespace) => <tr key={namespace.namespaceId}><td>{namespace.name}</td><td>{formatBytes(namespace.usedBytes)}</td><td>{formatBytes(namespace.egressBytes)}</td><td>{namespace.requestCount}</td></tr>)}</tbody></table></div>}
    {usage.nextCursor && <p className="muted">Masih ada namespace lain; gunakan export API untuk halaman berikutnya.</p>}
  </article>;
}

function PlatformSettingsPanel({ api, initialSettings, onChanged }: { api: DashboardApi; initialSettings: PlatformSetting[]; onChanged: (settings: PlatformSetting[]) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(initialSettings.map((setting) => [setting.key, setting.value === null ? "" : String(setting.value)])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);

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
      setEditModalOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Settings gagal disimpan"); }
    finally { setBusy(false); }
  }

  return <article className="data-panel platform-settings-panel">
    <div className="panel-heading"><h2>Global Settings</h2><span>platform admin</span></div>
    <PanelDescription>Atur policy runtime yang berlaku lintas organisasi. Nilai di bawah disimpan dan diaudit; sebagian policy baru aktif setelah API/worker restart. Database URL, key encryption, Redis, TLS, dan egress firewall tetap deployment-only.</PanelDescription>
    <div className="settings-summary"><div className="table-wrap"><table><caption className="sr-only">Nilai global settings saat ini</caption><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>{initialSettings.map((setting) => <tr key={setting.key}><td>{platformSettingInfo[setting.key]?.label ?? setting.key}</td><td>{display(values[setting.key])}</td></tr>)}</tbody></table></div></div>
    <div className="panel-actions"><button type="button" onClick={() => setEditModalOpen(true)} disabled={busy}>Edit global settings</button></div>
    {message && <p className="muted" role="status">{message}</p>}
    {editModalOpen && <Modal label="Edit global settings" onClose={() => { if (!busy) setEditModalOpen(false); }}><article className="data-panel"><div className="panel-heading"><h2>Edit global settings</h2></div><form onSubmit={save} className="settings-form">
      {initialSettings.map((setting) => {
        const info = platformSettingInfo[setting.key] ?? { label: setting.key, help: "Policy platform. Isi nilai sesuai kebutuhan deployment." };
        return <FormField key={setting.key} label={info.label} help={platformSettingDescription(setting.key) ?? info.help}>
          {setting.key === "maintenance_mode" ? <select value={values[setting.key] ?? "false"} onChange={(event) => update(setting.key, event.target.value)}><option value="false">false</option><option value="true">true</option></select> : setting.key === "default_transfer_mode" ? <select value={values[setting.key] ?? "DIRECT"} onChange={(event) => update(setting.key, event.target.value)}><option value="DIRECT">DIRECT</option><option value="PROXIED">PROXIED</option></select> : <input inputMode={setting.key.includes("bytes") || setting.key.includes("seconds") || setting.key.includes("in_flight") || setting.key.includes("concurrent") ? "numeric" : undefined} value={values[setting.key] ?? ""} onChange={(event) => update(setting.key, event.target.value)} required={setting.key !== "default_max_object_size_bytes"} />}
        </FormField>;
      })}
      <div className="modal-actions"><button type="button" className="button-secondary" onClick={() => setEditModalOpen(false)} disabled={busy}>Batal</button><button type="submit" disabled={busy}>{busy ? "Menyimpan…" : "Simpan global settings"}</button></div>
    </form></article></Modal>}
  </article>;
}

function ProviderCreatePanel({ api, organizationId, onChanged, onCreated }: { api: DashboardApi; organizationId: string; onChanged: () => Promise<void>; onCreated?: () => void }) {
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
      setDisplayName(""); setEndpoint(""); setAccessKeyId(""); setSecretAccessKey(""); setMessage("Provider tersimpan. Credential secret tidak ditampilkan kembali."); await onChanged(); onCreated?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider gagal dibuat"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Tambah provider</h2></div><PanelDescription>Daftarkan koneksi S3-compatible yang akan dipakai oleh bucket dan namespace. Endpoint wajib HTTPS pada deployment; credential dienkripsi API dan tidak ditampilkan kembali.</PanelDescription><form onSubmit={submit} className="compact-form">
    <FormField label="Display name" help="Nama internal yang mudah dikenali, misalnya CCTV Jakarta."><input autoFocus placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></FormField>
    <FormField label="Provider type" help="Pilih jenis provider. Gunakan GENERIC_S3 untuk layanan S3-compatible lain."><select value={type} onChange={(event) => setType(event.target.value)}><option>MINIO</option><option>GENERIC_S3</option><option>AWS_S3</option><option>CLOUDFLARE_R2</option><option>BACKBLAZE_B2</option></select></FormField>
    <FormField label="Endpoint" help="URL dasar S3, tanpa credential atau query string; contoh https://s3.example.com."><input type="url" placeholder="https://provider.example" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required /></FormField>
    <FormField label="Region" help="Region yang diharapkan oleh provider, misalnya us-east-1 atau region custom."><input placeholder="Region" value={region} onChange={(event) => setRegion(event.target.value)} required /></FormField>
    <FormField label="Addressing mode" help="AUTO mencoba mode yang sesuai; PATH_STYLE umum untuk endpoint S3-compatible custom."><select value={addressingMode} onChange={(event) => setAddressingMode(event.target.value)}><option>AUTO</option><option>VIRTUAL_HOSTED</option><option>PATH_STYLE</option></select></FormField>
    <FormField label="Access key ID" help="Access key dari provider dengan hak minimum untuk bucket yang akan digunakan."><input autoComplete="off" placeholder="Access key ID" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required /></FormField>
    <FormField label="Secret access key" help="Secret pasangan access key. Jangan tempelkan ke chat, log, atau source code."><input type="password" autoComplete="new-password" placeholder="Secret access key" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} required /></FormField>
    <button type="submit" disabled={busy || !organizationId}>{busy ? "Menyimpan…" : "Tambah provider"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function BucketImportPanel({ api, organizationId, providers, onChanged, onImported }: { api: DashboardApi; organizationId: string; providers: Array<Record<string, unknown>>; onChanged: () => Promise<void>; onImported?: () => void }) {
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    setBusy(true); setMessage(null);
    try { await api.importBucket(organizationId, { providerConnectionId, bucketName }); setBucketName(""); setMessage("Bucket berhasil di-import."); await onChanged(); onImported?.(); }
    catch (error) {
      const requestError = error instanceof Error ? error.message : "Bucket gagal di-import";
      setMessage(requestError === "bucket_access_failed"
        ? "API tidak dapat mengakses bucket. Pastikan nama bucket tepat, provider sehat, dan credential memiliki izin s3:HeadBucket."
        : requestError);
    }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Import bucket</h2></div><PanelDescription>Hubungkan bucket yang sudah ada di provider ke control plane agar dapat dipakai oleh namespace. Pilih provider yang credential-nya sudah diuji, lalu isi nama bucket persis seperti di provider.</PanelDescription><form onSubmit={submit} className="compact-form">
    <FormField label="Provider connection" help="Koneksi provider tempat bucket berada. Provider harus sudah terdaftar dan dapat diakses."><select value={providerConnectionId} onChange={(event) => setProviderConnectionId(event.target.value)} required><option value="">Pilih provider</option>{providers.map((provider) => <option key={String(provider.id)} value={String(provider.id)}>{display(provider.displayName)}</option>)}</select></FormField>
    <FormField label="Bucket name" help="Nama bucket yang sudah ada; gunakan nama persis, minimal 3 karakter."><input placeholder="Bucket name" value={bucketName} onChange={(event) => setBucketName(event.target.value)} required /></FormField>
    <button type="submit" disabled={busy || !organizationId}>{busy ? "Mengimpor…" : "Import bucket"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function NamespaceCreatePanel({ api, organizationId, onChanged, onCreated }: { api: DashboardApi; organizationId: string; onChanged: () => Promise<void>; onCreated?: () => void }) {
  const [name, setName] = useState(""); const [slug, setSlug] = useState(""); const [quotaBytes, setQuotaBytes] = useState("10737418240"); const [maxObjectSizeBytes, setMaxObjectSizeBytes] = useState(""); const [defaultTransferMode, setDefaultTransferMode] = useState("DIRECT"); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    setBusy(true); setMessage(null);
    try { await api.createNamespace(organizationId, { name, slug, quotaBytes, maxObjectSizeBytes: maxObjectSizeBytes || null, defaultTransferMode, versioningMode: "DISABLED" }); setName(""); setSlug(""); setMessage("Namespace berhasil dibuat."); await onChanged(); onCreated?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Namespace gagal dibuat"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Tambah namespace</h2></div><PanelDescription>Buat ruang logical untuk isolasi data, quota, dan mode transfer. Namespace menjadi scope utama untuk credential API dan folder grant.</PanelDescription><form onSubmit={submit} className="compact-form">
    <FormField label="Name" help="Nama tampilan namespace untuk administrator."><input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} required /></FormField>
    <FormField label="Slug" help="Identifier URL-safe: huruf kecil, angka, dan tanda hubung; harus unik dalam organisasi."><input placeholder="slug" pattern="[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?" value={slug} onChange={(event) => setSlug(event.target.value)} required /></FormField>
    <FormField label="Quota (bytes)" help="Quota maksimum namespace dalam bytes. Contoh 10737418240 = 10 GiB."><input inputMode="numeric" placeholder="Quota bytes" value={quotaBytes} onChange={(event) => setQuotaBytes(event.target.value)} required /></FormField>
    <FormField label="Max object size (bytes)" help="Batas ukuran satu object; kosongkan bila mengikuti policy default."><input inputMode="numeric" placeholder="Max object bytes (optional)" value={maxObjectSizeBytes} onChange={(event) => setMaxObjectSizeBytes(event.target.value)} /></FormField>
    <FormField label="Default transfer mode" help="DIRECT memakai URL provider; PROXIED melewatkan isi object melalui API."><select value={defaultTransferMode} onChange={(event) => setDefaultTransferMode(event.target.value)}><option>DIRECT</option><option>PROXIED</option></select></FormField><button type="submit" disabled={busy || !organizationId}>{busy ? "Menyimpan…" : "Tambah namespace"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function PlacementPolicyPanel({ api, organizationId, namespaces, buckets, onChanged, onSaved }: { api: DashboardApi; organizationId: string; namespaces: Array<Record<string, unknown>>; buckets: Array<Record<string, unknown>>; onChanged: () => Promise<void>; onSaved?: () => void }) {
  const [namespaceId, setNamespaceId] = useState(""); const [bucketConnectionId, setBucketConnectionId] = useState(""); const [priorityTier, setPriorityTier] = useState("0"); const [weight, setWeight] = useState("100"); const [thresholdPercent, setThresholdPercent] = useState("100"); const [capacity, setCapacity] = useState(""); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId) return;
    const namespace = namespaces.find((row) => row.id === namespaceId);
    const policy = namespace?.placementPolicy as { targets?: Array<Record<string, unknown>> } | undefined;
    const existingTargets = Array.isArray(policy?.targets) ? policy.targets : [];
    const targets = existingTargets.filter((target) => target.bucketConnectionId !== bucketConnectionId).map((target) => ({ bucketConnectionId: String(target.bucketConnectionId), priorityTier: Number(target.priorityTier ?? 0), weight: Number(target.weight ?? 100), configuredCapacityBytes: target.configuredCapacityBytes === null ? null : String(target.configuredCapacityBytes ?? ""), thresholdPercent: Number(target.thresholdPercent ?? 100), enabled: target.enabled !== false }));
    targets.push({ bucketConnectionId, priorityTier: Number(priorityTier), weight: Number(weight), configuredCapacityBytes: capacity || null, thresholdPercent: Number(thresholdPercent), enabled: true });
    setBusy(true); setMessage(null);
    try { await api.updatePlacementPolicy(organizationId, namespaceId, { strategy: "PRIORITY_WEIGHTED", status: "ACTIVE", targets }); setMessage("Placement policy tersimpan."); await onChanged(); onSaved?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Placement policy gagal disimpan"); }
    finally { setBusy(false); }
  }
  return <article className="data-panel"><div className="panel-heading"><h2>Placement policy</h2></div><PanelDescription>Atur bucket mana yang menerima object dari namespace dan bagaimana prioritas pemilihannya. Policy ini menentukan distribusi dan failover penempatan object.</PanelDescription><form onSubmit={submit} className="compact-form">
    <FormField label="Namespace" help="Namespace yang akan memakai policy penempatan ini."><select value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} required><option value="">Pilih namespace</option>{namespaces.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.name ?? row.slug)}</option>)}</select></FormField>
    <FormField label="Target bucket" help="Bucket provider yang menjadi tujuan penempatan object."><select value={bucketConnectionId} onChange={(event) => setBucketConnectionId(event.target.value)} required><option value="">Pilih target bucket</option>{buckets.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.bucketName)}</option>)}</select></FormField>
    <FormField label="Priority tier" help="Tier prioritas; angka lebih kecil dipilih lebih dahulu."><input inputMode="numeric" placeholder="Priority tier" value={priorityTier} onChange={(event) => setPriorityTier(event.target.value)} required /></FormField>
    <FormField label="Weight" help="Bobot relatif di tier yang sama; angka lebih besar mendapat porsi lebih besar."><input inputMode="numeric" placeholder="Weight" value={weight} onChange={(event) => setWeight(event.target.value)} required /></FormField>
    <FormField label="Threshold (%)" help="Persentase kapasitas saat target dianggap penuh dan pemilihan dialihkan."><input inputMode="numeric" placeholder="Threshold %" value={thresholdPercent} onChange={(event) => setThresholdPercent(event.target.value)} required /></FormField>
    <FormField label="Capacity (bytes)" help="Kapasitas terkonfigurasi untuk perhitungan policy; kosongkan jika tidak dibatasi di policy."><input inputMode="numeric" placeholder="Capacity bytes (optional)" value={capacity} onChange={(event) => setCapacity(event.target.value)} /></FormField>
    <button type="submit" disabled={busy || !organizationId}>{busy ? "Menyimpan…" : "Simpan target"}</button>
  </form>{message && <p className="muted" role="status">{message}</p>}</article>;
}

function MembersPanel({ api, organizationId, members, roles, onChanged }: { api: DashboardApi; organizationId: string; members: Array<Record<string, unknown>>; roles: Array<Record<string, unknown>>; onChanged: () => Promise<void> }) {
  const [email, setEmail] = useState(""); const [roleId, setRoleId] = useState(""); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setMessage(null); try { await api.addMember(organizationId, { email, ...(roleId ? { roleId } : {}) }); setEmail(""); setRoleId(""); setMessage("Member ditambahkan sebagai INVITED."); await onChanged(); setAddModalOpen(false); } catch (error) { setMessage(error instanceof Error ? error.message : "Member gagal ditambahkan"); } finally { setBusy(false); } }
  async function toggle(member: Record<string, unknown>) { const next = member.status === "ACTIVE" ? "DISABLED" : "ACTIVE"; setBusy(true); try { await api.updateMemberStatus(organizationId, String(member.id), next); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Status member gagal diubah"); } finally { setBusy(false); } }
  return <article className="data-panel"><div className="panel-heading"><h2>Members & roles</h2><span>{members.length}</span></div><PanelDescription>Kelola siapa yang dapat mengakses organisasi dan role yang dimilikinya. User harus sudah terdaftar; status awal member baru adalah INVITED.</PanelDescription><div className="panel-actions"><button type="button" onClick={() => setAddModalOpen(true)} disabled={busy || !organizationId}>Tambah member</button></div>{members.length === 0 ? <p className="muted">Belum ada member tambahan.</p> : <div className="table-wrap"><table><caption className="sr-only">Daftar member, status, dan role organisasi</caption><thead><tr><th>Email</th><th>Status</th><th>Roles</th><th /></tr></thead><tbody>{members.map((member) => <tr key={String(member.id)}><td>{display(member.email)}</td><td>{display(member.status)}</td><td>{Array.isArray(member.roles) ? member.roles.join(", ") : "—"}</td><td><button className="button-secondary" onClick={() => void toggle(member)} disabled={busy}>{member.status === "ACTIVE" ? "Disable" : "Activate"}</button></td></tr>)}</tbody></table></div>}{message && <p className="muted" role="status">{message}</p>}{addModalOpen && <Modal compact label="Tambah member" onClose={() => { if (!busy) setAddModalOpen(false); }}><article className="data-panel"><div className="panel-heading"><h2>Tambah member</h2></div><form onSubmit={add} className="stack"><FormField label="Existing user email" help="Email user yang sudah memiliki akun di control plane."><input type="email" autoFocus placeholder="Existing user email" value={email} onChange={(event) => setEmail(event.target.value)} required /></FormField><FormField label="Role" help="Role menentukan permission user; kosongkan jika role akan diberikan nanti."><select value={roleId} onChange={(event) => setRoleId(event.target.value)}><option value="">Tanpa role</option>{roles.map((role) => <option key={String(role.id)} value={String(role.id)}>{display(role.name)}</option>)}</select></FormField><div className="modal-actions"><button type="button" className="button-secondary" onClick={() => setAddModalOpen(false)} disabled={busy}>Batal</button><button type="submit" disabled={busy || !organizationId}>{busy ? "Memproses…" : "Tambah member"}</button></div></form></article></Modal>}</article>;
}

function CredentialGrantPanel({ api, organizationId, namespaces, credentials, grants, onChanged }: { api: DashboardApi; organizationId: string; namespaces: Array<Record<string, unknown>>; credentials: Array<Record<string, unknown>>; grants: Array<Record<string, unknown>>; onChanged: () => Promise<void> }) {
  const [namespaceId, setNamespaceId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [credentialModalOpen, setCredentialModalOpen] = useState(false);
  const [grantModalOpen, setGrantModalOpen] = useState(false);

  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      const result = await api.createCredential(organizationId, { namespaceId, expiresAt: null });
      setSecret(result.secret); setMessage("Credential dibuat. Simpan secret ini sekarang; secret tidak akan ditampilkan lagi.");
      await onChanged(); setCredentialModalOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Credential gagal dibuat"); }
    finally { setBusy(false); }
  }

  async function createGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      const credential = credentials.find((row) => row.id === credentialId);
      const credentialNamespace = credential?.namespace as Record<string, unknown> | undefined;
      await api.createFolderGrant(organizationId, { namespaceId: String(credentialNamespace?.id ?? namespaceId), principalType: "API_CREDENTIAL", principalId: credentialId, prefix, actions: ["list", "read", "write", "delete"] });
      setPrefix(""); setMessage("Folder grant dibuat."); await onChanged(); setGrantModalOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Grant gagal dibuat"); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) { setBusy(true); try { await api.revokeCredential(organizationId, id); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Credential gagal dicabut"); } finally { setBusy(false); } }
  async function removeGrant(id: string) { setBusy(true); try { await api.deleteFolderGrant(organizationId, id); await onChanged(); } catch (error) { setMessage(error instanceof Error ? error.message : "Grant gagal dihapus"); } finally { setBusy(false); } }

  return <article className="data-panel">
    <div className="panel-heading"><h2>API credentials & grants</h2><span>{credentials.length}</span></div>
    <PanelDescription>Buat credential aplikasi untuk namespace tertentu, lalu beri akses folder melalui grant. Secret credential hanya tampil sekali saat dibuat—simpan di secret manager atau client yang aman.</PanelDescription>
    <div className="panel-actions"><button type="button" onClick={() => setCredentialModalOpen(true)} disabled={busy || !organizationId || namespaces.length === 0}>Buat credential</button><button type="button" className="button-secondary" onClick={() => setGrantModalOpen(true)} disabled={busy || !organizationId || credentials.filter((row) => row.status === "ACTIVE").length === 0}>Tambah grant</button></div>
    {secret && <p className="secret-output" role="status">Secret sekali tampil: <code>{secret}</code></p>}
    {credentials.length > 0 && <div className="table-wrap"><table><caption className="sr-only">Daftar API credential dan statusnya</caption><thead><tr><th>Key ID</th><th>Status</th><th>Namespace</th><th /></tr></thead><tbody>{credentials.map((credential) => <tr key={String(credential.id)}><td>{display(credential.keyId)}</td><td>{display(credential.status)}</td><td>{display((credential.namespace as Record<string, unknown> | undefined)?.slug)}</td><td>{credential.status === "ACTIVE" && <button className="button-danger" onClick={() => void revoke(String(credential.id))} disabled={busy}>Revoke</button>}</td></tr>)}</tbody></table></div>}
    {grants.length > 0 && <div className="table-wrap"><table><caption className="sr-only">Daftar folder grant dan action yang diizinkan</caption><thead><tr><th>Principal</th><th>Prefix</th><th>Actions</th><th /></tr></thead><tbody>{grants.map((grant) => <tr key={String(grant.id)}><td>{display(grant.principalId)}</td><td>{display(grant.prefix)}</td><td>{Array.isArray(grant.actions) ? grant.actions.join(", ") : "—"}</td><td><button className="button-danger" onClick={() => void removeGrant(String(grant.id))} disabled={busy}>Delete</button></td></tr>)}</tbody></table></div>}
    {message && <p className="muted" role="status">{message}</p>}
    {credentialModalOpen && <Modal compact label="Buat credential" onClose={() => { if (!busy) setCredentialModalOpen(false); }}><article className="data-panel"><div className="panel-heading"><h2>Buat API credential</h2></div><form onSubmit={createCredential} className="stack"><FormField label="Credential namespace" help="Namespace yang menjadi scope credential baru."><select autoFocus value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} required><option value="">Namespace credential</option>{namespaces.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.name ?? row.slug)}</option>)}</select></FormField><div className="modal-actions"><button type="button" className="button-secondary" onClick={() => setCredentialModalOpen(false)} disabled={busy}>Batal</button><button type="submit" disabled={busy || !organizationId}>{busy ? "Membuat…" : "Buat credential"}</button></div></form></article></Modal>}
    {grantModalOpen && <Modal compact label="Tambah folder grant" onClose={() => { if (!busy) setGrantModalOpen(false); }}><article className="data-panel"><div className="panel-heading"><h2>Tambah folder grant</h2></div><form onSubmit={createGrant} className="stack"><FormField label="Credential grant" help="Credential aktif yang akan menerima izin folder."><select autoFocus value={credentialId} onChange={(event) => setCredentialId(event.target.value)} required><option value="">Credential grant</option>{credentials.filter((row) => row.status === "ACTIVE").map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.keyId)}</option>)}</select></FormField><FormField label="Prefix (optional)" help="Prefix object yang boleh diakses, misalnya team-a/. Kosongkan untuk seluruh namespace."><input placeholder="Prefix (optional)" value={prefix} onChange={(event) => setPrefix(event.target.value)} /></FormField><div className="modal-actions"><button type="button" className="button-secondary" onClick={() => setGrantModalOpen(false)} disabled={busy}>Batal</button><button type="submit" disabled={busy || !organizationId}>{busy ? "Memproses…" : "Tambah grant"}</button></div></form></article></Modal>}
  </article>;
}

function MigrationPanel({ api, organizationId, snapshot, onChanged }: { api: DashboardApi; organizationId: string; snapshot: DashboardSnapshot; onChanged: () => Promise<void> }) {
  const [namespaceId, setNamespaceId] = useState("");
  const [sourceBucketConnectionId, setSourceBucketConnectionId] = useState("");
  const [targetBucketConnectionId, setTargetBucketConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      await api.createMigration(organizationId, { namespaceId, sourceBucketConnectionId, targetBucketConnectionId });
      setMessage("Migration dibuat dalam status CREATED.");
      await onChanged(); setCreateModalOpen(false);
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
    <PanelDescription>Buat dan kendalikan proses pemindahan object dari bucket sumber ke bucket target. Pastikan kedua bucket dapat diakses dan namespace sesuai sebelum menjalankan migration.</PanelDescription>
    <div className="panel-actions"><button type="button" onClick={() => setCreateModalOpen(true)} disabled={busy || snapshot.namespaces.length === 0 || snapshot.buckets.length < 2}>Buat migration run</button></div>
    {message && <p className="muted" role="status">{message}</p>}
    {snapshot.migrations.length === 0 ? <p className="muted">Belum ada migration.</p> : <div className="migration-list">{snapshot.migrations.slice(0, 8).map((row, index) => <div className="migration-row" key={String(row.id ?? index)}><span><strong>{display(row.state)}</strong><small>{display(row.completedItems)} / {display(row.totalItems)} object</small></span><span className="migration-actions">{row.state === "CREATED" || row.state === "PAUSED" ? <button onClick={() => control(String(row.id), "start")} disabled={busy}>Start</button> : null}{row.state === "RUNNING" ? <button className="button-secondary" onClick={() => control(String(row.id), "pause")} disabled={busy}>Pause</button> : null}{["CREATED", "RUNNING", "PAUSED"].includes(String(row.state)) ? <button className="button-danger" onClick={() => control(String(row.id), "cancel")} disabled={busy}>Cancel</button> : null}</span></div>)}</div>}
    {createModalOpen && <Modal label="Buat migration run" onClose={() => { if (!busy) setCreateModalOpen(false); }}><article className="data-panel"><div className="panel-heading"><h2>Buat migration run</h2></div><form onSubmit={create} className="stack"><FormField label="Namespace" help="Namespace yang menjadi scope object dan policy migration."><select autoFocus value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} required><option value="">Pilih namespace</option>{snapshot.namespaces.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.name ?? row.slug)}</option>)}</select></FormField><FormField label="Source bucket" help="Bucket asal object yang akan dibaca."><select value={sourceBucketConnectionId} onChange={(event) => setSourceBucketConnectionId(event.target.value)} required><option value="">Pilih source bucket</option>{snapshot.buckets.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.bucketName)}</option>)}</select></FormField><FormField label="Target bucket" help="Bucket tujuan object hasil migration; tidak boleh sama dengan source."><select value={targetBucketConnectionId} onChange={(event) => setTargetBucketConnectionId(event.target.value)} required><option value="">Pilih target bucket</option>{snapshot.buckets.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.bucketName)}</option>)}</select></FormField><div className="modal-actions"><button type="button" className="button-secondary" onClick={() => setCreateModalOpen(false)} disabled={busy}>Batal</button><button type="submit" disabled={busy}>{busy ? "Membuat…" : "Buat run"}</button></div></form></article></Modal>}
  </article>;
}

function DataPanel({ title, description, rows, fields }: { title: string; description: string; rows: Array<Record<string, unknown>>; fields: string[] }) {
  return (
    <article className="data-panel">
      <div className="panel-heading"><h2>{title}</h2><span>{rows.length}</span></div>
      <PanelDescription>{description}</PanelDescription>
      {rows.length === 0 ? <p className="muted">Belum ada data atau permission belum diberikan.</p> : (
        <div className="table-wrap"><table><caption className="sr-only">{description}</caption><thead><tr>{fields.map((field) => <th key={field}>{tableFieldLabel(field)}</th>)}</tr></thead><tbody>
          {rows.slice(0, 8).map((row, index) => <tr key={String(row.id ?? index)}>{fields.map((field) => <td key={field}>{field === "status" ? <span className={statusClass(row[field])}>{display(row[field])}</span> : display(row[field])}</td>)}</tr>)}
        </tbody></table></div>
      )}
    </article>
  );
}
