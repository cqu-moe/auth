import { ReactNode } from "react";

interface SettingsCardProps {
  title: string;
  description?: string;
  /** 头部右侧操作（链接/按钮），垂直居顶对齐标题。 */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * 设置页统一的区块卡片外壳：alpha 边框 + 极轻投影，标题/描述在头部，
 * 与正文之间用细分隔线分开。所有设置区块共用，避免每张卡片各写各的样式。
 */
export default function SettingsCard({ title, description, action, children }: SettingsCardProps) {
  return (
    <section className="rounded-2xl border border-gray-950/[0.08] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}
