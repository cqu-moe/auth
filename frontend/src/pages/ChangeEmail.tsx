import { useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import { AccountEmailChangeSection } from "../components/AccountProfileSection";
import { authClient } from "../lib/auth-client";

export default function ChangeEmail() {
  const { data: session } = authClient.useSession();
  const [searchParams] = useSearchParams();
  const user = session?.user as { email?: string } | undefined;

  return (
    <Layout>
      <div className="max-w-2xl">
        <AccountEmailChangeSection
          email={user?.email ?? ""}
          emailFlowReturned={searchParams.get("email-change") === "confirmed"}
        />
      </div>
    </Layout>
  );
}
