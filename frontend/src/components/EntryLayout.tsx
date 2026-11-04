import { Button, ThemeMenu } from "@cqu-moe/ui";
import { ArrowUpRight } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { postLoginRedirectFromSearch, withRedirectParam } from "../lib/post-login-redirect";
import { Link, Outlet, useLocation } from "react-router-dom";
import BrandLogo from "./BrandLogo";
import "../entry.css";

function entryAction(pathname: string, hasSession: boolean) {
  if (pathname === "/" && hasSession) return { to: "/settings", label: "账号设置" };
  if (pathname === "/login") return { to: "/register", label: "创建账号" };
  if (pathname === "/verify-email") return { to: "/", label: "返回首页" };
  return { to: "/login", label: pathname === "/two-factor" ? "重新登录" : "登录" };
}

export default function EntryLayout() {
  const { pathname, search } = useLocation();
  const { data: session } = authClient.useSession();
  const home = pathname === "/";
  const action = entryAction(pathname, Boolean(session));
  const destination = action.to === "/login" || action.to === "/register"
    ? withRedirectParam(action.to, postLoginRedirectFromSearch(search)) : action.to;
  return (
    <div className="entry">
      <header className="entry-header">
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <Link className="entry-brand" to="/" aria-label="CQU Auth 首页">
          <BrandLogo />
          <span>CQU Auth</span>
        </Link>
        <nav aria-label="主导航" className="entry-nav">
          {home && <a className="nav-about" href="#how">如何开始</a>}
          <ThemeMenu />
          <Button asChild variant="ghost">
            <Link to={destination}>
              {action.label}
              <ArrowUpRight aria-hidden="true" size={16} />
            </Link>
          </Button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
