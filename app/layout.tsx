import type { Metadata, Viewport } from "next";
import { Geist, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { THEME_BOOT } from "@/components/drive/theme";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "TG Drive",
  description: "Your files on Telegram, Cloudflare R2 and Google Drive, in one drive.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0a09" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-design / data-mode are set by THEME_BOOT before first paint, so React must not complain.
    <html lang="en" className={`${geist.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
