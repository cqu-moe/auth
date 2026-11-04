import { authClient } from "./auth-client";

type SessionState = ReturnType<typeof authClient.useSession>;

/** A sign-in signal can supersede refetch(): its promise resolves on abort,
 * before the replacement request publishes the session that route guards see. */
export async function refreshLoginSession() {
  const session = authClient.$store.atoms.session;
  const read = (): SessionState => session.get();
  await read().refetch();
  const settled = await new Promise<SessionState>(resolve => {
    const check = () => {
      const state = read();
      if (state.isRefetching || state.isPending) return;
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = session.listen(check);
    check();
  });
  if (settled.error || !settled.data?.user) throw new Error("无法确认登录状态");
  return settled.data;
}
