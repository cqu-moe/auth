import type { ApiSuccess } from "../../../../shared/api-response";
import type { BindingSnapshot } from "./types";
import { apiRequest } from "./http";

export async function getBinding(signal?: AbortSignal): Promise<BindingSnapshot> {
  return (await apiRequest<ApiSuccess<BindingSnapshot>>("/cqu/binding", { signal })).data;
}

export async function createBinding(kind: "direct" | "forward" = "direct") {
  return (await apiRequest<ApiSuccess<{ address: string; status: string }>>("/cqu/binding", {
    method: "POST",
    body: JSON.stringify({ kind }),
  })).data;
}

export async function deleteBinding() {
  await apiRequest<void>("/cqu/binding", { method: "DELETE" });
}

export async function updateCredentials(studentId: string, password: string, signal?: AbortSignal) {
  return (await apiRequest<ApiSuccess<{ studentId: string }>>("/cqu/binding/credentials", {
    method: "PUT",
    body: JSON.stringify({ studentId, password }),
    signal,
  })).data;
}

export async function getQuicklogin() {
  return (await apiRequest<ApiSuccess<{ eligible: boolean; enabled: boolean }>>("/cqu/quicklogin")).data;
}

export async function updateQuicklogin(enabled: boolean) {
  return (await apiRequest<ApiSuccess<{ enabled: boolean }>>("/cqu/quicklogin", {
    method: "PUT", body: JSON.stringify({ enabled }),
  })).data;
}
