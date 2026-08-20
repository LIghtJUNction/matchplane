import { redirect } from "next/navigation";

/** Stable, discoverable entry point for the root administrator workspace. */
export default function AdminPage() {
  redirect("/?role=platform");
}
