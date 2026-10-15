import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ThemeMenu } from "@cqu-moe/ui";
import BrandLogo from "./BrandLogo";

/**
 * 登录/注册/验证等未认证入口的独立品牌外壳：
 * 品牌顶栏 + 居中表单卡片，不显示业务侧栏。
 */
export default function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="auth-page">
      <header className="auth-header">
        <Link to="/login" className="auth-brand">
          <BrandLogo />
          CQU Auth
        </Link>
        <div className="auth-header-actions">
          <ThemeMenu />
        </div>
      </header>
      <main className="auth-main">
        <div className="auth-wrap">
          <div className="auth-intro">
            <h1>{title}</h1>
            {description && <div className="auth-description">{description}</div>}
          </div>
          <div className="auth-card">{children}</div>
        </div>
      </main>
      <footer className="auth-footer">
        CQU Auth <span>重庆大学统一认证</span>
      </footer>
    </div>
  );
}
