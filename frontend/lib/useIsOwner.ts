// Owner-access resolution hook for hosted + OSS modes.
//
// Background: we have two parallel auth mechanisms.
//   * OSS / single-tenant: bearer token in localStorage (legacy v0 model).
//   * Hosted / multi-tenant: GitHub OAuth session cookie scoped to a tenant.
//
// Pages that gate edit affordances (capture, import wizard, per-page edit)
// historically only checked the bearer token. In hosted mode that always
// reads as false, so session-authed owners were silently bounced into the
// "you're not the owner" / demo-preview UI even though /owner/* endpoints
// happily accepted their cookie. This hook normalizes both paths so we
// stop drifting.
//
// Returns:
//   { ready: false } while the hosted-mode auth check is in flight.
//   { ready: true, isOwner: true }  if the viewer can mutate this tenant.
//   { ready: true, isOwner: false } otherwise.
//
// In OSS mode the resolution is synchronous (localStorage read), so the
// first render already has ready=true.

"use client";

import { useEffect, useState } from "react";

import { authMe, getOwnerToken, isHostedMode } from "./api";

export type OwnerAccess =
  | { ready: false; isOwner: false }
  | { ready: true; isOwner: boolean };

/**
 * Resolves whether the current viewer has owner-level access to ``tenant``.
 *
 * In hosted mode this calls /auth/me and compares the resolved tenant_id
 * against the page's tenant param. In OSS mode it falls back to checking
 * for an owner bearer token in localStorage; ``tenant`` is ignored.
 */
export function useIsOwnerOf(tenant: string | undefined): OwnerAccess {
  const hosted = isHostedMode();

  const [state, setState] = useState<OwnerAccess>(() => {
    if (hosted) return { ready: false, isOwner: false };
    return { ready: true, isOwner: !!getOwnerToken() };
  });

  useEffect(() => {
    if (!hosted) {
      setState({ ready: true, isOwner: !!getOwnerToken() });
      return;
    }
    let cancelled = false;
    setState({ ready: false, isOwner: false });
    authMe()
      .then((me) => {
        if (cancelled) return;
        const ok =
          !!me.authenticated &&
          !!me.user &&
          !!tenant &&
          me.user.tenant_id === tenant;
        setState({ ready: true, isOwner: ok });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ ready: true, isOwner: false });
      });
    return () => {
      cancelled = true;
    };
  }, [hosted, tenant]);

  return state;
}
