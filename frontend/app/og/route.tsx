// Dynamic Open Graph image. Crawlers (Twitter, Facebook, iMessage, Slack)
// hit /og and get a 1200x630 PNG generated server-side. The metadata in
// app/layout.tsx + app/page/[slug]/layout.tsx point OpenGraph + Twitter
// Card at /og.
//
// Query params:
//   title    — main heading
//   subtitle — secondary line under the title
//   section  — wiki section label (entities, concepts, decisions, etc.)
//              rendered as a small uppercase pill above the title
//   tier     — visibility tier; renders a colored badge in the top-right
//              so the preview makes clear who can read the page

import { ImageResponse } from "next/og";

export const runtime = "edge";

type Tier = "public" | "recruiter" | "friend" | "private";

const TIER_STYLES: Record<Tier, { bg: string; fg: string; border: string }> = {
  public: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  recruiter: { bg: "#eff6ff", fg: "#1e3a8a", border: "#bfdbfe" },
  friend: { bg: "#faf5ff", fg: "#581c87", border: "#e9d5ff" },
  private: { bg: "#fef2f2", fg: "#7f1d1d", border: "#fecaca" },
};

function isTier(s: string | null): s is Tier {
  return s === "public" || s === "recruiter" || s === "friend" || s === "private";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title") || "Portable LLM Wiki";
  const subtitle =
    searchParams.get("subtitle") ||
    "Markdown in your git. Queryable by any LLM.";
  const section = searchParams.get("section") || "";
  const rawTier = searchParams.get("tier");
  const tier: Tier | null = isTier(rawTier) ? rawTier : null;

  const tierStyle = tier ? TIER_STYLES[tier] : null;

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background:
            "linear-gradient(135deg, #faf8f5 0%, #f5f1ea 50%, #ede5d6 100%)",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Header: brand left, optional tier badge right */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: "#1a1814",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              fontSize: "28px",
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            <span style={{ color: "#d97706" }}>·</span>
            <span>portable llm wiki</span>
          </div>

          {tierStyle && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 22px",
                borderRadius: "999px",
                background: tierStyle.bg,
                color: tierStyle.fg,
                border: `2px solid ${tierStyle.border}`,
                fontSize: "20px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              <span>tier:</span>
              <span>{tier}</span>
            </div>
          )}
        </div>

        {/* Body */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            maxWidth: "1040px",
          }}
        >
          {section && (
            <div
              style={{
                fontSize: "20px",
                color: "#8a8074",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                fontWeight: 600,
              }}
            >
              {section}
            </div>
          )}
          <div
            style={{
              fontSize: "64px",
              fontWeight: 600,
              color: "#1a1814",
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: "30px",
              color: "#5a5247",
              lineHeight: 1.3,
            }}
          >
            {subtitle}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            fontSize: "20px",
            color: "#8a8074",
          }}
        >
          <span>karpathy-style. owned by you. queryable by any llm.</span>
          <span>v1.0</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
