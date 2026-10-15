/** Typed weekly AllCourseSchedule directory contract. */

export type ExternalDirectoryCatalogSourceType =
  | "department"
  | "room"
  | "laboratory"
  | "admin_class"
  | "course_catalog"
  | "teaching_class";

export interface CquExternalDirectoryArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  kind: "catalog";
  sourceType: ExternalDirectoryCatalogSourceType;
  expectedSessionId?: string;
  deadlineAt?: number;
}

export interface CquExternalDirectoryInstructorsArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  kind: "instructors";
  classIds: string[];
  expectedSessionId: string;
  deadlineAt?: number;
}

export type ExternalDirectoryRecipe =
  | {
      kind: "catalog";
      sourceType: ExternalDirectoryCatalogSourceType;
      expectedSessionId?: string;
    }
  | {
      kind: "instructors";
      classIds: string[];
      expectedSessionId: string;
    };

export interface ExternalDirectorySession {
  id: string;
  name: string;
}

export interface ExternalDirectoryItem {
  id: string;
  name: string;
  extra: string;
  departmentId?: string;
  grade?: string;
  courseCode?: string;
}

export interface ExternalDirectoryDepartmentNode {
  id: string;
  name: string;
  children?: ExternalDirectoryDepartmentNode[];
}

export type CquExternalDirectoryResult =
  | {
      contractVersion: 1;
      kind: "catalog";
      sourceType: ExternalDirectoryCatalogSourceType;
      session: ExternalDirectorySession;
      items?: ExternalDirectoryItem[];
      departments?: ExternalDirectoryDepartmentNode[];
    }
  | {
      contractVersion: 1;
      kind: "instructors";
      session: ExternalDirectorySession;
      classes: Array<{
        classId: string;
        items: Array<Pick<ExternalDirectoryItem, "id" | "name" | "extra" | "departmentId">>;
      }>;
    };

export const DIRECTORY_ITEM_CAPS = {
  department: 20_000,
  room: 10_000,
  laboratory: 5_000,
  admin_class: 20_000,
  course_catalog: 10_000,
  teaching_class: 20_000,
} as const satisfies Record<ExternalDirectoryCatalogSourceType, number>;

const INSTRUCTOR_ITEM_CAP = 200;
const COMMON_KEYS = new Set(["clientId", "clientSecret", "userId", "kind", "deadlineAt"]);
const CATALOG_KEYS = new Set([...COMMON_KEYS, "sourceType", "expectedSessionId"]);
const INSTRUCTOR_KEYS = new Set([...COMMON_KEYS, "classIds", "expectedSessionId"]);
const RECIPE_KEYS = new Set(["kind", "sourceType", "expectedSessionId", "classIds"]);
const TEXT_LIMIT = 200;

