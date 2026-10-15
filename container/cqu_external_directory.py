"""Fixed weekly AllCourseSchedule directory actions.

Only business identifiers cross the container protocol. URLs, methods, and fixed
request bodies live here; credentials, headers, cookies, and tokens are neither
read nor returned.
"""
import asyncio
import json
import re
import random
import urllib.parse

import browser_profile
from chromium_session import ChromiumSession
from cqu_data_harvest import is_expired_harvest
from cqu_external_search import (
    ALL_COURSE_URL,
    DEPARTMENT_LIST_URL,
    SESSION_INFO_URL,
    SESSION_LIST_URL,
    _current_session,
    _department_nodes,
    wait_for_external_app,
)


CLASS_ID_RE = "0123456789"
GRADE_RE = re.compile(r"^(?:19|20)\d{2}$")
ALLOWED_RECIPE_KEYS = frozenset({"kind", "sourceType", "expectedSessionId", "classIds"})
ALLOWED_BODY_KEYS = ALLOWED_RECIPE_KEYS | frozenset({"state", "operationTimeoutMs"})
SOURCE_TYPES = frozenset({
    "department", "room", "laboratory", "admin_class", "course_catalog", "teaching_class"
})
ITEM_CAPS = {
    "department": 20_000,
    "room": 10_000,
    "laboratory": 5_000,
    "admin_class": 20_000,
    "course_catalog": 10_000,
    "teaching_class": 20_000,
}
ROOM_PATH = "/api/resourceapi/room/roomName-filter"
LABORATORY_PATH = "/api/timetable/course/LaboratoryId-filter"
ADMIN_CLASS_PATH = "/admin-class/dept-admin-classes"
COURSE_CATALOG_PATH = "/api/timetable/course/info-by-name-or-code"
TEACHING_CLASS_PATH = "/api/timetable/class/classNbr-filter"
TIMETABLE_API_BASE = "https://my.cqu.edu.cn/api/timetable"
RESOURCE_API_BASE = "https://my.cqu.edu.cn/api/resourceapi"
INSTRUCTOR_PATH = "/class/instructors/"
INPAGE_FETCH_TIMEOUT_MS = 15_000


class ExternalDirectoryRecipeError(ValueError):
    """The browser recipe is not one of the fixed typed directory actions."""


class ExternalDirectoryTransientError(RuntimeError):
    """A bounded school-page action failed without exposing raw diagnostics."""

    def __init__(self, code="DIRECTORY_TRANSIENT"):
        super().__init__(code)
        self.code = code if code in ERROR_STATUS else "DIRECTORY_TRANSIENT"


ERROR_STATUS = {
    "CURRENT_SESSION_CHANGED": 409,
    "CURRENT_SESSION_UNVERIFIED": 409,
    "SCHEMA_INVALID": 502,
    "DIRECTORY_API_REJECTED": 502,
    "DIRECTORY_BODY_TIMEOUT": 504,
    "DIRECTORY_REQUEST_HUNG": 504,
    "APP_READY_TIMEOUT": 503,
    "DIRECTORY_TRANSIENT": 503,
    "WAF_CHALLENGE": 503,
    "BROWSER_BUSY": 503,
    "BROWSER_DEADLINE": 503,
    "TGT_EXPIRED": 409,
    "PAGE_PERMISSION_DENIED": 403,
}


def _numeric_id(value: object, limit: int = 100) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    if any(character not in CLASS_ID_RE for character in value):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return value


def _required_text(value: object, limit: int = 200) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    if any(ord(character) < 0x20 or ord(character) == 0x7f for character in value):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return value


def _optional_text(value: object, limit: int = 200) -> str | None:
    if value is None or value == "":
        return None
    return _required_text(value, limit)


def _url(origin: str, path: str, query: dict[str, str] | None = None) -> str:
    parsed = urllib.parse.urlsplit(origin)
    return urllib.parse.urlunsplit((
        parsed.scheme, parsed.netloc, path,
        urllib.parse.urlencode(query or {}), ""
    ))


