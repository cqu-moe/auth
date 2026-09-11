import { useState } from "react";
import Layout from "../components/Layout";
import { UsersSection } from "../features/admin/UsersSection";
import { EntitlementsSection } from "../features/admin/EntitlementsSection";
import { InvitationsSection } from "../features/admin/InvitationsSection";
import { OAuthClientsSection } from "../features/admin/OAuthClientsSection";

type Tab = "users" | "presets" | "invitations" | "oauth";

export default function Admin() {
  const [activeTab, setActiveTab] = useState<Tab>("users");
  const tabs: { key: Tab; label: string }[] = [
    { key: "users", label: "用户管理" },
    { key: "presets", label: "权益预设" },
    { key: "invitations", label: "注册邀请" },
    { key: "oauth", label: "OAuth 客户端" },
  ];
  return (
    <Layout>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">管理控制台</h1>
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit mb-6">
          {tabs.map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === tab.key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          {activeTab === "users" && <UsersSection />}
          {activeTab === "presets" && <EntitlementsSection />}
          {activeTab === "invitations" && <InvitationsSection />}
          {activeTab === "oauth" && <OAuthClientsSection />}
        </div>
      </div>
    </Layout>
  );
}
