/**
 * Vitest setup file. Wires `@testing-library/jest-dom` matchers and mocks
 * the bits of Next.js that don't work in a plain jsdom environment.
 */
import "@testing-library/jest-dom/vitest";
import { vi, beforeEach } from "vitest";

// next/link in this codebase only uses `href` + children, so the simplest
// possible passthrough is enough.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.PropsWithChildren<
    React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
  >) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const React = require("react");
    return React.createElement("a", { href, ...props }, children);
  },
}));

// next/navigation's hooks need a value or the components blow up at import
// time. Tests that need different routes flip `window.__TEST_PATHNAME` and
// the mocked hook reads it. Storing on `window` (not a module-local) avoids
// the "vi.mock factory has no closure over module variables" gotcha.
declare global {
  // eslint-disable-next-line no-var
  var __TEST_PATHNAME: string | undefined;
}

vi.mock("next/navigation", () => ({
  usePathname: () => (typeof globalThis.__TEST_PATHNAME === "string"
    ? globalThis.__TEST_PATHNAME
    : "/"),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

export function __setPathname(p: string) {
  globalThis.__TEST_PATHNAME = p;
}

beforeEach(() => {
  globalThis.__TEST_PATHNAME = "/";
  window.localStorage.clear();
});
