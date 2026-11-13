import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Sara | ANCFZ Customer Service",
  description: "Chat with Sara, the ANCFZ customer service assistant.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-[#f4f5f6] text-zinc-900 min-h-dvh">{children}</body>
    </html>
  );
}
