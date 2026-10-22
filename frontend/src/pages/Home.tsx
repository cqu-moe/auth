import { Link } from "react-router-dom";
import { Button, ThemeMenu } from "@cqu-moe/ui";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Fingerprint,
  Link2,
  MoveUpRight,
  ShieldCheck,
} from "lucide-react";
import { authClient } from "../lib/auth-client";
import EntryHeader from "../components/EntryHeader";
import CampusPass from "../components/CampusPass";

export default function Home() {
  const { data: session } = authClient.useSession();
  const destination = session ? "/settings" : "/login";
  return (
    <div className="entry">
      <EntryHeader>
        <a className="nav-about" href="#how">
          如何开始
        </a>
        <ThemeMenu />
        <Button asChild variant="ghost">
          <Link to={destination}>
            {session ? "账号设置" : "登录"}
            <ArrowUpRight aria-hidden="true" size={16} />
          </Link>
        </Button>
      </EntryHeader>
      <main id="main-content" tabIndex={-1}>
        <section className="passport-hero">
          <div className="passport-copy">
            <span className="eyebrow">
              <span className="tiny-line" />
              CQU MOE · 校园连接计划
            </span>
            <h1>
              校园很大，
              <br />
              一个账号<span className="blue-word">就够。</span>
            </h1>
            <p className="hero-description">
              从每天的课表，到熟悉的校园网站。
              <br />
              用一个账号，连接你的 CQU Moe 校园服务。
            </p>
            <div className="hero-actions">
              <Button asChild size="lg" className="brand-action">
                <Link to={destination}>
                  {session ? "进入账号设置" : "开启校园日常"}
                  <ArrowRight aria-hidden="true" size={18} />
                </Link>
              </Button>
              <Link className="text-link" to="/register">
                初次见面？创建账号
              </Link>
            </div>
            <p className="hero-condition">
              CQU Moe 社区服务 · 部分功能需绑定校园身份
            </p>
            <a className="down-link" href="#how">
              <ArrowDown size={16} aria-hidden="true" />
              向下看看，如何开始
            </a>
          </div>
          <div className="passport-art">
            <CampusPass />
          </div>
        </section>
        <section className="feature-strip" aria-label="账号能力">
          <div>
            <Link2 size={22} aria-hidden="true" />
            <h2>一次认识，多处相见</h2>
            <p>同一个账号，访问接入的应用。</p>
          </div>
          <div>
            <Fingerprint size={22} aria-hidden="true" />
            <h2>用你熟悉的方式登录</h2>
            <p>支持密码、Passkey 与两步验证。</p>
          </div>
          <div>
            <ShieldCheck size={22} aria-hidden="true" />
            <h2>连接可见，授权可管</h2>
            <p>设备、校园绑定与应用权限集中管理。</p>
          </div>
        </section>
        <Guide />
        <section className="closing-note">
          <h2>下一站，你的校园日常。</h2>
          <Button asChild size="lg" className="brand-action">
            <Link to={destination}>
              {session ? "进入账号设置" : "开启校园日常"}
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
          </Button>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="entry-footer">
      <div>
        <span>CQU Moe</span>
        <p>为校园日常，做一点小事。</p>
      </div>
      <div className="footer-links">
        <a
          href="https://github.com/cqu-moe/auth"
          target="_blank"
          rel="noreferrer"
        >
          GitHub <ArrowUpRight size={14} aria-hidden="true" />
        </a>
        <a
          href="https://github.com/cqu-moe/auth/issues"
          target="_blank"
          rel="noreferrer"
        >
          问题反馈 <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
      <p className="independent-note">CQU Moe 社区项目 · 非学校官方服务</p>
    </footer>
  );
}

function Guide() {
  return (
    <section className="entry-guide" id="how" aria-labelledby="guide-title">
      <div className="guide-title">
        <span className="eyebrow">从这里开始</span>
        <h2 id="guide-title">
          把连接的事交给我们。
          <br />
          把校园生活留给你。
        </h2>
        <p>
          一个 CQU Moe 账号，连接支持的校园服务。
          <br />
          你的学校账号仍属于你。
        </p>
      </div>
      <ol className="guide-steps">
        <li>
          <span>01</span>
          <div>
            <h3>创建你的账号</h3>
            <p>使用邮箱注册。若注册页要求邀请码，请先联系邀请人。</p>
            <Link to="/register">
              前往注册 <MoveUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <h3>按需连接校园身份</h3>
            <p>使用需要校园身份的服务时，再按页面指引绑定 CQU 账号。</p>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <h3>从你需要的服务出发</h3>
            <p>在接入应用中继续操作；可用功能取决于账号权益与应用授权。</p>
          </div>
        </li>
      </ol>
      <div className="entry-faq">
        <details>
          <summary>这是学校的统一身份认证官网吗？</summary>
          <p>
            不是。CQU Auth 是 CQU Moe
            的社区账号服务。学校身份仅在相关功能需要时连接，请以页面提示区分 CQU
            Moe 账号与学校账号。
          </p>
        </details>
        <details>
          <summary>会使用哪些账号信息？</summary>
          <p>
            注册使用昵称、邮箱和密码。绑定校园身份与应用授权需要额外确认；可在账号设置中管理登录设备、校园绑定和应用权限。
          </p>
        </details>
        <details>
          <summary>忘记密码或校园连接失效怎么办？</summary>
          <p>
            忘记 CQU Moe 密码时可使用<Link to="/reset-password">邮箱重置</Link>
            。校园连接失效时，在账号设置中按提示重新绑定；不要通过重复注册解决连接问题。
          </p>
        </details>
      </div>
    </section>
  );
}
