"use client";

import { useEffect, useMemo, useState } from "react";

import {
  fetchManifest,
  ownerDeleteSealing,
  ownerGetPageRaw,
  ownerPutSealing,
  ownerReplacePage,
  type Manifest,
  type PageSummary,
} from "@/lib/api";
import { generateKeyring, parseWikiFrontmatter, sealMarkdown } from "@/lib/sealing";
import { useSealing } from "@/lib/useSealing";

const OFFERED_TIERS: { id: "private" | "friend" | "recruiter"; label: string }[] = [
  { id: "private", label: "private" },
  { id: "friend", label: "friend" },
  { id: "recruiter", label: "recruiter" },
];

const ACK_TEXT =
  "If I lose this passphrase, nobody, including the site operator, can recover these pages.";

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function SealingPanel({ tenant }: { tenant?: string } = {}) {
  const sealing = useSealing(tenant);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [chosen, setChosen] = useState<Record<string, boolean>>({
    private: true,
    friend: false,
    recruiter: false,
  });
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [force, setForce] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  const [migrating, setMigrating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const [disableError, setDisableError] = useState<string | null>(null);

  async function reloadManifest() {
    try {
      const m = await fetchManifest(tenant, { asOwner: true });
      setManifest(m);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  useEffect(() => {
    void reloadManifest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, sealing.status]);

  const sealedTiers = sealing.tiers;
  const pending = useMemo(() => {
    if (!manifest) return [] as PageSummary[];
    const tiers = new Set(
      (manifest.sealing?.tiers ?? sealedTiers).filter(Boolean),
    );
    return manifest.pages.filter((p) => tiers.has(p.tier) && !p.sealed);
  }, [manifest, sealedTiers]);

  const statusLabel =
    sealing.status === "not_enabled"
      ? "not enabled"
      : sealing.status === "unlocked"
        ? "unlocked"
        : "locked";

  async function onEnable(e: React.FormEvent) {
    e.preventDefault();
    setEnableError(null);
    const tiers = OFFERED_TIERS.map((t) => t.id).filter((id) => chosen[id]);
    if (tiers.length === 0) {
      setEnableError("Choose at least one tier.");
      return;
    }
    if (!passphrase) {
      setEnableError("Passphrase is required.");
      return;
    }
    if (passphrase !== confirm) {
      setEnableError("Passphrase and confirm do not match.");
      return;
    }
    if (!ack) {
      setEnableError("Acknowledgement is required.");
      return;
    }
    setEnabling(true);
    try {
      const keyring = await generateKeyring(passphrase, tiers);
      await ownerPutSealing({ keyring, force }, tenant);
      await sealing.unlock(passphrase);
      setPassphrase("");
      setConfirm("");
      setAck(false);
      await reloadManifest();
      await sealing.refresh();
    } catch (err) {
      setEnableError((err as Error).message);
    } finally {
      setEnabling(false);
    }
  }

  async function onMigrate() {
    if (!sealing.dek) return;
    setMigrating(true);
    setFailures([]);
    const dek = sealing.dek;
    const failed: string[] = [];
    const total = pending.length;
    let done = 0;
    for (const page of pending) {
      setProgress(`sealing ${done + 1} of ${total}`);
      try {
        const raw = await ownerGetPageRaw(page.slug, tenant);
        const parsed = parseWikiFrontmatter(raw.markdown);
        const stamped = todayStamp();
        const sealed = await sealMarkdown(dek, {
          slug: raw.slug,
          type: parsed.fields.type || page.type,
          tier: parsed.fields.tier || page.tier,
          created: parsed.fields.created || stamped,
          updated: parsed.fields.updated || stamped,
          title: parsed.fields.title || raw.title || page.title,
          tags: parsed.fields.tags,
          sources: parsed.fields.sources,
          body: parsed.body,
        });
        await ownerReplacePage(raw.slug, sealed, tenant);
      } catch (err) {
        failed.push(`${page.slug}: ${(err as Error).message}`);
      }
      done += 1;
      setProgress(`sealing ${done} of ${total}`);
    }
    setFailures(failed);
    setProgress(total === 0 ? null : `sealed ${done} of ${total}`);
    setMigrating(false);
    await reloadManifest();
    await sealing.refresh();
  }

  async function onDisable() {
    setDisableError(null);
    const ok = window.confirm(
      "Disable sealing? Already-sealed pages stay sealed until they are re-saved as plaintext.",
    );
    if (!ok) return;
    try {
      await ownerDeleteSealing(tenant);
      sealing.lock();
      await reloadManifest();
      await sealing.refresh();
    } catch (err) {
      setDisableError((err as Error).message);
    }
  }

  return (
    <section className="mt-6 bg-white border border-paper-soft rounded-xl p-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted">
          Sealed tiers
        </h2>
        <span className="text-xs text-ink-muted">{statusLabel}</span>
      </div>

      {sealing.status !== "not_enabled" && (
        <p className="mt-1 text-sm text-ink">
          enabled ({sealing.tiers.join(", ") || "none"})
          {sealing.status === "unlocked" ? " · unlocked" : " · locked"}
        </p>
      )}

      {loadError && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {loadError}
        </p>
      )}

      {sealing.status === "not_enabled" && (
        <form onSubmit={onEnable} className="mt-4 space-y-3">
          <p className="text-sm text-ink-muted">
            Encrypt non-public pages in the browser. The hosted server stores
            only ciphertext.
          </p>
          <fieldset>
            <legend className="text-xs uppercase tracking-wider text-ink-muted mb-1">
              Tiers to seal
            </legend>
            <div className="flex flex-col gap-1.5">
              {OFFERED_TIERS.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!chosen[t.id]}
                    onChange={(e) =>
                      setChosen((prev) => ({ ...prev, [t.id]: e.target.checked }))
                    }
                  />
                  {t.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid sm:grid-cols-2 gap-2">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="passphrase"
              autoComplete="new-password"
              className="border border-paper-soft rounded px-3 py-2 text-sm bg-paper focus:border-accent focus:outline-none"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="confirm passphrase"
              autoComplete="new-password"
              className="border border-paper-soft rounded px-3 py-2 text-sm bg-paper focus:border-accent focus:outline-none"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-1"
            />
            <span>{ACK_TEXT}</span>
          </label>
          <label className="flex items-start gap-2 text-xs text-ink-muted cursor-pointer">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Replace existing keyring (pages sealed with the old key will not
              open).
            </span>
          </label>
          {enableError && (
            <p className="text-xs text-red-700" role="alert">
              {enableError}
            </p>
          )}
          <button
            type="submit"
            disabled={enabling}
            className="px-3 py-2 rounded bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
          >
            {enabling ? "enabling" : "Enable sealing"}
          </button>
        </form>
      )}

      {sealing.status !== "not_enabled" && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-ink-muted leading-relaxed">
            While sealing is enabled the server-side ingest, import, and lint
            are disabled for this wiki. Use the MCP write tools from your own
            LLM session.
          </p>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-ink-muted">
              Seal existing pages
            </h3>
            <p className="mt-1 text-xs text-ink-muted">
              Existing file names are kept; only page contents are sealed.
            </p>
            {sealing.status === "locked" ? (
              <p className="mt-2 text-sm text-ink-muted">
                Unlock to seal existing pages.
              </p>
            ) : pending.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">
                No plaintext pages in sealed tiers.
              </p>
            ) : (
              <>
                <ul className="mt-2 text-sm space-y-1 max-h-40 overflow-y-auto">
                  {pending.map((p) => (
                    <li key={p.slug} className="font-mono text-xs">
                      {p.slug} · {p.tier}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => void onMigrate()}
                  disabled={migrating}
                  className="mt-2 px-3 py-1.5 rounded bg-ink text-paper text-xs font-medium hover:bg-ink-soft disabled:opacity-50"
                >
                  Seal existing pages
                </button>
              </>
            )}
            {progress && (
              <p className="mt-2 text-xs text-ink-muted" role="status">
                {progress}
              </p>
            )}
            {failures.length > 0 && (
              <ul className="mt-2 text-xs text-red-700 space-y-1">
                {failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <button
              type="button"
              onClick={() => void onDisable()}
              className="px-3 py-1.5 rounded border border-paper-soft text-xs text-ink-muted hover:border-ink hover:text-ink"
            >
              Disable sealing
            </button>
            <p className="mt-1 text-xs text-ink-muted">
              Already-sealed pages stay sealed until they are re-saved as
              plaintext.
            </p>
            {disableError && (
              <p className="mt-1 text-xs text-red-700" role="alert">
                {disableError}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
