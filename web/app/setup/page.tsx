import { redirect } from "next/navigation";

/** First-run entry point; the authenticated workspace renders the bounded setup status. */
export default function SetupPage() {
  redirect("/?role=platform&setup=1");
}