def _get_request(url: str) -> dict:
    if url.startswith(RESOURCE_API_BASE + "/"):
        return {"path": url[len(RESOURCE_API_BASE):], "base": RESOURCE_API_BASE}
    if url.startswith(TIMETABLE_API_BASE + "/"):
        return {"path": url[len(TIMETABLE_API_BASE):], "base": TIMETABLE_API_BASE}
    raise ExternalDirectoryTransientError("DIRECTORY_API_REJECTED")


def parse_external_directory_recipe(body: object) -> dict:
    if not isinstance(body, dict):
        raise ExternalDirectoryRecipeError("recipe must be an object")
    if set(body) - ALLOWED_BODY_KEYS:
        raise ExternalDirectoryRecipeError("recipe contains unsupported transport fields")
    kind = body.get("kind")
    if kind == "catalog":
        if "classIds" in body:
            raise ExternalDirectoryRecipeError("catalog recipe cannot contain classIds")
        source_type = body.get("sourceType")
        expected = body.get("expectedSessionId")
        if source_type not in SOURCE_TYPES:
            raise ExternalDirectoryRecipeError("invalid catalog recipe")
        if expected is None:
            expected = ""
        elif not isinstance(expected, str) or not expected:
            raise ExternalDirectoryRecipeError("invalid catalog recipe")
        if expected and (len(expected) > 100 or any(ord(c) < 0x20 or ord(c) == 0x7f for c in expected)):
            raise ExternalDirectoryRecipeError("invalid expected session")
        return {
            "kind": "catalog",
            "sourceType": source_type,
            **({"expectedSessionId": expected} if expected else {}),
        }
    if kind == "instructors":
        if "sourceType" in body:
            raise ExternalDirectoryRecipeError("instructor recipe cannot contain sourceType")
        class_ids = body.get("classIds")
        expected = body.get("expectedSessionId")
        if not isinstance(class_ids, list) or not isinstance(expected, str):
            raise ExternalDirectoryRecipeError("invalid instructor recipe")
        if not 1 <= len(class_ids) <= 10:
            raise ExternalDirectoryRecipeError("class batch size must be 1..10")
        try:
            typed = [_numeric_id(class_id) for class_id in class_ids]
        except ExternalDirectoryTransientError:
            raise ExternalDirectoryRecipeError("invalid class ID") from None
        if len(set(typed)) != len(typed):
            raise ExternalDirectoryRecipeError("class IDs must be unique")
        try:
            expected_session = _required_text(expected, 100)
        except ExternalDirectoryTransientError:
            raise ExternalDirectoryRecipeError("invalid expected session") from None
        return {"kind": "instructors", "classIds": typed, "expectedSessionId": expected_session}
    raise ExternalDirectoryRecipeError("unsupported directory kind")


PAGE_SESSION_JS = """() => {
  const seen = new Set();
  const components = new Set();
  const terms = new Set();
  for (const element of document.querySelectorAll('*')) {
    let vm = element.__vue__;
    while (vm && typeof vm === 'object' && !seen.has(vm)) {
      seen.add(vm);
      if (typeof vm.getSearchList === 'function'
          && typeof vm.postJsonRequest === 'function') {
        components.add(vm);
        if (typeof vm.sessionId === 'string' && /^\\d+$/.test(vm.sessionId)) {
          terms.add(vm.sessionId);
        }
      }
      vm = vm.$parent;
    }
  }
  return {
    found: components.size === 1 && terms.size === 1,
    sessionId: components.size === 1 && terms.size === 1 ? [...terms][0] : '',
  };
}"""

