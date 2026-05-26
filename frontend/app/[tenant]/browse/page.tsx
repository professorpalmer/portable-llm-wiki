// Per-tenant /<tenant>/browse route. Mounts the same BrowsePage as the
// single-tenant /browse route — BrowsePage reads tenant from useTenant()
// (which resolves to the [tenant] URL param) and threads it through every
// api call.
export { default } from "@/app/browse/page";
