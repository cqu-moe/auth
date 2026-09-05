import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { authClient } from "./lib/auth-client";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ResetPassword from "./pages/ResetPassword";
import ResetPasswordConfirm from "./pages/ResetPasswordConfirm";
import Settings from "./pages/Settings";
import ChangeEmail from "./pages/ChangeEmail";
import Admin from "./pages/Admin";
import OAuthAuthorize from "./pages/OAuthAuthorize";
import CquBindWizard from "./pages/CquBindWizard";
import VerifyEmail from "./pages/VerifyEmail";
import TwoFactorChallenge from "./pages/TwoFactorChallenge";
import TwoFactorSettings from "./pages/TwoFactorSettings";
import ProtectedRoute from "./components/ProtectedRoute";
import EmailVerificationGate from "./components/EmailVerificationGate";

function RootRedirect() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <Navigate to={session ? "/settings" : "/login"} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <EmailVerificationGate>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/reset-password/confirm" element={<ResetPasswordConfirm />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/two-factor" element={<TwoFactorChallenge />} />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
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
                <Admin />
              </ProtectedRoute>
            }
          />
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
        </Routes>
      </EmailVerificationGate>
    </BrowserRouter>
  );
}