GET_JS = """async ({ path, base, timeout }) => {
  const cancelFunctions = [];
  let timer;
  try {
    for (const element of document.querySelectorAll('*')) {
      const seen = new Set();
      let vm = element.__vue__;
      while (vm && typeof vm === 'object' && !seen.has(vm)) {
        seen.add(vm);
        if (typeof vm.sessionId === 'string' && vm.sessionId
            && typeof vm.getSearchList === 'function'
            && typeof vm.postJsonRequest === 'function'
            && typeof vm.getRequest === 'function') {
          const request = vm.getRequest(path, base, cancelFunctions);
          const timeoutRequest = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('directory get timeout')), timeout);
          });
          let response;
          try {
            response = await Promise.race([request, timeoutRequest]);
          } catch (error) {
            const status = error?.response?.status;
            if (typeof status === 'number' && status > 0) {
              return { status, body: JSON.stringify(error.response?.data ?? null) };
            }
            throw error;
          }
          if (!response || typeof response !== 'object') return { status: 0, body: '' };
          return { status: response.status, body: JSON.stringify(response.data ?? null) };
        }
        vm = vm.$parent;
      }
    }
    return { status: 0, componentMissing: true, body: '' };
  } finally {
    if (timer) clearTimeout(timer);
    for (const cancel of cancelFunctions) {
      try { if (typeof cancel === 'function') cancel(); } catch (error) {}
    }
  }
}"""

ADMIN_POST_JS = """async ({ path, base, timeout }) => {
  const cancelFunctions = [];
  let timer;
  try {
    for (const element of document.querySelectorAll('*')) {
      const seen = new Set();
      let vm = element.__vue__;
      while (vm && typeof vm === 'object' && !seen.has(vm)) {
        seen.add(vm);
        if (typeof vm.sessionId === 'string' && vm.sessionId
            && typeof vm.getSearchList === 'function'
            && typeof vm.postJsonRequest === 'function') {
          const request = vm.postJsonRequest(path, [], base, cancelFunctions);
          const timeoutRequest = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('directory post timeout')), timeout);
          });
          let response;
          try {
            response = await Promise.race([request, timeoutRequest]);
          } catch (error) {
            const status = error?.response?.status;
            if (typeof status === 'number' && status > 0) {
              return { status, body: JSON.stringify(error.response?.data ?? null) };
            }
            throw error;
          }
          if (!response || typeof response !== 'object') return { status: 0, body: '' };
          return { status: response.status, body: JSON.stringify(response.data ?? null) };
        }
        vm = vm.$parent;
      }
    }
    // The page's selected term cannot be verified without its directory component.
    return { status: 0, componentMissing: true, body: '' };
  } finally {
    if (timer) clearTimeout(timer);
    for (const cancel of cancelFunctions) {
      try { if (typeof cancel === 'function') cancel(); } catch (error) {}
    }
  }
}"""


def _remaining_ms(deadline: float) -> int:
    remaining = (deadline - asyncio.get_running_loop().time()) * 1000
    if remaining <= 0:
        raise ExternalDirectoryTransientError("BROWSER_DEADLINE")
    return max(1, min(INPAGE_FETCH_TIMEOUT_MS, int(remaining)))


async def _paced_sleep(index: int) -> None:
    if index:
        await asyncio.sleep(random.uniform(0.75, 1.25))


async def _fetch(page, request: dict, deadline: float, index: int) -> object:
    await _paced_sleep(index)
    try:
        if request.get("vuePost"):
            entry = await page.evaluate(ADMIN_POST_JS, {
                "path": request["path"],
                "base": request["base"],
                "timeout": _remaining_ms(deadline),
            })
        else:
            entry = await page.evaluate(GET_JS, {
                "path": request["path"],
                "base": request["base"],
                "timeout": _remaining_ms(deadline),
            })
    except asyncio.CancelledError:
        raise
    except Exception:
        raise ExternalDirectoryTransientError("DIRECTORY_REQUEST_HUNG") from None
    if not isinstance(entry, dict):
        raise ExternalDirectoryTransientError("DIRECTORY_BODY_TIMEOUT")
    return _entry_json(entry)