function boundedText(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function isCatalogSourceType(value: unknown): value is ExternalDirectoryCatalogSourceType {
  return value === "department" || value === "room" || value === "laboratory"
    || value === "admin_class" || value === "course_catalog" || value === "teaching_class";
}

export function parseExternalDirectoryArgs(
  args: unknown
): ExternalDirectoryRecipe | { error: "INVALID_REQUEST" } {
  if (typeof args !== "object" || args === null) return { error: "INVALID_REQUEST" };
  const raw = args as Record<string, unknown>;
  if (raw.deadlineAt !== undefined && !Number.isSafeInteger(raw.deadlineAt)) {
    return { error: "INVALID_REQUEST" };
  }
  if (raw.kind === "catalog") {
    if (Object.keys(raw).some(key => !CATALOG_KEYS.has(key))) return { error: "INVALID_REQUEST" };
    if (!isCatalogSourceType(raw.sourceType)) return { error: "INVALID_REQUEST" };
    const expectedSessionId = raw.expectedSessionId === undefined
      ? undefined
      : boundedText(raw.expectedSessionId, 100);
    if (expectedSessionId === null) return { error: "INVALID_REQUEST" };
    return {
      kind: "catalog",
      sourceType: raw.sourceType,
      ...(expectedSessionId === undefined ? {} : { expectedSessionId }),
    };
  }
  if (raw.kind === "instructors") {
    if (Object.keys(raw).some(key => !INSTRUCTOR_KEYS.has(key))) return { error: "INVALID_REQUEST" };
    const expectedSessionId = boundedText(raw.expectedSessionId, 100);
    if (!Array.isArray(raw.classIds) || !expectedSessionId) return { error: "INVALID_REQUEST" };
    const classIds: string[] = [];
    for (const rawClassId of raw.classIds) {
      const classId = boundedText(rawClassId, 100);
      if (classId === null) return { error: "INVALID_REQUEST" };
      classIds.push(classId);
    }
    if (classIds.length < 1 || classIds.length > 10 || classIds.some(id => !id || !/^\d+$/.test(id))) {
      return { error: "INVALID_REQUEST" };
    }
    if (new Set(classIds).size !== classIds.length) return { error: "INVALID_REQUEST" };
    return { kind: "instructors", classIds, expectedSessionId };
  }
  return { error: "INVALID_REQUEST" };
}

export function parseExternalDirectoryRecipe(
  value: unknown
): ExternalDirectoryRecipe | { error: "INVALID_DIRECTORY_RECIPE" } {
  const parsed = parseExternalDirectoryArgs(value);
  if ("error" in parsed) return { error: "INVALID_DIRECTORY_RECIPE" };
  if (Object.keys(value as Record<string, unknown>).some(key => !RECIPE_KEYS.has(key))) {
    return { error: "INVALID_DIRECTORY_RECIPE" };
  }
  return parsed;
}

function parseSession(value: unknown): ExternalDirectorySession | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== "id" && key !== "name")) return null;
  const id = boundedText(raw.id, 100);
  const name = boundedText(raw.name, 100);
  return id && name ? { id, name } : null;
}

function parseItem(value: unknown): ExternalDirectoryItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["id", "name", "extra", "departmentId", "grade", "courseCode"]);
  if (Object.keys(raw).some(key => !allowed.has(key))) return null;
  const id = boundedText(raw.id, 100);
  const name = boundedText(raw.name);
  const extra = raw.extra === undefined || raw.extra === "" ? "" : boundedText(raw.extra);
  if (!id || !name || extra === null) return null;
  const metadata: Pick<ExternalDirectoryItem, "departmentId" | "grade" | "courseCode"> = {};
  for (const key of ["departmentId", "grade", "courseCode"] as const) {
    if (raw[key] !== undefined) {
      const text = boundedText(raw[key], 100);
      if (text === null) return null;
      metadata[key] = text;
    }
  }
  if (metadata.grade !== undefined && !/^(?:19|20)\d{2}$/.test(metadata.grade)) return null;
  return { id, name, extra, ...metadata };
}

function parseDepartments(
  value: unknown,
  count: { value: number },
  seen: Set<string>,
  depth: number
): ExternalDirectoryDepartmentNode[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000 || depth > 8) return null;
  const nodes: ExternalDirectoryDepartmentNode[] = [];
  for (const rawValue of value) {
    if (++count.value >= DIRECTORY_ITEM_CAPS.department || typeof rawValue !== "object" || rawValue === null) {
      return null;
    }
    const raw = rawValue as Record<string, unknown>;
    if (Object.keys(raw).some(key => key !== "id" && key !== "name" && key !== "children")) return null;
    const id = boundedText(raw.id, 100);
    const name = boundedText(raw.name);
    if (!id || !name || seen.has(id)) return null;
    seen.add(id);
    const children = raw.children === undefined
      ? undefined
      : parseDepartments(raw.children, count, seen, depth + 1);
    if (children === null) return null;
    nodes.push(children === undefined ? { id, name } : { id, name, children });
  }
  return nodes;
}

