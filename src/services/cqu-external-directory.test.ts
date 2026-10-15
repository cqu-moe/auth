import { describe, expect, it } from "vitest";
import {
  DIRECTORY_ITEM_CAPS,
  parseExternalDirectoryArgs,
  parseExternalDirectoryResult,
} from "./cqu-external-directory";

const identity = {
  clientId: "calendar",
  clientSecret: "service-secret",
  userId: "user-1",
};

describe("parseExternalDirectoryArgs", () => {
  it("accepts only the fixed catalog and instructor recipes", () => {
    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "catalog",
      sourceType: "room",
    })).toEqual({ kind: "catalog", sourceType: "room" });

    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "catalog",
      sourceType: "admin_class",
      expectedSessionId: "1061",
    })).toEqual({
      kind: "catalog",
      sourceType: "admin_class",
      expectedSessionId: "1061",
    });

    const classIds = Array.from({ length: 10 }, (_, index) => String(index + 1));
    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "instructors",
      classIds,
      expectedSessionId: "1061",
    })).toEqual({ kind: "instructors", classIds, expectedSessionId: "1061" });

    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "catalog",
      sourceType: "room",
      expectedSessionId: "",
    })).toEqual({ error: "INVALID_REQUEST" });
    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "catalog",
      sourceType: "room",
      url: "https://example.com",
    })).toEqual({ error: "INVALID_REQUEST" });
    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "instructors",
      classIds: ["1", "1"],
      expectedSessionId: "1061",
    })).toEqual({ error: "INVALID_REQUEST" });
    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "instructors",
      classIds: Array.from({ length: 11 }, (_, index) => String(index + 1)),
      expectedSessionId: "1061",
    })).toEqual({ error: "INVALID_REQUEST" });
    expect(parseExternalDirectoryArgs({
      ...identity,
      kind: "instructors",
      classIds: ["class-1"],
      expectedSessionId: "1061",
    })).toEqual({ error: "INVALID_REQUEST" });
  });
});

describe("parseExternalDirectoryResult", () => {
  it("accepts an optional catalog term and rejects a mismatch without truncation", () => {
    const items = [
      { id: "room-1", name: "D101", extra: "学院楼" },
      { id: "room-2", name: "D102", extra: "" },
    ];
    const body = {
      ok: true,
      contractVersion: 1,
      kind: "catalog",
      sourceType: "room",
      session: { id: "1061", name: "2026秋" },
      items,
    };
    expect(parseExternalDirectoryResult(body, { kind: "catalog", sourceType: "room" }))
      .toEqual({
        contractVersion: 1,
        kind: "catalog",
        sourceType: "room",
        session: { id: "1061", name: "2026秋" },
        items,
      });
    expect(parseExternalDirectoryResult(
      { ...body, items: [...items, { id: "room-3", name: "D103", extra: "", secret: "SECRET" }] },
      { kind: "catalog", sourceType: "room" }
    )).toEqual({ error: "SCHEMA_INVALID" });
    expect(parseExternalDirectoryResult(body, {
      kind: "catalog", sourceType: "room", expectedSessionId: "1059",
    })).toEqual({ error: "SCHEMA_INVALID" });

    const atCap = Array.from({ length: DIRECTORY_ITEM_CAPS.room }, (_, index) => ({
      id: `room-${index}`,
      name: `D${index}`,
      extra: "",
    }));
    expect(parseExternalDirectoryResult({ ...body, items: atCap }, { kind: "catalog", sourceType: "room" }))
      .toEqual({ error: "SCHEMA_INVALID" });
  });

  it("requires nonempty strict catalog rows and optional string metadata", () => {
    const recipe = { kind: "catalog" as const, sourceType: "admin_class" as const };
    const base = {
      ok: true,
      contractVersion: 1,
      kind: "catalog",
      sourceType: "admin_class",
      session: { id: "1061", name: "2026秋" },
    };
    expect(parseExternalDirectoryResult({ ...base, items: [] }, recipe)).toEqual({ error: "SCHEMA_INVALID" });
    expect(parseExternalDirectoryResult({
      ...base,
      items: [{ id: "1", name: "电气1班", extra: "学院", grade: 2026 }],
    }, recipe)).toEqual({ error: "SCHEMA_INVALID" });
    expect(parseExternalDirectoryResult({
      ...base,
      items: [{ id: "1", name: "电气1班", extra: "学院", departmentId: "d".repeat(101) }],
    }, recipe)).toEqual({ error: "SCHEMA_INVALID" });
    expect(parseExternalDirectoryResult({
      ...base,
      items: [
        { id: "1", name: "电气1班", extra: "学院", departmentId: "dept-1", grade: "2026" },
        { id: "1", name: "重复班", extra: "" },
      ],
    }, recipe)).toEqual({ error: "SCHEMA_INVALID" });
  });

  it("accepts a department-only catalog tree", () => {
    const result = parseExternalDirectoryResult({
      ok: true,
      contractVersion: 1,
      kind: "catalog",
      sourceType: "department",
      session: { id: "1061", name: "2026秋" },
      departments: [{ id: "dept-1", name: "电气工程学院", children: [{ id: "dept-2", name: "自动化学院" }] }],
    }, { kind: "catalog", sourceType: "department" });
    expect(result).toEqual({
      contractVersion: 1,
      kind: "catalog",
      sourceType: "department",
      session: { id: "1061", name: "2026秋" },
      departments: [{
        id: "dept-1",
        name: "电气工程学院",
        children: [{ id: "dept-2", name: "自动化学院" }],
      }],
    });
  });

  it("returns every requested instructor class exactly once and permits an empty list", () => {
    const result = parseExternalDirectoryResult({
      ok: true,
      contractVersion: 1,
      kind: "instructors",
      session: { id: "1061", name: "2026秋" },
      classes: [
        { classId: "740923", items: [{ id: "100013065", name: "教师", extra: "32734 / 软件", departmentId: "114819081" }] },
        { classId: "744669", items: [] },
      ],
    }, { kind: "instructors", classIds: ["740923", "744669"], expectedSessionId: "1061" });
    expect(result).toEqual({
      contractVersion: 1,
      kind: "instructors",
      session: { id: "1061", name: "2026秋" },
      classes: [
        { classId: "740923", items: [{ id: "100013065", name: "教师", extra: "32734 / 软件", departmentId: "114819081" }] },
        { classId: "744669", items: [] },
      ],
    });

    const classes = [
      { classId: "740923", items: [] },
      { classId: "740923", items: [] },
    ];
    expect(parseExternalDirectoryResult({
      contractVersion: 1,
      kind: "instructors",
      session: { id: "1061", name: "2026秋" },
      classes,
    }, { kind: "instructors", classIds: ["740923", "744669"], expectedSessionId: "1061" }))
      .toEqual({ error: "SCHEMA_INVALID" });
  });
});
