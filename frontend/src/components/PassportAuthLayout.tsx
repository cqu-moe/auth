import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, ThemeMenu } from "@cqu-moe/ui";
import { ArrowLeft, ArrowUpRight, LockKeyhole } from "lucide-react";
import {
  postLoginRedirectFromSearch,
  withRedirectParam,
} from "../lib/post-login-redirect";
import EntryHeader from "./EntryHeader";
import CampusPass from "./CampusPass";

export default function PassportAuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const { pathname, search } = useLocation();
  const isLogin = pathname === "/login";
  const alternate = withRedirectParam(
    isLogin ? "/register" : "/login",
    postLoginRedirectFromSearch(search),
  );
  return (
    <div className="entry">
      <EntryHeader>
        <ThemeMenu />
        <Button asChild variant="ghost">
          <Link to={alternate}>
            {isLogin ? "创建账号" : "登录"}
            <ArrowUpRight aria-hidden="true" size={16} />
          </Link>
        </Button>
      </EntryHeader>
      <main id="main-content" className="passport-auth-grid" tabIndex={-1}>
        <aside className="passport-auth-story">
          <span className="eyebrow">每一次出发，都从这里开始</span>
          <h2>
            校园很大，
            <br />
            我们帮你连接。
          </h2>
          <CampusPass interactive={false} />
          <p>
            课表、快捷登录、账号安全。
            <br />
            让常用的校园服务，有一个熟悉的入口。
          </p>
        </aside>
        <div className="form-side">
          <Link className="back-home" to="/">
            <ArrowLeft size={16} aria-hidden="true" />
            返回首页
          </Link>
          <div className="form-surface">
            <div className="auth-intro">
              <h1>{title}</h1>
              {description && (
                <div className="auth-description">{description}</div>
              )}
            </div>
            <div className="auth-card">{children}</div>
            <p className="auth-trust">
              <LockKeyhole size={14} aria-hidden="true" />
              登录的是 CQU Moe 账号，校园身份可稍后连接。
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
