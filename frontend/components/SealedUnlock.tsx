"use client";

import { useState } from "react";

import { useSealing } from "@/lib/useSealing";
import { WrongPassphraseError } from "@/lib/sealing";

export function SealedUnlock({ tenant }: { tenant?: string } = {}) {
  const sealing = useSealing(tenant);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sealing.status === "not_enabled") {
    return null;
  }

  async function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await sealing.unlock(passphrase);
      setPassphrase("");
    } catch (err) {
      setError(
        err instanceof WrongPassphraseError
          ? "Wrong passphrase"
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  if (sealing.status === "unlocked") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-muted">unlocked</span>
        <button
          type="button"
          onClick={() => {
            sealing.lock();
            setError(null);
          }}
          className="px-2 py-1 rounded border border-paper-soft text-ink-muted hover:border-ink hover:text-ink"
        >
          Lock
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onUnlock}
      className="flex flex-wrap items-center gap-1.5 text-xs"
    >
      <label className="sr-only" htmlFor="sealed-passphrase">
        Passphrase
      </label>
      <input
        id="sealed-passphrase"
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="passphrase"
        autoComplete="current-password"
        className="w-28 border border-paper-soft rounded px-2 py-1 bg-white focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy || !passphrase}
        className="px-2 py-1 rounded bg-ink text-paper font-medium hover:bg-ink-soft disabled:opacity-50"
      >
        {busy ? "unlocking" : "Unlock"}
      </button>
      {error && (
        <span className="text-red-700 w-full" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
