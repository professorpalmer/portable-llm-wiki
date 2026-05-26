// Tenant resolution hooks for hosted-mode pages.
//
// In hosted mode every wiki/owner API call needs a tenant id. Pages under
// /[tenant]/* can read it from the URL params; this hook normalizes that
// pattern in one place so individual pages don't all reimplement it.
//
// Single-tenant (OSS) mode: ``useTenant()`` returns ``undefined`` and api.ts
// falls back to the global default tenant — same behavior as before the
// multi-tenant refactor.

"use client";

import { useParams } from "next/navigation";

import { isHostedMode } from "./api";

/**
 * Returns the tenant id from the current URL (if we're under /[tenant]/*),
 * or undefined in single-tenant mode.
 *
 * Use this in any page that needs to call wiki/owner API endpoints so the
 * call is scoped to the right tenant in hosted mode.
 */
export function useTenant(): string | undefined {
  // ``useParams`` returns the dynamic-segment values for the closest
  // matched route. Pages under /app/[tenant]/... get { tenant: "<id>" }.
  // Pages outside /[tenant]/ (e.g. /welcome, /signup, single-tenant
  // /browse) get undefined and we fall back to global.
  const params = useParams();
  if (!isHostedMode()) return undefined;
  const t = params?.tenant;
  if (typeof t === "string" && t) return t;
  if (Array.isArray(t) && t.length > 0 && typeof t[0] === "string") return t[0];
  return undefined;
}
