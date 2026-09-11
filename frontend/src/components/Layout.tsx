import { ReactNode } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { canAccessAdmin } from "../../../shared/user-roles";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate("/login");
  };

  const user = session?.user as { role?: string; email?: string; name?: string } | undefined;
  const isAdmin = canAccessAdmin(user?.role);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-6">
              <Link to="/" className="text-lg font-semibold text-blue-600">
                CQU Auth
              </Link>
              {session && (
                <>
                  <Link
                    to="/settings"
                    className={`text-sm font-medium transition-colors ${
                      location.pathname === "/settings"
                        ? "text-blue-600"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    设置
                  </Link>
                  {isAdmin && (
                    <Link
                      to="/admin"
                      className={`text-sm font-medium transition-colors ${
                        location.pathname === "/admin"
                          ? "text-blue-600"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      管理
                    </Link>
                  )}
                </>
              )}
            </div>
            {session && (
              <div className="flex items-center gap-4">
                <span className="text-sm text-gray-500">{user?.email}</span>
                <button
                  onClick={handleSignOut}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium"
                >
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
