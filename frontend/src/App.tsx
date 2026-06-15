import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { authClient } from "./lib/auth-client";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ResetPassword from "./pages/ResetPassword";
import ResetPasswordConfirm from "./pages/ResetPasswordConfirm";
import Dashboard from "./pages/Dashboard";
import Security from "./pages/Security";
import CquAccount from "./pages/CquAccount";
import Admin from "./pages/admin/Admin";
import OAuthAuthorize from "./pages/OAuthAuthorize";
import CquBindWizard from "./pages/CquBindWizard";
import ProtectedRoute from "./components/ProtectedRoute";
import FullPageSpinner from "./components/FullPageSpinner";

function RootRedirect() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <FullPageSpinner />;
  }

  return <Navigate to={session ? "/dashboard" : "/login"} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/reset-password/confirm" element={<ResetPasswordConfirm />} />
        <Route path="/settings" element={<Navigate to="/security" replace />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/security"
          element={
            <ProtectedRoute>
              <Security />
            </ProtectedRoute>
          }
        />
        <Route
          path="/cqu"
          element={
            <ProtectedRoute>
              <CquAccount />
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
    </BrowserRouter>
  );
}
