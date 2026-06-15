export interface UserSearchQuery {
  searchField: "email" | "name";
  searchValue: string;
  searchOperator: "contains";
}

export function pickSearchField(raw: string | undefined | null): UserSearchQuery | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return { searchField: v.includes("@") ? "email" : "name", searchValue: v, searchOperator: "contains" };
}