export function parseExternalDirectoryResult(
  value: unknown,
  expected: ExternalDirectoryRecipe
): CquExternalDirectoryResult | { error: "SCHEMA_INVALID" } {
  if (typeof value !== "object" || value === null) return { error: "SCHEMA_INVALID" };
  const root = value as Record<string, unknown>;
  if (root.contractVersion !== 1 || root.kind !== expected.kind) return { error: "SCHEMA_INVALID" };
  const session = parseSession(root.session);
  if (!session) return { error: "SCHEMA_INVALID" };
  if (expected.expectedSessionId !== undefined && session.id !== expected.expectedSessionId) {
    return { error: "SCHEMA_INVALID" };
  }

  if (expected.kind === "instructors") {
    if (Object.keys(root).some(key => !["ok", "contractVersion", "kind", "session", "classes"].includes(key))) {
      return { error: "SCHEMA_INVALID" };
    }
    const rawClasses = root.classes;
    if (!Array.isArray(rawClasses) || rawClasses.length !== expected.classIds.length) {
      return { error: "SCHEMA_INVALID" };
    }
    const classes: Array<{
      classId: string;
      items: Array<Pick<ExternalDirectoryItem, "id" | "name" | "extra" | "departmentId">>;
    }> = [];
    for (let index = 0; index < expected.classIds.length; index += 1) {
      const classId = expected.classIds[index];
      const rawValue = rawClasses[index];
      if (typeof rawValue !== "object" || rawValue === null) return { error: "SCHEMA_INVALID" };
      const entry = rawValue as Record<string, unknown>;
      if (Object.keys(entry).some(key => key !== "classId" && key !== "items") || entry.classId !== classId) {
        return { error: "SCHEMA_INVALID" };
      }
      if (!Array.isArray(entry.items) || entry.items.length > INSTRUCTOR_ITEM_CAP) {
        return { error: "SCHEMA_INVALID" };
      }
      const items: Array<Pick<ExternalDirectoryItem, "id" | "name" | "extra" | "departmentId">> = [];
      const seen = new Set<string>();
      for (const itemValue of entry.items) {
        const item = parseItem(itemValue);
        if (!item || item.grade !== undefined || item.courseCode !== undefined || seen.has(item.id)) {
          return { error: "SCHEMA_INVALID" };
        }
        seen.add(item.id);
        items.push({ id: item.id, name: item.name, extra: item.extra, ...(item.departmentId === undefined ? {} : { departmentId: item.departmentId }) });
      }
      classes.push({ classId, items });
    }
    return { contractVersion: 1, kind: "instructors", session, classes };
  }

  if (root.sourceType !== expected.sourceType) return { error: "SCHEMA_INVALID" };
  if (expected.sourceType === "department") {
    if (Object.keys(root).some(key => !["ok", "contractVersion", "kind", "sourceType", "session", "departments"].includes(key))) {
      return { error: "SCHEMA_INVALID" };
    }
    if (root.items !== undefined || root.departments === undefined) return { error: "SCHEMA_INVALID" };
    const departments = parseDepartments(root.departments, { value: 0 }, new Set(), 0);
    return departments
      ? { contractVersion: 1, kind: "catalog", sourceType: expected.sourceType, session, departments }
      : { error: "SCHEMA_INVALID" };
  }

  if (Object.keys(root).some(key => !["ok", "contractVersion", "kind", "sourceType", "session", "items"].includes(key))) {
    return { error: "SCHEMA_INVALID" };
  }
  if (!Array.isArray(root.items) || root.items.length === 0 || root.items.length >= DIRECTORY_ITEM_CAPS[expected.sourceType] || root.departments !== undefined) {
    return { error: "SCHEMA_INVALID" };
  }
  const items: ExternalDirectoryItem[] = [];
  const seen = new Set<string>();
  for (const itemValue of root.items) {
    const item = parseItem(itemValue);
    if (!item || seen.has(item.id)) return { error: "SCHEMA_INVALID" };
    seen.add(item.id);
    items.push(item);
  }
  return { contractVersion: 1, kind: "catalog", sourceType: expected.sourceType, session, items };
}
