import type { ReactNode } from "react";

export default function AdminPanel({ children }: { children: ReactNode }) {
  return <section className="admin-panel">{children}</section>;
}
