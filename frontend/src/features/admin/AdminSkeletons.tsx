import type { ReactNode } from "react";
import { ChevronRight, Copy, Plus } from "lucide-react";
import {
  ActionButton,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cqu-moe/ui";
import { CAPABILITIES, type Subsystem } from "../../../../shared/capabilities";
import { SUBSYSTEM_LABELS } from "../../components/entitlement-form";
import { FieldLabel } from "./ui";

const TABLE_ROWS = Array.from({ length: 6 }, (_, index) => index);
const LIST_ROWS = Array.from({ length: 4 }, (_, index) => index);
const GRANT_ROWS = Array.from({ length: 3 }, (_, index) => index);
const CQU_SCOPE_ROWS = Array.from({ length: 4 }, (_, index) => index);
const SUBSYSTEMS = Object.keys(CAPABILITIES) as Subsystem[];

function Bone({ className }: { className: string }) {
  return <Skeleton aria-hidden="true" className={className} />;
}

function LoadingSurface({
  announcement,
  className,
  children,
}: {
  announcement: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <div aria-hidden="true" className={className}>
        {children}
      </div>
    </div>
  );
}

export function UsersSkeleton({ canEditQuota = false }: { canEditQuota?: boolean }) {
  return (
    <LoadingSurface announcement="正在加载用户，正在读取用户列表…">
      <div className="divide-y divide-border sm:hidden">
        {TABLE_ROWS.map((row) => (
          <div key={row} className="py-4 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Skeleton className="w-28"><span className="invisible font-medium">用户姓名</span></Skeleton>
                <Bone className="h-4 w-56 max-w-full" />
              </div>
              <Bone className="h-6 w-14 rounded-full" />
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button type="button" size="sm" variant="outline" disabled className="w-36"><Bone className="h-4 w-24" /></Button>
              <Bone className="h-4 w-20" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {canEditQuota && (
                <Button type="button" variant="outline" disabled>
                  重置认证
                </Button>
              )}
              <Button type="button" variant="outline" disabled>
                权益
              </Button>
              <ActionButton type="button" variant="outline" disabled state="idle" labels={{ idle: "封禁", loading: "正在封禁…", success: "已封禁", error: "重试封禁" }} />
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">用户</TableHead>
              <TableHead className="text-left">角色</TableHead>
              <TableHead className="text-left">状态</TableHead>
              <TableHead className="text-left">注册时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TABLE_ROWS.map((row) => (
              <TableRow key={row}>
                <TableCell>
                  <Bone className="h-5 w-28" />
                  <Bone className="h-4 w-56 max-w-full" />
                </TableCell>
                <TableCell>
                  <Button type="button" size="sm" variant="outline" disabled className="w-36"><Bone className="h-4 w-24" /></Button>
                </TableCell>
                <TableCell>
                  <Bone className="h-6 w-14 rounded-full" />
                </TableCell>
                <TableCell>
                  <Bone className="h-4 w-20" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    {canEditQuota && (
                      <Button type="button" variant="outline" size="sm" disabled>
                        重置认证
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" disabled>
                      权益
                    </Button>
                    <ActionButton type="button" variant="outline" size="sm" disabled state="idle" labels={{ idle: "封禁", loading: "正在封禁…", success: "已封禁", error: "重试封禁" }} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </LoadingSurface>
  );
}

export function EntitlementsSkeleton() {
  return (
    <LoadingSurface announcement="正在加载预设，正在读取权益预设与默认配置…" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">新用户默认权益</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            注册成功后自动套用的预设;选「无」则新用户不带任何权益。
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled><Bone className="h-4 w-32" /></Button>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">全部预设</p>
          <Button type="button" size="sm" disabled>
            <Plus aria-hidden="true" size={16} />
            新建预设
          </Button>
        </div>

        <div className="divide-y divide-border rounded-lg border border-border">
          {LIST_ROWS.map((row) => (
            <div key={row} className="flex flex-col gap-4 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex min-h-7 items-center gap-2">
                  <Bone className="h-5 w-28" />
                  <Bone className="h-6 w-12 rounded-full" />
                </div>
                <Bone className="mt-0.5 h-4 w-72 max-w-full" />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled>
                  编辑
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </LoadingSurface>
  );
}

export function InvitationsSkeleton() {
  return (
    <LoadingSurface announcement="正在加载注册邀请，正在读取邀请与注册政策…" className="space-y-5">
      <div className="border-b border-border pb-5">
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="min-w-0 flex-1">
            <span className="text-sm text-foreground">强制邀请码注册</span>
            <Skeleton className="block text-xs"><span className="invisible">未填写邀请码无法注册;邀请码可携带指定权益预设。</span></Skeleton>
          </span>
          <Bone className="h-6 w-11 shrink-0 rounded-full" />
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-xs flex-1">
          <FieldLabel hint="使用该邀请码注册的用户获得对应权益">注册后权益</FieldLabel>
          <Bone className="h-10 w-full pointer-coarse:h-11" />
        </div>
        <ActionButton type="button" disabled state="idle" labels={{ idle: "生成邀请", loading: "正在生成…", success: "已生成", error: "重试生成" }} />
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">邀请码</TableHead>
              <TableHead className="text-left">状态</TableHead>
              <TableHead className="text-left">权益</TableHead>
              <TableHead className="text-left">过期时间</TableHead>
              <TableHead className="text-left">使用情况</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TABLE_ROWS.map((row) => (
              <TableRow key={row}>
                <TableCell>
                  <Bone className="h-6 w-28" />
                </TableCell>
                <TableCell>
                  <Bone className="h-6 w-16 rounded-full" />
                </TableCell>
                <TableCell>
                  <Bone className="h-4 w-16" />
                </TableCell>
                <TableCell>
                  <Bone className="h-4 w-36" />
                </TableCell>
                <TableCell>
                  <Bone className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="outline" size="xs" disabled><Copy aria-hidden="true" />复制</Button>
                    <ActionButton type="button" variant="destructive" size="sm" disabled state="idle" labels={{ idle: "撤销", loading: "撤销中…", success: "已撤销", error: "重试撤销" }} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </LoadingSurface>
  );
}

export function OAuthClientsSkeleton() {
  return (
    <LoadingSurface announcement="正在加载 OAuth 客户端，正在读取客户端列表…" className="space-y-4">
      <div className="flex items-center justify-between">
        <Bone className="h-4 w-24" />
        <Button type="button" size="sm" disabled>
          <Plus aria-hidden="true" size={16} />
          新建客户端
        </Button>
      </div>

      {LIST_ROWS.map((row) => (
        <div
          key={row}
          className="flex flex-col gap-4 border-b border-border py-5 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Bone className="h-5 w-40 max-w-full" />
            </div>
            <Bone className="mt-0.5 h-4 w-64 max-w-full" />
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:ml-4">
            <Button type="button" variant="outline" size="sm" disabled>
              编辑
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled>
              删除
            </Button>
          </div>
        </div>
      ))}
    </LoadingSurface>
  );
}

function EntitlementMatrixSkeleton() {
  return (
    <div className="space-y-5">
      {SUBSYSTEMS.map((subsystem) => {
        const capabilities = CAPABILITIES[subsystem];
        return (
          <div key={subsystem}>
            <p className="mb-2 text-xs font-semibold text-foreground">
              {SUBSYSTEM_LABELS[subsystem] ?? subsystem}
              <span className="ml-2 font-mono font-normal text-muted-foreground">
                {subsystem}
              </span>
            </p>
            <div className="space-y-1">
              {Object.entries(capabilities).map(([capability, definition]) => {
                const policyReadOnly =
                  capability === "quicklogin_device_limit" || capability === "quicklogin";
                return (
                  <div
                    key={capability}
                    className={`flex items-center gap-3 rounded-lg p-2 ${
                      definition.optional ? "flex-wrap" : ""
                    }`}
                  >
                    <span className="text-sm text-foreground">{definition.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {capability}
                    </span>
                    {policyReadOnly ? (
                      <div className="ml-auto flex items-center gap-3">
                        <Bone className="h-5 w-16" />
                        <p className="basis-full text-xs text-muted-foreground">
                          {definition.type === "quota"
                            ? "设备额度须通过专用预览流程调整"
                            : "总开关由用户在账户设置中管理"}
                        </p>
                      </div>
                    ) : definition.type === "flag" ? (
                      <Bone className="ml-auto size-4" />
                    ) : definition.optional ? (
                      <div className="ml-auto flex items-center gap-1.5">
                        <Bone className="h-8 w-32 pointer-coarse:h-11" />
                      </div>
                    ) : (
                      <div className="ml-auto flex items-center gap-1.5">
                        <Bone className="h-10 w-28 pointer-coarse:h-11" />
                        {definition.unit && (
                          <span className="text-xs text-muted-foreground">
                            {definition.unit}
                          </span>
                        )}
                      </div>
                    )}
                    {definition.optional && definition.hint && (
                      <p className="basis-full text-xs text-muted-foreground">
                        {definition.hint}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function UserEntitlementsSkeleton({
  canEditQuota = false,
}: {
  canEditQuota?: boolean;
}) {
  return (
    <LoadingSurface announcement="正在加载权益，正在读取该用户的权益与预设…" className="space-y-5">
      <div className="flex items-end gap-2 rounded-lg border border-border bg-muted p-3">
        <div className="flex-1">
          <FieldLabel hint="一键写入预设权益,之后仍可逐项调整">套用预设</FieldLabel>
          <Bone className="h-10 w-full pointer-coarse:h-11" />
        </div>
        <Button type="button" variant="outline" disabled>
          套用
        </Button>
      </div>

      <div className="border-t border-border pt-4">
        <EntitlementMatrixSkeleton />
      </div>

      {canEditQuota && (
        <section className="space-y-3 border-t border-border pt-4">
          <div>
            <h4 className="text-sm font-medium text-foreground">快捷登录设备额度</h4>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              降低额度会停用最近联系较早的设备，不会把设备退出。
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <span className="text-xs">设备数</span>
              <Bone className="h-10 w-28 pointer-coarse:h-11" />
            </div>
            <Button type="button" variant="outline" disabled>
              预览调整
            </Button>
          </div>
        </section>
      )}
    </LoadingSurface>
  );
}

export function OAuthClientEditorSkeleton({
  isEdit = false,
}: {
  isEdit?: boolean;
}) {
  return (
    <LoadingSurface announcement="正在加载客户端，正在读取客户端配置…" className="space-y-5">
      {isEdit && (
        <div>
          <FieldLabel>Client ID</FieldLabel>
          <Bone className="h-[2.125rem] w-full" />
        </div>
      )}

      <div>
        <FieldLabel htmlFor="oauth-client-name">名称</FieldLabel>
        <Bone className="h-10 w-full pointer-coarse:h-11" />
      </div>

      <div>
        <FieldLabel hint="至少一条">回调 URI (redirect_uris)</FieldLabel>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bone className="h-10 flex-1 pointer-coarse:h-11" />
            <Bone className="h-8 w-11 pointer-coarse:h-11 sm:w-8" />
          </div>
          <Button type="button" variant="link" size="sm" disabled className="px-0">
            <Plus aria-hidden="true" size={16} />
            添加回调 URI
          </Button>
        </div>
      </div>

      <div>
        <FieldLabel htmlFor="oauth-client-scope" hint="空格分隔">
          允许的 scope
        </FieldLabel>
        <Bone className="h-10 w-full pointer-coarse:h-11" />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-foreground">
          授权类型 (grant_types)
        </legend>
        <div className="space-y-1.5">
          {GRANT_ROWS.map((row) => (
            <div key={row} className="flex items-center gap-3 rounded-lg p-2">
              <Bone className="size-4" />
              <Bone className="h-5 flex-1" />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <FieldLabel>客户端类型 (type)</FieldLabel>
        <Bone className="h-10 w-full pointer-coarse:h-11" />
      </div>

      <div className="flex items-center justify-between gap-3 py-1">
        <span>
          <span className="text-sm text-foreground">跳过同意页</span>
          <span className="block text-xs text-muted-foreground">
            授权时不向用户展示同意页面
          </span>
        </span>
        <Bone className="h-6 w-11 shrink-0 rounded-full" />
      </div>

      <div className="border-t border-border pt-4">
        <Button type="button" variant="ghost" size="sm" disabled>
          <ChevronRight aria-hidden="true" />
          展开完整配置
        </Button>
      </div>

      <fieldset className="border-t border-border pt-4">
        <legend className="mb-2 text-xs font-medium text-foreground">CQU 服务权限</legend>
        <div className="space-y-1">
          {CQU_SCOPE_ROWS.map((row) => (
            <div key={row} className="flex items-center gap-3 rounded-lg p-2">
              <Bone className="size-4" />
              <Bone className="h-5 flex-1" />
              <Bone className="h-4 w-32" />
            </div>
          ))}
        </div>
      </fieldset>

      {isEdit && (
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium text-foreground">客户端密钥</p>
          <p className="mb-3 text-xs text-muted-foreground">
            出于安全考虑，现有密钥不会显示。重新生成后旧密钥立即失效。
          </p>
          <Button type="button" variant="outline" size="sm" disabled>
            重新生成密钥
          </Button>
        </div>
      )}
    </LoadingSurface>
  );
}
