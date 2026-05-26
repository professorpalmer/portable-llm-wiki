import "./globals.css";
import type { Metadata } from "next";
import { NavBar } from "@/components/NavBar";
import { ShareTokenCatcher } from "@/components/ShareTokenCatcher";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ||
  "http://localhost:3000";

const SITE_TITLE = "Portable LLM Wiki";
const SITE_DESC =
  "A vendor-neutral, LLM-maintained personal-context wiki. Markdown in your git, queryable by any LLM.";

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: "%s · Portable LLM Wiki",
  },
  description: SITE_DESC,
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_TITLE,
  authors: [{ name: "Portable LLM Wiki" }],
  keywords: [
    "llm wiki",
    "personal context",
    "portable memory",
    "mcp",
    "markdown wiki",
    "ai memory",
  ],
  openGraph: {
    type: "website",
    title: SITE_TITLE,
    description: SITE_DESC,
    url: SITE_URL,
    siteName: SITE_TITLE,
    images: [
      {
        url: "/og",
        width: 1200,
        height: 630,
        alt: SITE_TITLE,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESC,
    images: ["/og"],
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <ShareTokenCatcher />
        <NavBar />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-paper-soft text-xs text-ink-muted">
          <div className="max-w-5xl mx-auto px-4 sm:px-5 py-4 flex items-center justify-between">
            <span>
              v1.0 · markdown in your git · vendor-neutral by design
            </span>
            <a
              className="hover:text-ink"
              href="/api/backend/healthz"
              target="_blank"
              rel="noreferrer"
            >
              status
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
