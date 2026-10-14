/** Typed external AllCourseSchedule search contract (T02: departments + admin classes). */

export type ExternalSearchSourceType = "department" | "admin_class";

export interface CquExternalSearchArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  sourceType: ExternalSearchSourceType;
  /** Empty means the school page's department filter is explicitly cleared. */
  departmentId?: string;
  departmentName?: string;
  grade?: string;
  keyword?: string;
  deadlineAt?: number;
}

export interface ExternalSearchSession {
  id: string;
  name: string;
}

export interface ExternalSearchItem {
  id: string;
  name: string;
  extra: string;
}

export interface ExternalDepartmentNode {
  id: string;
  name: string;
  children?: ExternalDepartmentNode[];
}

export type CquExternalSearchResult =
  | {
      contractVersion: 1;
      sourceType: "department";
      session: ExternalSearchSession;
      departments: ExternalDepartmentNode[];
    }
  | {
      contractVersion: 1;
      sourceType: "admin_class";
      session: ExternalSearchSession;
      items: ExternalSearchItem[];
      truncated: boolean;
    };

export interface ExternalSearchRecipe {
  action: "department_list" | "admin_class_search";
  departmentId: string;
  departmentName: string;
  grade: string;
  keyword: string;
}

function optionalString(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  return value;
}

export function parseExternalSearchRecipe(value: unknown): ExternalSearchRecipe | { error: "INVALID_SEARCH_RECIPE" } {
  if (typeof value !== "object" || value === null) return { error: "INVALID_SEARCH_RECIPE" };
  const raw = value as Record<string, unknown>;
  const action = raw.action;
  if (action !== "department_list" && action !== "admin_class_search") {
    return { error: "INVALID_SEARCH_RECIPE" };
  }
  if (Object.keys(raw).some(key => !["action", "departmentId", "departmentName", "grade", "keyword"].includes(key))) {
    return { error: "INVALID_SEARCH_RECIPE" };
  }
  const departmentId = optionalString(raw.departmentId);
  const departmentName = optionalString(raw.departmentName);
  const grade = optionalString(raw.grade);
  const keyword = optionalString(raw.keyword);
  if (departmentId === null || departmentName === null || grade === null || keyword === null) {
    return { error: "INVALID_SEARCH_RECIPE" };
  }
  if (
    departmentId.length > 100 || departmentName.length > 200 || keyword.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(departmentId + departmentName + keyword) ||
    (grade !== "" && !/^(?:19|20)\d{2}$/.test(grade))
  ) return { error: "INVALID_SEARCH_RECIPE" };
  if (action === "department_list" && (departmentId || departmentName || grade || keyword)) {
    return { error: "INVALID_SEARCH_RECIPE" };
  }
  return { action, departmentId, departmentName, grade, keyword };
}

const TEXT_LIMIT = 200;
const ITEM_LIMIT = 200;

function boundedText(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function parseExternalSearchArgs(
  args: unknown
): ExternalSearchRecipe | { error: "INVALID_REQUEST" } {
  if (typeof args !== "object" || args === null) return { error: "INVALID_REQUEST" };
  const raw = args as Record<string, unknown>;
  if (raw.sourceType !== "department" && raw.sourceType !== "admin_class") {
    return { error: "INVALID_REQUEST" };
  }
  const departmentId = optionalString(raw.departmentId);
  const departmentName = optionalString(raw.departmentName);
  const grade = optionalString(raw.grade);
  const keyword = optionalString(raw.keyword);
  if (
    departmentId === null || departmentName === null || grade === null || keyword === null ||
    raw.deadlineAt !== undefined && !Number.isSafeInteger(raw.deadlineAt)
  ) {
    return { error: "INVALID_REQUEST" };
  }
  if (keyword.length > 100) return { error: "INVALID_REQUEST" };
  if (/[\u0000-\u001f\u007f]/.test(keyword)) return { error: "INVALID_REQUEST" };

  if (
    departmentId.length > 100 ||
    departmentName.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(departmentId) ||
    /[\u0000-\u001f\u007f]/.test(departmentName)
  ) {
    return { error: "INVALID_REQUEST" };
  }
  if (grade !== "" && !/^(?:19|20)\d{2}$/.test(grade)) return { error: "INVALID_REQUEST" };

  if (raw.sourceType === "department") {
    return { action: "department_list", departmentId: "", departmentName: "", grade: "", keyword: "" };
  }
  return { action: "admin_class_search", departmentId, departmentName, grade, keyword };
}

function parseSession(value: unknown): ExternalSearchSession | null {
  if (typeof value !== "object" || value === null) return null;
  const id = boundedText((value as { id?: unknown }).id, 100);
  const name = boundedText((value as { name?: unknown }).name, 100);
  return id && name ? { id, name } : null;
}

function parseItem(value: unknown): ExternalSearchItem | null {
  if (typeof value !== "object" || value === null) return null;
  const id = boundedText((value as { id?: unknown }).id, 100);
  const name = boundedText((value as { name?: unknown }).name);
  const extra = boundedText((value as { extra?: unknown }).extra ?? "");
  return id && name ? { id, name, extra: extra ?? "" } : null;
}

function parseDepartments(value: unknown): ExternalDepartmentNode[] | null {
  if (!Array.isArray(value)) return null;
  const nodes: ExternalDepartmentNode[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const id = boundedText((raw as { id?: unknown }).id, 100);
    const name = boundedText((raw as { name?: unknown }).name);
    if (!id || !name) return null;
    const rawChildren = (raw as { children?: unknown }).children;
    const children = rawChildren === undefined ? undefined : parseDepartments(rawChildren);
    if (children === null) return null;
    nodes.push(children === undefined ? { id, name } : { id, name, children });
  }
  return nodes;
}

export function parseExternalSearchResult(
  value: unknown,
  expectedSourceType: ExternalSearchSourceType
): CquExternalSearchResult | { error: "SCHEMA_INVALID" } {
  if (typeof value !== "object" || value === null) return { error: "SCHEMA_INVALID" };
  const root = value as Record<string, unknown>;
  if (root.contractVersion !== 1 || root.sourceType !== expectedSourceType) {
    return { error: "SCHEMA_INVALID" };
  }
  const session = parseSession(root.session);
  if (!session) return { error: "SCHEMA_INVALID" };

  if (expectedSourceType === "department") {
    const departments = parseDepartments(root.departments);
    if (!departments) return { error: "SCHEMA_INVALID" };
    return { contractVersion: 1, sourceType: "department", session, departments };
  }

  if (!Array.isArray(root.items) || typeof root.truncated !== "boolean") {
    return { error: "SCHEMA_INVALID" };
  }
  const items: ExternalSearchItem[] = [];
  for (const raw of root.items.slice(0, ITEM_LIMIT)) {
    const item = parseItem(raw);
    if (!item) return { error: "SCHEMA_INVALID" };
    items.push(item);
  }
  return {
    contractVersion: 1,
    sourceType: "admin_class",
    session,
    items,
    truncated: root.truncated || root.items.length > ITEM_LIMIT,
  };
}
