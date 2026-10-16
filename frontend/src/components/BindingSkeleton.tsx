import { Skeleton } from "@cqu-moe/ui";

function StepIndicatorSkeleton() {
  return (
    <div className="mb-8 grid grid-cols-4" aria-hidden="true">
      {[0, 1, 2, 3].map((step) => (
        <div key={step} className="flex flex-col items-center gap-2">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

function IntroSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="divide-y divide-border">
        {[0, 1, 2].map((item) => (
          <div key={item} className="flex items-start gap-3 py-4 first:pt-0">
            <Skeleton className="mt-1 size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
      <Skeleton className="h-16 w-full rounded-lg" />
      <Skeleton className="h-11 w-full sm:h-9" />
    </div>
  );
}

function CredentialsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <div className="space-y-4">
        <div className="field">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-11 w-full sm:h-10" />
        </div>
        <div className="field">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-11 w-full sm:h-9" />
      </div>
      <Skeleton className="h-16 w-full rounded-lg" />
    </div>
  );
}

export function BindingSkeleton({ repair = false }: { repair?: boolean }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">正在确认绑定状态…</span>
      {repair ? <CredentialsSkeleton /> : <StepIndicatorSkeleton />}
      {repair ? null : <IntroSkeleton />}
    </div>
  );
}
