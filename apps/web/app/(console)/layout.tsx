import type { ReactNode } from "react";

import AdminDashboard from "../admin-dashboard";

export default function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AdminDashboard>{children}</AdminDashboard>;
}
