// Per-tenant /<tenant>/owner/import route. Mounts the same import wizard
// as /owner/import — useTenant() reads the [tenant] URL segment and the
// page threads it through every api call.
export { default } from "@/app/owner/import/page";
