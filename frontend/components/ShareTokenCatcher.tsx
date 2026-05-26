"use client";

// Recognizes `?share=...` on any page load. If the URL has a share token,
// stores it in localStorage (under the same key the rest of the app uses)
// and strips the query param from the URL so it doesn't leak via reload /
// back button / clipboard paste.
//
// This is the receiver side of the tokenized share flow. The owner mints a
// URL like `https://wiki.example.com?share=ABC123` and hands it to someone.
// When that someone opens the URL, this component captures the token and
// the rest of the app sees a tier-elevated viewer.

import { useEffect } from "react";
import { setOwnerToken } from "@/lib/api";

export function ShareTokenCatcher() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const share = params.get("share");
    if (!share) return;
    setOwnerToken(share);
    params.delete("share");
    const newSearch = params.toString();
    const cleanUrl =
      window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
    // Force a refresh of any components reading the manifest / viewer tier.
    window.dispatchEvent(new Event("wiki:preview-as-change"));
  }, []);

  return null;
}