def _entry_json(entry: dict) -> object:
    if entry.get("componentMissing") is True:
        raise ExternalDirectoryTransientError("CURRENT_SESSION_UNVERIFIED")
    status = entry.get("status", 0)
    if status == 403:
        raise ExternalDirectoryTransientError("PAGE_PERMISSION_DENIED")
    if status == 412:
        raise ExternalDirectoryTransientError("WAF_CHALLENGE")
    if status == 401:
        raise ExternalDirectoryTransientError("TGT_EXPIRED")
    if status != 200:
        raise ExternalDirectoryTransientError("DIRECTORY_API_REJECTED")
    try:
        return json.loads(entry["body"])
    except (KeyError, TypeError, ValueError):
        raise ExternalDirectoryTransientError("DIRECTORY_BODY_TIMEOUT") from None


async def _page_session(page) -> str:
    try:
        outcome = await page.evaluate(PAGE_SESSION_JS, {})
    except Exception:
        raise ExternalDirectoryTransientError("CURRENT_SESSION_UNVERIFIED") from None
    if not isinstance(outcome, dict) or outcome.get("found") is not True:
        raise ExternalDirectoryTransientError("CURRENT_SESSION_UNVERIFIED")
    session_id = outcome.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ExternalDirectoryTransientError("CURRENT_SESSION_UNVERIFIED")
    return session_id


async def _wait_for_directory_page(page, deadline: float) -> None:
    while True:
        try:
            await _page_session(page)
            return
        except ExternalDirectoryTransientError as error:
            if error.code != "CURRENT_SESSION_UNVERIFIED":
                raise
            remaining = (deadline - asyncio.get_running_loop().time()) * 1000
            if remaining <= 0:
                raise
            await asyncio.sleep(min(0.05, remaining / 1000))


def _next_index(counter: dict[str, int]) -> int:
    index = counter["value"]
    counter["value"] += 1
    return index


async def _read_current_session(page, deadline: float, counter: dict[str, int]) -> dict:
    info = await _fetch(page, _get_request(SESSION_INFO_URL), deadline, _next_index(counter))
    full = await _fetch(page, _get_request(SESSION_LIST_URL), deadline, _next_index(counter))
    return _current_session([
        {"status": 200, "body": json.dumps(info, separators=(",", ":"))},
        {"status": 200, "body": json.dumps(full, separators=(",", ":"))},
    ])


def _dict_rows(value: object) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ExternalDirectoryTransientError("DIRECTORY_API_REJECTED")
    return value


def _check_session(session: dict, expected: str, page_session: str) -> None:
    if expected and session["id"] != expected:
        raise ExternalDirectoryTransientError("CURRENT_SESSION_CHANGED")
    if page_session != session["id"]:
        raise ExternalDirectoryTransientError("CURRENT_SESSION_CHANGED")


async def _guard_session(
    page, deadline: float, expected: str, counter: dict[str, int]
) -> dict:
    session = await _read_current_session(page, deadline, counter)
    _check_session(session, expected, await _page_session(page))
    return session


def _envelope_rows(value: object) -> list:
    if not isinstance(value, dict) or value.get("status") != "success" or value.get("ok") is not True:
        raise ExternalDirectoryTransientError("DIRECTORY_API_REJECTED")
    if value.get("code") is not None or not isinstance(value.get("data"), list):
        raise ExternalDirectoryTransientError("DIRECTORY_API_REJECTED")
    return value["data"]


def _item(row: object, source_type: str) -> dict:
    if not isinstance(row, dict):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    item = {
        "id": _required_text(row.get("id"), 100),
        "name": _required_text(row.get("name")),
        "extra": _optional_text(row.get("extra")) or "",
    }
    for key in ("departmentId", "grade", "courseCode"):
        value = _optional_text(row.get(key), 100)
        if value is not None:
            item[key] = value
    if "grade" in item and not GRADE_RE.fullmatch(item["grade"]):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return item


def _finish_items(rows: object, source_type: str) -> list[dict]:
    if not isinstance(rows, list) or not rows or len(rows) >= ITEM_CAPS[source_type]:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    items = [_item(row, source_type) for row in rows]
    if len({item["id"] for item in items}) != len(items):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return items


