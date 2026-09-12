"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  fetchManifest,
  fetchSealedBundle,
  fetchSealingKeyring,
  type SealedBundlePage,
} from "./api";
import { useTenant } from "./useTenant";
import {
  clearDek,
  decryptEnvelope,
  excerptAround,
  loadDek,
  parseEnvelopePayload,
  scoreSealedSearch,
  storeDek,
  unwrapDek,
  verifyDek,
  WrongPassphraseError,
  type EnvelopePayload,
  type LocalSearchHit,
} from "./sealing";

export type SealingStatus = "not_enabled" | "locked" | "unlocked";

export type SealingApi = {
  status: SealingStatus;
  tiers: string[];
  dek: Uint8Array | null;
  titles: Map<string, string> | null;
  sealedCount: number;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  decryptPage: (slug: string, envelope: string) => Promise<EnvelopePayload>;
  refresh: () => Promise<void>;
  searchLocal: (query: string) => LocalSearchHit[];
};

type Snapshot = {
  status: SealingStatus;
  tiers: string[];
  dek: Uint8Array | null;
  titles: Map<string, string> | null;
  sealedCount: number;
};

const UNBOUND = Symbol("unbound");

const EMPTY: Snapshot = {
  status: "not_enabled",
  tiers: [],
  dek: null,
  titles: null,
  sealedCount: 0,
};

let snapshot: Snapshot = EMPTY;
let boundTenant: string | undefined | typeof UNBOUND = UNBOUND;
let bundle: SealedBundlePage[] = [];
let cache = new Map<string, EnvelopePayload>();
let hydrateGen = 0;
const listeners = new Set<() => void>();

function emit(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function tenantOf(): string | undefined {
  return boundTenant === UNBOUND ? undefined : boundTenant;
}

async function decryptBundle(
  tenant: string | undefined,
  dek: Uint8Array,
  tiers: string[],
): Promise<void> {
  const fetched = await fetchSealedBundle(tenant);
  bundle = fetched.pages;
  cache = new Map();
  const titles = new Map<string, string>();
  for (const page of fetched.pages) {
    try {
      const payload = parseEnvelopePayload(
        await decryptEnvelope(dek, page.slug, page.envelope),
      );
      cache.set(page.slug, payload);
      titles.set(page.slug, payload.title);
    } catch {
      /* skip a corrupt page; others still unlock */
    }
  }
  emit({
    status: "unlocked",
    tiers,
    dek,
    titles,
    sealedCount: fetched.count,
  });
}

async function hydrate(tenant: string | undefined): Promise<void> {
  const gen = ++hydrateGen;
  boundTenant = tenant;
  try {
    const manifest = await fetchManifest(tenant);
    if (gen !== hydrateGen) return;
    const sealing = manifest.sealing;
    if (!sealing) {
      bundle = [];
      cache = new Map();
      emit(EMPTY);
      return;
    }
    const stored = loadDek();
    if (stored) {
      try {
        const keyring = await fetchSealingKeyring(tenant);
        if (gen !== hydrateGen) return;
        await verifyDek(stored, keyring);
        await decryptBundle(tenant, stored, sealing.tiers);
        return;
      } catch {
        clearDek();
      }
    }
    if (gen !== hydrateGen) return;
    bundle = [];
    cache = new Map();
    emit({
      status: "locked",
      tiers: sealing.tiers,
      dek: null,
      titles: null,
      sealedCount: 0,
    });
  } catch {
    if (gen !== hydrateGen) return;
    emit(EMPTY);
  }
}

async function unlock(passphrase: string): Promise<void> {
  const tenant = tenantOf();
  const keyring = await fetchSealingKeyring(tenant);
  const dek = await unwrapDek(keyring, passphrase);
  storeDek(dek);
  await decryptBundle(tenant, dek, keyring.tiers);
}

function lock(): void {
  clearDek();
  bundle = [];
  cache = new Map();
  if (snapshot.status === "not_enabled") {
    emit(EMPTY);
    return;
  }
  emit({
    status: "locked",
    tiers: snapshot.tiers,
    dek: null,
    titles: null,
    sealedCount: 0,
  });
}

async function decryptPage(
  slug: string,
  envelope: string,
): Promise<EnvelopePayload> {
  const cached = cache.get(slug);
  if (cached) return cached;
  const dek = snapshot.dek ?? loadDek();
  if (!dek) {
    throw new WrongPassphraseError();
  }
  const payload = parseEnvelopePayload(await decryptEnvelope(dek, slug, envelope));
  cache.set(slug, payload);
  return payload;
}

async function refresh(): Promise<void> {
  const tenant = tenantOf();
  if (snapshot.status === "unlocked" && snapshot.dek) {
    await decryptBundle(tenant, snapshot.dek, snapshot.tiers);
    return;
  }
  await hydrate(tenant);
}

function searchLocal(query: string): LocalSearchHit[] {
  const hits: LocalSearchHit[] = [];
  for (const page of bundle) {
    const payload = cache.get(page.slug);
    if (!payload) continue;
    const score = scoreSealedSearch(query, payload.title, payload.body);
    if (score <= 0) continue;
    hits.push({
      slug: page.slug,
      title: payload.title,
      section: page.section,
      tier: page.tier,
      updated: page.updated,
      score,
      excerpt: excerptAround(payload.body, query),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

export function useSealing(tenantOverride?: string): SealingApi {
  const routeTenant = useTenant();
  const tenant = tenantOverride ?? routeTenant;
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void hydrate(tenant);
  }, [tenant]);

  const unlockBound = useCallback(async (passphrase: string) => {
    await unlock(passphrase);
  }, []);

  const lockBound = useCallback(() => {
    lock();
  }, []);

  const decryptBound = useCallback((slug: string, envelope: string) => {
    return decryptPage(slug, envelope);
  }, []);

  const refreshBound = useCallback(async () => {
    await refresh();
  }, []);

  const searchBound = useCallback((query: string) => {
    return searchLocal(query);
  }, []);

  return {
    status: current.status,
    tiers: current.tiers,
    dek: current.dek,
    titles: current.titles,
    sealedCount: current.sealedCount,
    unlock: unlockBound,
    lock: lockBound,
    decryptPage: decryptBound,
    refresh: refreshBound,
    searchLocal: searchBound,
  };
}

/** Test helper — reset module state between cases. */
export function __resetSealingStore(): void {
  snapshot = EMPTY;
  boundTenant = UNBOUND;
  bundle = [];
  cache = new Map();
  hydrateGen += 1;
  clearDek();
  for (const listener of listeners) listener();
}
