import { Link } from "react-router-dom";

interface TwoFactorSettingsSectionProps {
  enabled: boolean;
}

export default function TwoFactorSettingsSection({ enabled }: TwoFactorSettingsSectionProps) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">二次验证</h3>
          <p className="mt-1 text-sm text-gray-500">
            {enabled ? "已启用身份验证器保护" : "尚未启用"}
          </p>
        </div>
        <Link
          to="/settings/two-factor"
          className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
        >
          {enabled ? "管理" : "设置"}
        </Link>
      </div>
    </div>
  );
}