def _room_row(row: dict, laboratory: bool) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("roomName") if laboratory else row.get("name"),
        "extra": " / ".join(part for part in (row.get("buildingName"), row.get("campusName")) if part),
    }


def _department_name_ids(nodes: list[dict]) -> dict[str, list[str]]:
    output: dict[str, list[str]] = {}
    def visit(node: dict) -> None:
        name, node_id = node.get("name"), node.get("id")
        if isinstance(name, str) and name and isinstance(node_id, str) and node_id:
            output.setdefault(name, []).append(node_id)
        for child in node.get("children", []):
            if isinstance(child, dict):
                visit(child)
    for node in nodes:
        if isinstance(node, dict):
            visit(node)
    return output


def _admin_row(row: dict, department_name_ids: dict[str, list[str]] | None = None) -> dict:
    raw_grade = row.get("grade")
    grade = None
    if isinstance(raw_grade, int) and not isinstance(raw_grade, bool):
        grade = str(raw_grade)
    elif isinstance(raw_grade, str):
        grade = raw_grade
    item = {
        "id": row.get("id"),
        "name": row.get("className") or row.get("name"),
        "extra": " / ".join(part for part in (row.get("departmentName"), row.get("campusName")) if part),
        "departmentId": row.get("departmentId") or row.get("deptId"),
        "grade": grade,
    }
    if item["departmentId"] is None and department_name_ids is not None:
        department_name = row.get("departmentName")
        if isinstance(department_name, str):
            matches = department_name_ids.get(department_name, [])
            if len(matches) == 1:
                item["departmentId"] = matches[0]
    return item


def _course_catalog_row(row: dict) -> dict:
    code = row.get("codeR") or row.get("code")
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "extra": code,
        **({"courseCode": row["codeR"]} if row.get("codeR") else {}),
    }


def _teaching_row(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("classNbr"),
        "extra": row.get("courseName"),
        "courseCode": row.get("courseCode"),
    }


def _instructor_row(row: dict) -> dict:
    return {
        "id": row.get("instructorId"),
        "name": row.get("instrName"),
        "extra": " / ".join(part for part in (row.get("instrCode"), row.get("instrDeptName")) if part),
        "departmentId": row.get("belongDeptId"),
    }


def _catalog_request(page, source_type: str, session_id: str) -> dict:
    origin = f"{urllib.parse.urlsplit(page.url).scheme}://{urllib.parse.urlsplit(page.url).netloc}"
    if source_type == "room":
        return _get_request(_url(origin, ROOM_PATH, {"roomName": "", "limitNum": "10000"}))
    if source_type == "laboratory":
        return _get_request(_url(origin, LABORATORY_PATH, {"roomName": "", "limitNum": "5000"}))
    if source_type == "admin_class":
        return {
            "vuePost": True,
            "path": ADMIN_CLASS_PATH + "?pageSize=20000",
            "base": TIMETABLE_API_BASE,
        }
    if source_type == "course_catalog":
        return _get_request(_url(origin, COURSE_CATALOG_PATH, {
            "nameOrCode": "%", "pageSize": "10000", "sessionId": session_id,
        }))
    if source_type == "teaching_class":
        return _get_request(_url(origin, TEACHING_CLASS_PATH, {"courseNameOrClassNbr": "", "limitNum": "20000"}))
    return _get_request(DEPARTMENT_LIST_URL)


