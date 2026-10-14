/** Typed external AllCourseSchedule capture contract (T03: admin classes). */

export type ExternalCaptureSourceType = "admin_class" | "course";

export interface CquExternalCaptureArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  sourceType: ExternalCaptureSourceType;
  targetId: string;
  targetName: string;
  expectedSessionId?: string;
  /** Reserved for the future teaching-class recipe; admin classes cannot set it. */
  courseId?: string;
  courseName?: string;
  deadlineAt?: number;
}

export interface ExternalCaptureRecipe {
  action: "admin_class_capture" | "teaching_class_capture";
  courseId?: string;
  courseName?: string;
  sourceType: ExternalCaptureSourceType;
  targetId: string;
  targetName: string;
  expectedSessionId: string;
}

export interface ExternalCaptureTimetableRow {
  courseName?: string;
  instructorName?: string;
  roomName?: string;
  position?: string;
  campusName?: string;
  weekDay?: number;
  teachingWeek?: string;
  period?: string;
  exprProjectName?: string;
  classId?: string;
  assignTeachingObject?: Array<{ adminClassId: string }>;
}

export interface CquExternalCaptureResult {
  contractVersion: 1;
  course?: { id: string; name: string };
  sourceType: ExternalCaptureSourceType;
  target: { id: string; name: string };
  session: { id: string; name: string; beginDate: string };
  timetable: {
    classTimetableVOList: ExternalCaptureTimetableRow[];
    maxSection: number;
  };
}

const ARG_KEYS = new Set([
  "clientId",
  "clientSecret",
  "userId",
  "sourceType",
  "targetId",
  "targetName",
  "expectedSessionId",
  "courseId",
  "courseName",
  "deadlineAt",
]);
const RECIPE_KEYS = new Set([
  "courseId",
  "courseName",
  "action",
  "sourceType",
  "targetId",
  "targetName",
  "expectedSessionId",
]);

const TEXT_LIMIT = 200;

function boundedText(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function boundedOptionalText(value: unknown, limit = TEXT_LIMIT): string | null {
  if (value === undefined || value === "") return "";
  return boundedText(value, limit);
}

export function parseExternalCaptureArgs(
  args: unknown
): ExternalCaptureRecipe | { error: "INVALID_REQUEST" } {
  if (typeof args !== "object" || args === null) return { error: "INVALID_REQUEST" };
  const raw = args as Record<string, unknown>;
  if (Object.keys(raw).some(key => !ARG_KEYS.has(key))) return { error: "INVALID_REQUEST" };
  if (raw.sourceType !== "admin_class" && raw.sourceType !== "course") return { error: "INVALID_REQUEST" };
  const targetId = boundedText(raw.targetId, 100);
  const targetName = boundedText(raw.targetName);
  const expectedSessionId = boundedOptionalText(raw.expectedSessionId, 100);
  if (!targetId || !targetName || expectedSessionId === null) return { error: "INVALID_REQUEST" };
  if (raw.sourceType === "course") {
    const parsed = parseExternalCaptureRecipe({ action: "teaching_class_capture", sourceType: "course", targetId, targetName, expectedSessionId, courseId: raw.courseId, courseName: raw.courseName });
    return "error" in parsed ? { error: "INVALID_REQUEST" } : parsed;
  }
  if (raw.courseId !== undefined || raw.courseName !== undefined) return { error: "INVALID_REQUEST" };
  const recipe = parseExternalCaptureRecipe({
    action: "admin_class_capture",
    sourceType: "admin_class",
    targetId,
    targetName,
    expectedSessionId,
  });
  return "error" in recipe ? { error: "INVALID_REQUEST" as const } : recipe;
}

export function parseExternalCaptureRecipe(
  value: unknown
): ExternalCaptureRecipe | { error: "INVALID_CAPTURE_RECIPE" } {
  if (typeof value !== "object" || value === null) return { error: "INVALID_CAPTURE_RECIPE" };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !RECIPE_KEYS.has(key))) {
    return { error: "INVALID_CAPTURE_RECIPE" };
  }
  if (raw.action === "teaching_class_capture" && raw.sourceType === "course") {
    const targetId = boundedText(raw.targetId, 100), targetName = boundedText(raw.targetName);
    const courseId = boundedText(raw.courseId, 100), courseName = boundedText(raw.courseName);
    const expectedSessionId = boundedText(raw.expectedSessionId, 100);
    return targetId && targetName && courseId && courseName && expectedSessionId
      ? { action: "teaching_class_capture", sourceType: "course", targetId, targetName, courseId, courseName, expectedSessionId }
      : { error: "INVALID_CAPTURE_RECIPE" };
  }
  if (raw.courseId !== undefined || raw.courseName !== undefined) return { error: "INVALID_CAPTURE_RECIPE" };
  if (raw.action !== "admin_class_capture" || raw.sourceType !== "admin_class") {
    return { error: "INVALID_CAPTURE_RECIPE" };
  }
  const targetId = boundedText(raw.targetId, 100);
  const targetName = boundedText(raw.targetName);
  const expectedSessionId = boundedOptionalText(raw.expectedSessionId, 100);
  if (!targetId || !targetName || expectedSessionId === null) {
    return { error: "INVALID_CAPTURE_RECIPE" };
  }
  return {
    action: "admin_class_capture",
    sourceType: "admin_class",
    targetId,
    targetName,
    expectedSessionId,
  };
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, 500) ?? undefined;
}

