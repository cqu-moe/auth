import Layout from "../components/Layout";
import EmailChangeFlow from "../components/EmailChangeFlow";
import { authClient } from "../lib/auth-client";

export default function ChangeEmail() {
  const { data: session, refetch } = authClient.useSession();
  const user = session?.user as { email?: string } | undefined;

  return (
    <Layout>
      <EmailChangeFlow
        currentEmail={user?.email ?? ""}
        onSessionRefresh={refetch}
      />
    </Layout>
  );
}
