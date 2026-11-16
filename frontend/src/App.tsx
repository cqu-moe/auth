import RecentAuthentication from "./components/RecentAuthentication";
import { lazy, Suspense, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, matchPath, useLocation } from "react-router-dom";
import { EntitlementsSkeleton, InvitationsSkeleton, OAuthClientsSkeleton } from "./features/admin/AdminSkeletons";
import { UsersRouteSkeleton } from "./components/RouteSkeleton";
import SessionPending from "./components/SessionPending";
import { authClient } from "./lib/auth-client";
import EntryLayout from "./components/EntryLayout";
import PassportAuthLayout from "./components/PassportAuthLayout";
import Login from "./pages/Login";
import Home from "./pages/Home";
import ProtectedRoute from "./components/ProtectedRoute";
import EmailVerificationGate from "./components/EmailVerificationGate";
import AuthError from "./pages/AuthError";
import NotFound from "./pages/NotFound";
import AdminLayout, { AdminPage } from "./pages/Admin";
import {
  capturePostHogSessionReady,
  syncPostHogIdentity,
  syncPostHogReplay,
} from "./lib/posthog";

const Settings = lazy(() => import("./pages/Settings"));
const Register = lazy(() => import("./pages/Register"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const ResetPasswordConfirm = lazy(() => import("./pages/ResetPasswordConfirm"));
const OAuthAuthorize = lazy(() => import("./pages/OAuthAuthorize"));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail"));
const TwoFactorChallenge = lazy(() => import("./pages/TwoFactorChallenge"));
const SettingsCqu = lazy(() => import("./pages/Settings").then(module => ({ default: module.SettingsCqu })));
const SettingsSecurity = lazy(() => import("./pages/Settings").then(module => ({ default: module.SettingsSecurity })));
const ChangeEmail = lazy(() => import("./pages/ChangeEmail"));
const CquBindWizard = lazy(() => import("./pages/CquBindWizard"));
const TwoFactorSettings = lazy(() => import("./pages/TwoFactorSettings"));
const UsersSection = lazy(() => import("./features/admin/UsersSection").then(module => ({ default: module.UsersSection })));
const EntitlementsSection = lazy(() => import("./features/admin/EntitlementsSection").then(module => ({ default: module.EntitlementsSection })));
const InvitationsSection = lazy(() => import("./features/admin/InvitationsSection").then(module => ({ default: module.InvitationsSection })));
const OAuthClientsSection = lazy(() => import("./features/admin/OAuthClientsSection").then(module => ({ default: module.OAuthClientsSection })));

const pageTitles = {
  "/": "连接你的校园服务",
  "/login": "登录",
  "/register": "创建账号",
  "/reset-password": "重置密码",
  "/reset-password/confirm": "设置新密码",
  "/verify-email": "验证邮箱",
  "/two-factor": "二次验证",
  "/auth/error": "认证未完成",
  "/settings": "账户",
  "/settings/security": "安全",
  "/settings/cqu": "CQU 集成",
  "/settings/email": "修改登录邮箱",
  "/settings/two-factor": "设置二次验证",
  "/admin": "管理控制台",
  "/admin/users": "用户管理",
  "/admin/presets": "权益预设",
  "/admin/invitations": "注册邀请",
  "/admin/oauth": "OAuth 客户端",
  "/oauth/authorize": "授权请求",
  "/cqu/bind": "绑定 CQU 账号",
};

function DocumentTitle() {
  const { pathname } = useLocation();
  const title = Object.entries(pageTitles).find(([path]) => matchPath(path, pathname))?.[1] ?? "找不到这个页面";
  useEffect(() => {
    // Reuse the HTML fallback title, including while a lazy route is loading.
    document.title = `${title} · CQU Auth`;
  }, [title]);
  return null;
}

function PostHogLifecycle() {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const previousUserId = useRef<string | null | undefined>(undefined);
  const readyUserId = useRef<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    const currentUserId = (session?.user as { id?: string } | undefined)?.id ?? null;
    syncPostHogIdentity(previousUserId.current, currentUserId);
    if (currentUserId && readyUserId.current !== currentUserId) {
      capturePostHogSessionReady();
      readyUserId.current = currentUserId;
    }
    previousUserId.current = currentUserId;
  }, [isPending, session]);

  useEffect(() => {
    void syncPostHogReplay(location.pathname);
  }, [location.pathname]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <DocumentTitle />
      <PostHogLifecycle />
      <RecentAuthentication />
      <Suspense fallback={<SessionPending message="正在加载页面…" />}>
        <Routes>
          <Route element={<EntryLayout />}>
            <Route index element={<Home />} />
            <Route element={<PassportAuthLayout />}>
              <Route element={<EmailVerificationGate><Outlet /></EmailVerificationGate>}>
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/reset-password/confirm" element={<ResetPasswordConfirm />} />
                <Route path="/verify-email" element={<VerifyEmail />} />
                <Route path="/two-factor" element={<TwoFactorChallenge />} />
              </Route>
            </Route>
          </Route>
          <Route element={<EmailVerificationGate><Outlet /></EmailVerificationGate>}>
            <Route path="/auth/error" element={<AuthError />} />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings/security"
              element={
                <ProtectedRoute>
                  <SettingsSecurity />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings/cqu"
              element={
                <ProtectedRoute>
                  <SettingsCqu />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings/email"
              element={
                <ProtectedRoute>
                  <ChangeEmail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings/two-factor"
              element={
                <ProtectedRoute>
                  <TwoFactorSettings />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute requireAdmin>
                  <AdminLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/admin/users" replace />} />
              <Route
                path="users"
                element={
                  <AdminPage title="用户管理" description="查看用户、调整角色与封禁状态。">
                    <Suspense fallback={<UsersRouteSkeleton />}><UsersSection /></Suspense>
                  </AdminPage>
                }
              />
              <Route
                path="presets"
                element={
                  <AdminPage title="权益预设" description="维护能力预设与新用户默认权益。">
                    <Suspense fallback={<EntitlementsSkeleton />}><EntitlementsSection /></Suspense>
                  </AdminPage>
                }
              />
              <Route
                path="invitations"
                element={
                  <AdminPage title="注册邀请" description="生成与管理注册邀请码。">
                    <Suspense fallback={<InvitationsSkeleton />}><InvitationsSection /></Suspense>
                  </AdminPage>
                }
              />
              <Route
                path="oauth"
                element={
                  <AdminPage title="OAuth 客户端" description="管理第三方应用的 OAuth 接入。">
                    <Suspense fallback={<OAuthClientsSkeleton />}><OAuthClientsSection /></Suspense>
                  </AdminPage>
                }
              />
            </Route>
            <Route
              path="/oauth/authorize"
              element={
                <ProtectedRoute>
                  <OAuthAuthorize />
                </ProtectedRoute>
              }
            />
            <Route
              path="/cqu/bind"
              element={
                <ProtectedRoute>
                  <CquBindWizard />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
