import type { EditorState } from "../types";
import { CQU_SCOPE_KEYS } from "../constants";
import type { ClientConfig } from "../types";

export function emptyEditorState(): EditorState {
  return {
    client_name: "",
    redirect_uris: [""],
    scope: "openid profile email",
    grant_types: ["authorization_code"],
    type: "web",
    skip_consent: false,
    client_uri: "",
    logo_uri: "",
    tos_uri: "",
    policy_uri: "",
    contacts: [],
    post_logout_redirect_uris: [],
    require_pkce: true,
    token_endpoint_auth_method: "client_secret_basic",
    response_types: ["code"],
    enable_end_session: false,
    metadata: "",
    cqu_scopes: [],
  };
}

export function stateFromClient(client: ClientConfig, cquScopes: string[]): EditorState {
  return {
    client_name: client.client_name ?? "",
    redirect_uris: client.redirect_uris.length ? client.redirect_uris : [""],
    // CQU scopes live in their own checkbox section; keep them out of the text
    // field so the two don't duplicate (buildPayload re-merges them on save).
    scope: (client.scope ?? "")
      .split(" ")
      .filter((s) => s && !CQU_SCOPE_KEYS.has(s))
      .join(" "),
    grant_types: client.grant_types.length ? client.grant_types : ["authorization_code"],
    type: client.type ?? "web",
    skip_consent: client.skip_consent,
    client_uri: client.client_uri ?? "",
    logo_uri: client.logo_uri ?? "",
    tos_uri: client.tos_uri ?? "",
    policy_uri: client.policy_uri ?? "",
    contacts: client.contacts,
    post_logout_redirect_uris: client.post_logout_redirect_uris,
    require_pkce: client.require_pkce,
    token_endpoint_auth_method: client.token_endpoint_auth_method ?? "client_secret_basic",
    response_types: client.response_types.length ? client.response_types : ["code"],
    enable_end_session: client.enable_end_session,
    metadata:
      client.metadata == null
        ? ""
        : typeof client.metadata === "string"
          ? client.metadata
          : JSON.stringify(client.metadata, null, 2),
    cqu_scopes: cquScopes,
  };
}

// Drop empty strings and trim entries from a string list.
export function cleanList(list: string[]): string[] {
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}
