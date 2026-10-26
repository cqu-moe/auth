import { Skeleton } from "@cqu-moe/ui";
import CopyButton from "./CopyButton";

export default function BindingAddress({
  address,
  label = "密保邮箱",
  loading = false,
}: {
  address: string;
  label?: string;
  loading?: boolean;
}) {
  return (
    <div className="binding-address flex items-center gap-3 rounded-lg border border-border px-4 py-3" aria-busy={loading}>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-5 w-64 max-w-full" />
        ) : (
          <p className="mt-1 wrap-anywhere font-sans text-sm font-medium leading-normal text-foreground">{address}</p>
        )}
      </div>
      {loading ? (
        <div className="flex size-11 shrink-0 items-center justify-center" aria-hidden="true">
          <Skeleton className="size-4" />
        </div>
      ) : (
        <CopyButton text={address} iconOnly />
      )}
    </div>
  );
}
