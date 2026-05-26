// Per-tenant /<tenant>/capture route. Owner-only — the underlying
// CapturePage wraps its body in <OwnerGate> so non-owners see an
// explanatory error instead of someone else's capture UI.
export { default } from "@/app/capture/page";
