"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchManifest, getOwnerToken, getPreviewAs } from "@/lib/api";

export function ViewerBadge() {
  const [label, setLabel] = useState<string>("loading…");
  const [tier, setTier] = useState<string>("public");
  const [isOwner, setIsOwner] = useState(false);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const m = await fetchManifest();
        if (cancelled) return;
        setTier(m.viewer_tier);
        setIsOwner(m.viewer_is_owner);
        setPageCount(m.page_count);
        const tok = getOwnerToken();
        const previewAs = getPreviewAs();
        const isPreview = !!tok && previewAs !== "owner";
        setPreviewing(isPreview);
        setLabel(
          isPreview
            ? `preview · ${previewAs}`
            : m.viewer_is_owner
            ? "owner view"
            : tok
            ? `${m.viewer_tier} tier`
            : `${m.viewer_tier} tier`,
        );
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setLabel("offline");
      }
    }
    load();
    const interval = setInterval(load, 8000);
    const onPreviewChange = () => load();
    window.addEventListener("wiki:preview-as-change", onPreviewChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("wiki:preview-as-change", onPreviewChange);
    };
  }, []);

  // Preview overrides the visual style — yellow warning band — so the owner
  // can never forget they're viewing through a downgrade lens.
  const color = previewing
    ? "bg-amber-200 text-amber-900 ring-1 ring-amber-500"
    : isOwner
    ? "bg-accent text-white"
    : tier === "private"
    ? "bg-red-100 text-red-800"
    : tier === "friend"
    ? "bg-purple-100 text-purple-800"
    : tier === "recruiter"
    ? "bg-blue-100 text-blue-800"
    : "bg-paper-soft text-ink-muted hover:bg-ink hover:text-paper";

  const tooltip = error
    ? `Error: ${error}`
    : previewing
    ? `Owner previewing as ${tier} · ${pageCount ?? "?"} pages visible. Click to manage.`
    : isOwner
    ? `Owner view · ${pageCount ?? "?"} pages visible. Click to manage.`
    : `Viewing the ${tier} tier · ${pageCount ?? "?"} pages visible. If this is your own instance, click to authenticate as owner.`;

  return (
    <Link
      href="/owner"
      className={`text-xs font-medium px-2 py-1 rounded transition-colors ${color}`}
      title={tooltip}
    >
      {label}
      {pageCount !== null && ` · ${pageCount} pages`}
    </Link>
  );
}
