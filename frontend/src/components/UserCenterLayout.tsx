import { type ReactNode, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { authClient } from "../lib/auth-client";

interface NavItem { to: string; label: string; adminOnly?: boolean }

const NAV: NavItem[] = [
  { to: "/dashboard", label: "概览" },
  { to: "/security", label: "安全设置" },
  { to: "/cqu", label: "CQU 账户" },
  { to: "/admin", label: "管理控制台", adminOnly: true },
];

export default function UserCenterLayout({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);

  const user = session?.user as { role?: string; email?: string } | undefined;
  const isAdmin = user?.role === "admin" || user?.role === "superAdmin";
  const items = NAV.filter((i) => !i.adminOnly || isAdmin);

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate("/login");
  };

  const NavLinks = () => (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const active = location.pathname.startsWith(item.to);
        const sep = item.adminOnly;
        return (
          <div key={item.to}>
            {sep && <div className="my-2 border-t border-gray-200" />}
            <Link
              to={item.to}
              onClick={() => setDrawer(false)}
              className={`block px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              {item.label}
            </Link>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button className="md:hidden p-2 -ml-2 text-gray-500" onClick={() => setDrawer((v) => !v)} aria-label="菜单">
              ☰
            </button>
            <Link to="/dashboard" className="text-lg font-semibold text-blue-600">CQU Auth</Link>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline text-sm text-gray-500">{user?.email}</span>
            <button onClick={handleSignOut} className="text-sm text-gray-600 hover:text-gray-900 font-medium">退出登录</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex gap-8">
        {/* Sidebar (desktop) */}
        <aside className="hidden md:block w-48 shrink-0">
          <div className="sticky top-24"><NavLinks /></div>
        </aside>
        {/* Drawer (mobile) */}
        {drawer && (
          <div className="md:hidden fixed inset-0 z-40" onClick={() => setDrawer(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <div className="absolute left-0 top-16 bottom-0 w-60 bg-white border-r border-gray-200 p-4" onClick={(e) => e.stopPropagation()}>
              <NavLinks />
            </div>
          </div>
        )}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
