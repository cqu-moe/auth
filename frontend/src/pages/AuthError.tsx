import { Link } from "react-router-dom";
import { Button, PageState } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";

export default function AuthError() {
  return (
    <AuthLayout title="认证未完成" description="认证请求无效或已过期。">
      <PageState
        state="error"
        title="认证请求无效或已过期"
        description="请返回登录页后重试。"
        action={
          <Button asChild>
            <Link to="/login">返回登录</Link>
          </Button>
        }
      />
    </AuthLayout>
  );
}
