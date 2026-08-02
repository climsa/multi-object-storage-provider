import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./styles.css";

export const metadata: Metadata = {
  title: "Multi-Provider Object Storage",
  description: "Administration control plane",
};

// The CSP nonce is generated per request by proxy.ts. Disable static
// prerendering so Next can propagate that nonce to framework scripts/styles.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
