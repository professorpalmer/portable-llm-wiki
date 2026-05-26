// Per-tenant /<tenant>/page/<slug> route. Mounts the same component as
// the single-tenant /page/<slug> route — it reads tenant from useTenant()
// (which resolves to the [tenant] URL segment) and threads it through
// every api call and internal link.
export { default } from "@/app/page/[slug]/page";
