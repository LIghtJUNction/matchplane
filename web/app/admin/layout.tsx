import type { ReactNode } from "react";
import AdminSidebar from "../../src/admin/components/AdminSidebar";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="admin-layout">
      <AdminSidebar />
      <section className="admin-layout-content">{children}</section>
    </div>
  );
}
