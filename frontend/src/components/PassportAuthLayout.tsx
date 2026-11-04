import EntryTransition from "./EntryTransition";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import CampusPass from "./CampusPass";

export default function PassportAuthLayout() {
  const location = useLocation();
  return (
    <main id="main-content" className="passport-auth-grid" tabIndex={-1}>
      <EntryTransition name="passport-cover" default="none" share="cover-flight" exit="cover-leave">
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
      </EntryTransition>
      <div className="form-side">
        <Link className="back-home" to="/">
          <ArrowLeft size={16} aria-hidden="true" />
          返回首页
        </Link>
        <div className="form-surface">
          <Outlet key={location.key} />
          <p className="auth-trust">
            <LockKeyhole size={14} aria-hidden="true" />
            登录的是 CQU Moe 账号，校园身份可稍后连接。
          </p>
        </div>
      </div>
    </main>
  );
}
