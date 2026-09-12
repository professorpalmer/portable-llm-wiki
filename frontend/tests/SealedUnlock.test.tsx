import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const unlock = vi.fn();
const lock = vi.fn();
const sealing = {
  status: "locked" as "locked" | "unlocked" | "not_enabled",
  tiers: ["private"],
  dek: null as Uint8Array | null,
  titles: null as Map<string, string> | null,
  sealedCount: 0,
  unlock,
  lock,
  decryptPage: vi.fn(),
  refresh: vi.fn(),
  searchLocal: vi.fn(() => []),
};

vi.mock("@/lib/useSealing", () => ({
  useSealing: () => sealing,
}));

import { SealedUnlock } from "@/components/SealedUnlock";
import { WrongPassphraseError } from "@/lib/sealing";

describe("SealedUnlock", () => {
  beforeEach(() => {
    unlock.mockReset();
    lock.mockReset();
    sealing.status = "locked";
    sealing.dek = null;
    sealing.titles = null;
  });

  it("returns nothing when sealing is not enabled", () => {
    sealing.status = "not_enabled";
    const { container } = render(<SealedUnlock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("unlocks with the passphrase and shows locked error text", async () => {
    unlock.mockRejectedValueOnce(new WrongPassphraseError());
    const user = userEvent.setup();
    render(<SealedUnlock />);

    await user.type(screen.getByLabelText(/passphrase/i), "nope");
    await user.click(screen.getByRole("button", { name: /unlock/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Wrong passphrase");
    });
    expect(unlock).toHaveBeenCalledWith("nope");
  });

  it("shows Lock when unlocked", async () => {
    sealing.status = "unlocked";
    const user = userEvent.setup();
    render(<SealedUnlock />);
    expect(screen.getByText("unlocked")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /lock/i }));
    expect(lock).toHaveBeenCalled();
  });
});
