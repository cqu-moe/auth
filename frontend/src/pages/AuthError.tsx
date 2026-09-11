import { Link } from "react-router-dom";

export default function AuthError() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">认证未完成</h1>
        <p className="mt-3 text-sm text-gray-600">认证请求无效或已过期，请返回登录页后重试。</p>
        <Link className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white" to="/login">
          返回登录
        </Link>
      </div>
    </div>
  );
}
