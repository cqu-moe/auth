import { useState } from "react";
import { Button } from "@cqu-moe/ui";
import { Fingerprint, ShieldCheck } from "lucide-react";
import BrandLogo from "./BrandLogo";

const services = [
  {
    name: "课表",
    subtitle: "把课表，放进你的日历。",
    note: "需要绑定 CQU 账号",
  },
  {
    name: "快捷登录",
    subtitle: "让常用的入口，更近一点。",
    note: "需要对应服务权益",
  },
  {
    name: "账号",
    subtitle: "你的账号，由你掌握。",
    note: "登录后进入账号设置",
  },
];

export default function CampusPass({
  interactive = true,
}: {
  interactive?: boolean;
}) {
  const [selected, setSelected] = useState(0);
  return (
    <div className="access-scene">
      <div className="orbit-line orbit-one" aria-hidden="true" />
      <div className="orbit-line orbit-two" aria-hidden="true" />
      <span className="scene-label" aria-hidden="true">
        CAMPUS, CONNECTED.
      </span>
      <div
        className="access-card"
        role="img"
        aria-label="CQU Moe 校园通行证：一个账号，按需连接"
      >
        <div className="card-top">
          <span>CQU MOE / ACCESS</span>
          <BrandLogo />
        </div>
        <div className="card-center">
          <BrandLogo />
          <div>
            <span>你的校园通行证</span>
            <strong>你好，同学。</strong>
          </div>
        </div>
        <div className="card-rule" />
        <div className="card-bottom">
          <span>一个账号 · 按需连接</span>
          <Fingerprint size={34} aria-hidden="true" />
        </div>
      </div>
      <div className="service-stamp" aria-hidden="true">
        <ShieldCheck size={22} />
        <span>
          连接在一起
          <br />
          <strong>权限由你决定</strong>
        </span>
      </div>
      {interactive && (
        <div className="card-explorer">
          <div className="service-tabs" role="group" aria-label="了解服务">
            {services.map((service, index) => (
              <Button
                key={service.name}
                variant="ghost"
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
              >
                {service.name}
              </Button>
            ))}
          </div>
          <div className="service-detail" aria-live="polite" aria-atomic="true">
            {services.map((service, index) => (
              <div
                className="service-detail-copy"
                key={service.name}
                aria-hidden={index !== selected}
              >
                <span>{service.subtitle}</span>
                <small>{service.note}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
