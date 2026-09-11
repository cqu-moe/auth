import type { ApiSuccess } from "../../../../shared/api-response";
import { apiRequest } from "./http";

export async function getRegistrationSettings(signal?: AbortSignal) {
  const body = await apiRequest<ApiSuccess<{ invitationRequired: boolean }>>(
    "/registration-settings",
    { signal }
  );
  return body.data;
}
