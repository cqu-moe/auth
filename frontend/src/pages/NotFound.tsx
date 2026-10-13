import { Link } from "react-router-dom";
import { Button } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";

export default function NotFound() {
  return (
    <AuthLayout title="找不到这个页面" description="链接可能已失效，或地址输入有误。">
      <p className="mb-5 text-sm text-muted-foreground">你可以返回账户首页，继续管理账户与校园服务。</p>
      <Button asChild className="w-full"><Link to="/">返回首页</Link></Button>
    </AuthLayout>
  );
}
