/**
 * HandshakeCallout must never paint a plaintext share/owner token into
 * the DOM (code block or preview href). Copy may still put ?t= on the
 * clipboard when a share-token store value exists.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { HandshakeCallout } from "@/components/HandshakeCallout";
import { setOwnerToken } from "@/lib/api";
import { setShareToken } from "@/lib/shareToken";

describe("HandshakeCallout", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    window.localStorage.clear();
    writeText.mockClear();
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it("shows the public /<tenant>/llm URL when no share token is stored", () => {
    render(<HandshakeCallout tenant="cary" isOwnerView={false} />);
    expect(screen.getByText("https://portablellm.wiki/cary/llm")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("?t=");
    const preview = screen.getByRole("link", { name: /preview what an LLM sees/i });
    expect(preview.getAttribute("href")).toBe("https://portablellm.wiki/cary/llm");
  });

  it("does not render a stored share token; copy still includes ?t=", async () => {
    setShareToken("SECRET_SHARE_TOKEN", "cary");
    render(<HandshakeCallout tenant="cary" isOwnerView={false} />);

    await waitFor(() => {
      expect(screen.getByText(/t=••••••••/)).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain("SECRET_SHARE_TOKEN");
    const preview = screen.getByRole("link", { name: /preview what an LLM sees/i });
    expect(preview.getAttribute("href")).toBe("https://portablellm.wiki/cary/llm");
    expect(preview.getAttribute("href")).not.toContain("SECRET_SHARE_TOKEN");

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(
      "https://portablellm.wiki/cary/llm?t=SECRET_SHARE_TOKEN",
    );
  });

  it("does not treat llmwiki:ownerToken as a share token", () => {
    setOwnerToken("OWNER_PLAINTEXT");
    render(<HandshakeCallout tenant="cary" isOwnerView={true} />);
    expect(screen.getByText("https://portablellm.wiki/cary/llm")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("OWNER_PLAINTEXT");
    expect(document.body.textContent).not.toContain("?t=");
  });
});