function parseTarget(value: unknown, expected: ExternalCaptureRecipe): CquExternalCaptureResult["target"] | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedText(raw.id, 100);
  const name = boundedText(raw.name);
  return id === expected.targetId && name === expected.targetName ? { id, name } : null;
}

function parseSession(value: unknown): CquExternalCaptureResult["session"] | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedText(raw.id, 100);
  const name = boundedText(raw.name, 100);
  const beginDate = boundedText(raw.beginDate, 10);
  if (!id || !name || !beginDate || !/^\d{4}-\d{2}-\d{2}$/.test(beginDate)) return null;
  return { id, name, beginDate };
}

function parseRow(value: unknown, targetId: string, sourceType: ExternalCaptureSourceType): ExternalCaptureTimetableRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (sourceType === "course") {
    if (boundedText(raw.classId, 100) !== targetId) return null;
    const row: ExternalCaptureTimetableRow = { classId: targetId };
    for (const key of ["courseName", "instructorName", "roomName", "position", "campusName", "teachingWeek", "period", "exprProjectName"] as const) {
      if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "" && boundedText(raw[key], 500) === null) return { classId: targetId };
      const text = optionalText(raw[key]);
      if (text !== undefined) row[key] = text;
    }
    if (raw.weekDay !== undefined && raw.weekDay !== null) {
      if (typeof raw.weekDay !== "number" || !Number.isSafeInteger(raw.weekDay) || raw.weekDay < 1 || raw.weekDay > 7) return { classId: targetId };
      row.weekDay = raw.weekDay;
    }
    return row;
  }
  const assignments = raw.assignTeachingObject;
  if (!Array.isArray(assignments) || assignments.length === 0) return null;
  const assignTeachingObject: Array<{ adminClassId: string }> = [];
  for (const assignment of assignments) {
    if (typeof assignment !== "object" || assignment === null) return null;
    const adminClassId = boundedText((assignment as Record<string, unknown>).adminClassId, 100);
    if (!adminClassId) return null;
    assignTeachingObject.push({ adminClassId });
  }
  if (!assignTeachingObject.some(assignment => assignment.adminClassId === targetId)) return null;
  const contentKeys = ["courseName", "instructorName", "roomName", "position", "campusName", "teachingWeek", "period", "exprProjectName"] as const;
  const invalidContent = contentKeys.some(key => raw[key] !== undefined && raw[key] !== null && raw[key] !== "" && boundedText(raw[key], 500) === null);
  const weekDay = raw.weekDay;
  if (invalidContent || (weekDay !== undefined && weekDay !== null && (typeof weekDay !== "number" || !Number.isSafeInteger(weekDay) || weekDay < 1 || weekDay > 7))) {
    return { assignTeachingObject };
  }
  const row: ExternalCaptureTimetableRow = { assignTeachingObject };
  for (const key of contentKeys) {
    const text = optionalText(raw[key]);
    if (text !== undefined) row[key] = text;
  }
  if (typeof weekDay === "number") row.weekDay = weekDay;
  return row;
}

export function parseExternalCaptureResult(
  value: unknown,
  expected: ExternalCaptureRecipe
): CquExternalCaptureResult | { error: "SCHEMA_INVALID" } {
  if (typeof value !== "object" || value === null) return { error: "SCHEMA_INVALID" };
  const root = value as Record<string, unknown>;
  if (root.contractVersion !== 1 || root.sourceType !== expected.sourceType) {
    return { error: "SCHEMA_INVALID" };
  }
  const target = parseTarget(root.target, expected);
  const session = parseSession(root.session);
  const timetable = root.timetable;
  if (!target || !session || typeof timetable !== "object" || timetable === null) {
    return { error: "SCHEMA_INVALID" };
  }
  const rawRows = (timetable as Record<string, unknown>).classTimetableVOList;
  const maxSection = (timetable as Record<string, unknown>).maxSection;
  if (!Array.isArray(rawRows) || typeof maxSection !== "number" ||
      !Number.isSafeInteger(maxSection) || maxSection < 1 || maxSection > 14) {
    return { error: "SCHEMA_INVALID" };
  }
  for (const object of [root, root.target, root.session, timetable]) {
    if (Object.entries(object as Record<string, unknown>).some(([key, value]) => Array.isArray(value) && !(object === timetable && key === "classTimetableVOList"))) return { error: "SCHEMA_INVALID" };
  }
  if (expected.expectedSessionId && expected.expectedSessionId !== session.id) return { error: "SCHEMA_INVALID" };
  const rows: ExternalCaptureTimetableRow[] = [];
  for (const row of rawRows) {
    const parsed = parseRow(row, expected.targetId, expected.sourceType);
    if (!parsed) return { error: "SCHEMA_INVALID" };
    rows.push(parsed);
  }
  let course: { id: string; name: string } | undefined;
  if (expected.sourceType === "course") {
    const raw = root.course as Record<string, unknown> | undefined;
    if (!raw || boundedText(raw.id, 100) !== expected.courseId || boundedText(raw.name) !== expected.courseName) return { error: "SCHEMA_INVALID" };
    course = { id: expected.courseId!, name: expected.courseName! };
  }
  return {
    ...(course ? { course } : {}),
    contractVersion: 1,
    sourceType: expected.sourceType,
    target,
    session,
    timetable: { classTimetableVOList: rows, maxSection },
  };
}
