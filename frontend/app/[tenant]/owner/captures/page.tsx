// Per-tenant /<tenant>/owner/captures route. Mirrors the pattern used
// for /<tenant>/owner and /<tenant>/owner/import — re-exports the bare
// /owner/captures page so the underlying useTenant() picks up the
// [tenant] URL segment automatically.
//
// Without this file the owner-console nav link to "capture history"
// dead-ends with a Next.js 404 in hosted mode, because the bare
// /owner/captures route only matches when the URL has no tenant
// prefix (in OSS single-tenant installs).
export { default } from "@/app/owner/captures/page";
