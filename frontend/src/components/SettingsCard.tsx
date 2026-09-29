import { ReactNode } from "react";

interface SettingsCardProps {
  title: string;
  description?: string;
  /** 头部右侧操作（链接/按钮），垂直居顶对齐标题。 */
  action?: ReactNode;
  children: ReactNode;
}

export default function SettingsCard({ title, description, action, children }: SettingsCardProps) {
  return (
    <section className="settings-card">
      <div className="settings-card-header flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}