def _catalog_result(
    source_type: str,
    session: dict,
    value: object,
    department_name_ids: dict[str, list[str]] | None = None,
) -> dict:
    if source_type == "department":
        try:
            departments = _department_nodes(value)
        except Exception:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID") from None
        if not departments or _department_count(departments) >= ITEM_CAPS[source_type]:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        _check_department_contract(departments, 0)
        _check_department_ids(departments, set())
        return {
            "contractVersion": 1, "kind": "catalog", "sourceType": source_type,
            "session": session, "departments": departments,
        }
    if source_type == "course_catalog":
        catalog_rows = _dict_rows(_envelope_rows(value))
        rows = [_course_catalog_row(row) for row in catalog_rows]
    elif source_type == "room":
        rows = [_room_row(row, False) for row in _dict_rows(value)]
    elif source_type == "laboratory":
        rows = [_room_row(row, True) for row in _dict_rows(value)]
    elif source_type == "admin_class":
        rows = [
            _admin_row(row, department_name_ids)
            for row in _dict_rows(value)
        ]
    else:
        rows = [_teaching_row(row) for row in _dict_rows(value)]
    return {
        "contractVersion": 1, "kind": "catalog", "sourceType": source_type,
        "session": session, "items": _finish_items(rows, source_type),
    }


def _department_count(nodes: list[dict]) -> int:
    return len(nodes) + sum(_department_count(node.get("children", [])) for node in nodes)


def _check_department_contract(nodes: list[dict], depth: int) -> None:
    if not nodes or len(nodes) > 1000 or depth > 8:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    for node in nodes:
        _required_text(node["id"], 100)
        _required_text(node["name"])
        if "children" in node:
            _check_department_contract(node["children"], depth + 1)


def _check_department_ids(nodes: list[dict], seen: set[str]) -> None:
    for node in nodes:
        if node["id"] in seen:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        seen.add(node["id"])
        _check_department_ids(node.get("children", []), seen)


def _instructor_result(session: dict, class_ids: list[str], batches: list[object]) -> dict:
    if len(batches) != len(class_ids):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    classes = []
    for class_id, value in zip(class_ids, batches):
        instructor_rows = _dict_rows(_envelope_rows(value))
        rows = [_instructor_row(row) for row in instructor_rows]
        items = [_item(row, "instructors") for row in rows]
        if len(items) > 200 or len({item["id"] for item in items}) != len(items):
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        classes.append({"classId": class_id, "items": items})
    return {"contractVersion": 1, "kind": "instructors", "session": session, "classes": classes}


def _typed_item(value: object) -> dict:
    if not isinstance(value, dict) or set(value) - {"id", "name", "extra", "departmentId", "grade", "courseCode"}:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    item = {
        "id": _required_text(value.get("id"), 100),
        "name": _required_text(value.get("name")),
        "extra": _optional_text(value.get("extra")) or "",
    }
    for key in ("departmentId", "grade", "courseCode"):
        text_value = _optional_text(value.get(key), 100)
        if text_value is not None:
            item[key] = text_value
    if "grade" in item and not GRADE_RE.fullmatch(item["grade"]):
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return item


def _typed_departments(value: object, depth: int = 0, seen: frozenset[str] | None = None) -> list[dict]:
    if not isinstance(value, list) or not value or len(value) > 1000 or depth > 8:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    seen = seen or frozenset()
    output = []
    for raw in value:
        if not isinstance(raw, dict) or set(raw) - {"id", "name", "children"}:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        node_id = _required_text(raw.get("id"), 100)
        name = _required_text(raw.get("name"))
        if node_id in seen:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        next_seen = seen | {node_id}
        children = raw.get("children")
        output.append({
            "id": node_id,
            "name": name,
            **({"children": _typed_departments(children, depth + 1, next_seen)} if children is not None else {}),
        })
    if _department_count(output) >= ITEM_CAPS["department"]:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return output


def _typed_session(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"id", "name"}:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    return {
        "id": _required_text(value.get("id"), 100),
        "name": _required_text(value.get("name"), 100),
    }


