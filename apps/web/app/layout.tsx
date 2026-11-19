import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Sara · ANCFZ Free Zone Assistant",
  description: "Official AI Customer Concierge for the Al Nakheel Commercial Free Zone (ANCFZ).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased min-h-dvh text-slate-900">{children}</body>
    </html>
  );
}
