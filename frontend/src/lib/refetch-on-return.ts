export function refetchOnReturn(refetch: () => unknown): () => void {
  let busy = false;
  const run = async () => {
    if (document.visibilityState !== "visible" || busy) return;
    busy = true;
    try {
      await refetch();
    } finally {
      busy = false;
    }
  };
  const safeRun = () => {
    void run().catch(() => undefined);
  };

  window.addEventListener("focus", safeRun);
  document.addEventListener("visibilitychange", safeRun);
  return () => {
    window.removeEventListener("focus", safeRun);
    document.removeEventListener("visibilitychange", safeRun);
  };
}
