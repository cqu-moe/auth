import { LogOut } from "lucide-react";
import { Button, ThemeMenu } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";

/** 两个外壳（设置/管理）共用的顶栏工具区：邮箱、主题、退出。 */
export default function ShellUtilities({ onSignOut }: { onSignOut: () => void }) {
  const { data: session } = authClient.useSession();
  const user = session?.user as { email?: string } | undefined;
  return (
    <>
      {user?.email && (
        <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:inline">
          {user.email}
        </span>
      )}
      <ThemeMenu />
      {session && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="退出登录"
          onClick={() => void onSignOut()}
        >
          <LogOut aria-hidden="true" />
        </Button>
      )}
    </>
  );
}
