import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import BrandLogo from "./BrandLogo";
import "../entry.css";

export default function EntryHeader({ children }: { children: ReactNode }) {
  return (
    <header className="entry-header">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <Link className="entry-brand" to="/" aria-label="CQU Auth 首页">
        <BrandLogo />
        <span>CQU Auth</span>
      </Link>
      <nav aria-label="主导航" className="entry-nav">
        {children}
      </nav>
    </header>
  );
}