def sanitize_external_directory_result(value: object) -> dict:
    """Validate and copy only the fixed typed result fields."""
    if not isinstance(value, dict) or value.get("contractVersion") != 1:
        raise ExternalDirectoryTransientError("SCHEMA_INVALID")
    kind = value.get("kind")
    session = _typed_session(value.get("session"))
    if kind == "catalog":
        source_type = value.get("sourceType")
        if source_type not in SOURCE_TYPES:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        if source_type == "department":
            if set(value) != {"contractVersion", "kind", "sourceType", "session", "departments"}:
                raise ExternalDirectoryTransientError("SCHEMA_INVALID")
            return {
                "contractVersion": 1, "kind": "catalog", "sourceType": source_type,
                "session": session, "departments": _typed_departments(value.get("departments")),
            }
        if set(value) != {"contractVersion", "kind", "sourceType", "session", "items"}:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        rows = value.get("items")
        if not isinstance(rows, list) or not rows or len(rows) >= ITEM_CAPS[source_type]:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        items = [_typed_item(row) for row in rows]
        if len({item["id"] for item in items}) != len(items):
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        return {
            "contractVersion": 1, "kind": "catalog", "sourceType": source_type,
            "session": session, "items": items,
        }
    if kind == "instructors":
        if set(value) != {"contractVersion", "kind", "session", "classes"}:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        rows = value.get("classes")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
            raise ExternalDirectoryTransientError("SCHEMA_INVALID")
        classes = []
        class_ids = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"classId", "items"}:
                raise ExternalDirectoryTransientError("SCHEMA_INVALID")
            class_id = _numeric_id(row.get("classId"))
            if class_id in class_ids:
                raise ExternalDirectoryTransientError("SCHEMA_INVALID")
            class_ids.add(class_id)
            raw_items = row.get("items")
            if not isinstance(raw_items, list) or len(raw_items) > 200:
                raise ExternalDirectoryTransientError("SCHEMA_INVALID")
            items = [_typed_item(item) for item in raw_items]
            if len({item["id"] for item in items}) != len(items):
                raise ExternalDirectoryTransientError("SCHEMA_INVALID")
            classes.append({"classId": class_id, "items": items})
        return {"contractVersion": 1, "kind": "instructors", "session": session, "classes": classes}
    raise ExternalDirectoryTransientError("SCHEMA_INVALID")


async def external_directory(state: dict, recipe: dict, operation_timeout_ms: int | None = None) -> dict:
    """Run one fixed directory action in the user's hydrated school browser."""
    deadline = asyncio.get_running_loop().time() + (
        (operation_timeout_ms or 90_000) / 1000
    )
    browser = ChromiumSession(seed_state=state)
    async with browser:
        try:
            await browser.navigate(
                ALL_COURSE_URL,
                wait_until="domcontentloaded",
                timeout_s=browser_profile.HARVEST_NAV_TIMEOUT_MS / 1000,
            )
        except Exception:
            raise ExternalDirectoryTransientError("APP_READY_TIMEOUT") from None
        if is_expired_harvest({}, await browser.content(), browser.url):
            raise ExternalDirectoryTransientError("TGT_EXPIRED")
        await wait_for_external_app(browser)
        await _wait_for_directory_page(browser, deadline)

        request_counter = {"value": 0}
        session = await _guard_session(
            browser, deadline, recipe.get("expectedSessionId", ""), request_counter
        )
        if recipe["kind"] == "catalog":
            request = _catalog_request(browser, recipe["sourceType"], session["id"])
            value = await _fetch(browser, request, deadline, _next_index(request_counter))
            department_name_ids = None
            if (recipe["sourceType"] == "admin_class" and isinstance(value, list)
                    and any(not row.get("departmentId") for row in value if isinstance(row, dict))):
                departments = await _fetch(browser, _get_request(DEPARTMENT_LIST_URL), deadline, _next_index(request_counter))
                department_name_ids = _department_name_ids(_department_nodes(departments))
            result = _catalog_result(
                recipe["sourceType"], session, value, department_name_ids
            )
        else:
            batches = []
            for class_id in recipe["classIds"]:
                batches.append(await _fetch(browser, {
                    "path": INSTRUCTOR_PATH + class_id,
                    "base": TIMETABLE_API_BASE,
                }, deadline, _next_index(request_counter)))
            result = _instructor_result(session, recipe["classIds"], batches)

        await _guard_session(browser, deadline, session["id"], request_counter)
        return result
