"""Fixed current-term external timetable capture actions."""

import asyncio
import datetime
import json
import urllib.parse

import browser_profile
from chromium_session import ChromiumSession
from cqu_data_harvest import StageTrace, is_expired_harvest, run_serial_inpage_gets
from cqu_external_search import perform_admin_class_search, perform_instructor_search, perform_room_search


ALLOWED_RECIPE_KEYS = frozenset({
    "action", "sourceType", "targetId", "targetName", "expectedSessionId",
})
ALLOWED_BODY_KEYS = ALLOWED_RECIPE_KEYS | frozenset({"state", "operationTimeoutMs"})
ALL_COURSE_URL = "https://my.cqu.edu.cn/tt/AllCourseSchedule"
SESSION_INFO_PATH = "/api/resourceapi/session/info-detail"
SESSION_LIST_PATH = "/api/resourceapi/session/list"
ADMIN_TABLE_MARKER = "/api/timetable/class/timetable/adminClass/table-detail"
INSTRUCTOR_TABLE_MARKER = "/api/timetable/class/timetable/instructor/table-detail"
CAPTURE_ACTIONS = {
    "admin_class": "admin_class_capture",
    "instructor": "instructor_capture",
    "room": "room_capture",
}
CAPTURE_TABLE_MARKERS = {
    "admin_class": ADMIN_TABLE_MARKER,
    "instructor": INSTRUCTOR_TABLE_MARKER,
    "room": "/api/timetable/class/timetable/room/table-detail",
}


class ExternalCaptureRecipeError(ValueError):
    """The browser recipe is not the one fixed typed action."""


class ExternalCaptureTransientError(RuntimeError):
    """A bounded school-page capture failed without exposing raw diagnostics."""

    def __init__(self, code="CAPTURE_TRANSIENT"):
        super().__init__(code)
        self.code = code if code in ERROR_STATUS else "CAPTURE_TRANSIENT"


ERROR_STATUS = {
    "APP_READY_TIMEOUT": 503,
    "TARGET_NOT_FOUND": 404,
    "AMBIGUOUS_TARGET": 409,
    "CURRENT_SESSION_CHANGED": 409,
    "CAPTURE_MISSING": 503,
    "CAPTURE_API_REJECTED": 502,
    "CAPTURE_BODY_TIMEOUT": 504,
    "WAF_CHALLENGE": 503,
    "SCHEMA_INVALID": 502,
    "CAPTURE_TRANSIENT": 503,
    "BROWSER_BUSY": 503,
    "BROWSER_DEADLINE": 503,
    "TGT_EXPIRED": 409,
    "PAGE_PERMISSION_DENIED": 403,
}


SELECT_TARGET_JS = """async ({ targetId, targetName }) => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const text = element => (element.textContent || element.getAttribute('title') || '').trim();
  const click = element => {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const options = [...document.querySelectorAll(
      '.ant-select-dropdown .ant-select-item-option,[role="listbox"] [role="option"],.ant-table-tbody tr'
    )].filter(visible);
    const exactName = element => {
      const value = text(element);
      return value === targetName || value.startsWith(targetName + ' ')
        || value.startsWith(targetName + '[');
    };
    const byName = options.filter(exactName);
    const byId = options.filter(element =>
      element.dataset.value === targetId || element.getAttribute('data-value') === targetId);
    if (byId.length > 1) throw new Error('ambiguous target');
    if (byId.length === 1) { click(byId[0]); return true; }
    if (byName.length > 1) throw new Error('ambiguous target');
    if (byName.length === 1) { click(byName[0]); return true; }
    await sleep(80);
  }
  throw new Error('target option missing');
}"""

CLEAR_SELECTED_TARGETS_JS = """async () => {
  const visible = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const click = element => {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const removals = [...document.querySelectorAll(
    '.ant-select-selection__choice__remove,.ant-select-selection__choice-remove'
  )].filter(visible);
  for (const removal of removals) click(removal);
  return removals.length;
}"""


def parse_external_capture_recipe(body: dict) -> dict:
    if isinstance(body, dict) and body.get("action") == "teaching_class_capture":
        from cqu_course_teaching import parse_course_recipe
        return parse_course_recipe(body)
    if not isinstance(body, dict):
        raise ExternalCaptureRecipeError("recipe must be an object")
    unknown = set(body) - ALLOWED_BODY_KEYS
    if unknown:
        raise ExternalCaptureRecipeError("recipe contains unsupported transport fields")
    source_type = body.get("sourceType")
    if source_type not in CAPTURE_ACTIONS or body.get("action") != CAPTURE_ACTIONS[source_type]:
        raise ExternalCaptureRecipeError("unsupported action")
    target_id = body.get("targetId", "")
    target_name = body.get("targetName", "")
    expected_session_id = body.get("expectedSessionId", "")
    if not all(isinstance(value, str) for value in (target_id, target_name, expected_session_id)):
        raise ExternalCaptureRecipeError("target fields must be strings")
    if not target_id or not target_name or len(target_id) > 100 or len(target_name) > 200:
        raise ExternalCaptureRecipeError("target fields are invalid")
    if expected_session_id and len(expected_session_id) > 100:
        raise ExternalCaptureRecipeError("expected session is invalid")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in target_id + target_name + expected_session_id):
        raise ExternalCaptureRecipeError("target fields contain control characters")
    return {
        "action": CAPTURE_ACTIONS[source_type],
        "sourceType": source_type,
        "targetId": target_id,
        "targetName": target_name,
        "expectedSessionId": expected_session_id,
    }


async def _read_response(response, captures: list[dict]) -> None:
    try:
        captures.append({
            "status": getattr(response, "status", 0),
            "body": await response.text(),
        })
    except asyncio.CancelledError:
        raise
    except Exception:
        return


def _is_expected_capture_request(
    request,
    expected_origin: str,
    source_type: str,
    target_id: str,
    session_id: str,
) -> bool:
    parsed = urllib.parse.urlsplit(getattr(request, "url", ""))
    response_origin = f"{parsed.scheme}://{parsed.netloc}"
    if response_origin != expected_origin or parsed.path != (ADMIN_TABLE_MARKER if source_type == "admin_class" else INSTRUCTOR_TABLE_MARKER if source_type == "instructor" else CAPTURE_TABLE_MARKERS[source_type]):
        return False
    if getattr(request, "method", "").upper() != "POST":
        return False
    if getattr(request, "resource_type", "").lower() not in {"fetch", "xhr"}:
        return False
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("sessionId", [session_id]) != [session_id]:
        return False
    post_data = getattr(request, "post_data", None)
    if not isinstance(post_data, str):
        return False
    try:
        body = json.loads(post_data)
    except Exception:
        return False
    return body == [target_id]


def _json_entry(entry: dict, code: str) -> object:
    status = entry.get("status", 0)
    if status == 403:
        raise ExternalCaptureTransientError("PAGE_PERMISSION_DENIED")
    if status == 412:
        raise ExternalCaptureTransientError("WAF_CHALLENGE")
    if status == 401:
        raise ExternalCaptureTransientError("TGT_EXPIRED")
    if status != 200:
        raise ExternalCaptureTransientError(code)
    try:
        return json.loads(entry["body"])
    except Exception:
        raise ExternalCaptureTransientError("CAPTURE_BODY_TIMEOUT") from None


def _current_session(entries: list[dict]) -> dict:
    info = _json_entry(entries[0], "CAPTURE_API_REJECTED")
    full = _json_entry(entries[1], "CAPTURE_API_REJECTED")
    if not isinstance(info, dict) or not isinstance(full, dict):
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    session_id = info.get("curSessionId")
    sessions = full.get("sessionVOList")
    if not isinstance(session_id, str) or not isinstance(sessions, list):
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    matching = [item for item in sessions if isinstance(item, dict) and item.get("id") == session_id]
    if len(matching) != 1:
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    name = f"{matching[0].get('year', '')}{matching[0].get('term', '')}"
    begin_date = matching[0].get("beginDate")
    if not name or not isinstance(begin_date, str):
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    try:
        parsed_date = datetime.date.fromisoformat(begin_date)
    except ValueError:
        raise ExternalCaptureTransientError("SCHEMA_INVALID") from None
    if parsed_date.isoformat() != begin_date:
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    return {"id": session_id, "name": name, "beginDate": begin_date}


def _required_text(value: object, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value) > limit or any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value):
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    return value


def _optional_text(value: object):
    if value is None or value == "":
        return None
    return _required_text(value, 500)


def _search_target(value: object, recipe: dict) -> None:
    if not isinstance(value, list):
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    by_name = []
    by_id = []
    for item in value:
        if not isinstance(item, dict):
            raise ExternalCaptureTransientError("SCHEMA_INVALID")
        name = item.get("className") if recipe["sourceType"] == "admin_class" else item.get("name")
        if str(item.get("id", "")) == recipe["targetId"]:
            by_id.append(item)
        if name == recipe["targetName"]:
            by_name.append(item)
    if recipe["sourceType"] == "admin_class" and len(by_name) > 1:
        raise ExternalCaptureTransientError("AMBIGUOUS_TARGET")
    if len(by_id) > 1:
        raise ExternalCaptureTransientError("AMBIGUOUS_TARGET")
    if len(by_id) != 1 or by_id[0].get("className" if recipe["sourceType"] == "admin_class" else "name") != recipe["targetName"]:
        raise ExternalCaptureTransientError("TARGET_NOT_FOUND")
    if recipe["sourceType"] == "admin_class" and len(by_name) != 1:
        raise ExternalCaptureTransientError("AMBIGUOUS_TARGET" if by_name else "TARGET_NOT_FOUND")


def _sanitized_timetable(value: object, target_id: str, source_type: str = "admin_class", sanitized: bool = False) -> dict:
    room = source_type == "room"
    allowed_arrays = {"classTimetableVOList"} | ({"roomExamTimeTableVOList", "tempActivityTimetableVOList"} if room and not sanitized else set())
    if not isinstance(value, dict) or any(isinstance(item, list) and key not in allowed_arrays for key, item in value.items()):
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    rows = value.get("classTimetableVOList")
    max_section = value.get("maxSection")
    if not isinstance(rows, list) or type(max_section) is not int or not 1 <= max_section <= 14:
        raise ExternalCaptureTransientError("SCHEMA_INVALID")
    count = 0
    if room:
        if sanitized:
            count = value.get("unverifiedItemCount")
        else:
            extras = [value.get(key) for key in ("roomExamTimeTableVOList", "tempActivityTimetableVOList")]
            if any(not isinstance(items, list) for items in extras):
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            count = sum(len(items) for items in extras)
        if type(count) is not int or not 0 <= count <= 100000:
            raise ExternalCaptureTransientError("SCHEMA_INVALID")
    result = []
    for row in rows:
        if not isinstance(row, dict):
            raise ExternalCaptureTransientError("SCHEMA_INVALID")
        if room:
            room_id = _required_text(row.get("roomId"), 100)
            if room_id != target_id:
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            ownership = {"roomId": room_id}
        elif source_type == "instructor":
            ids = row.get("instructorIdList")
            if not isinstance(ids, list) or not ids:
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            typed_ids = [_required_text(value, 100) for value in ids]
            if target_id not in typed_ids:
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            ownership = {"instructorIdList": typed_ids}
        else:
            assignments = row.get("assignTeachingObject")
            if not isinstance(assignments, list) or not assignments:
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            typed_assignments = []
            for assignment in assignments:
                if not isinstance(assignment, dict):
                    raise ExternalCaptureTransientError("SCHEMA_INVALID")
                typed_assignments.append({"adminClassId": _required_text(assignment.get("adminClassId"), 100)})
            if not any(item["adminClassId"] == target_id for item in typed_assignments):
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            ownership = {"assignTeachingObject": typed_assignments}
        # Keep verified ownership while withholding any unverifiable content.
        # Schedule then reports the row as skipped instead of a complete success.
        typed = {}
        try:
            week_day = row.get("weekDay")
            if week_day is not None and (
                not isinstance(week_day, (str, int)) or isinstance(week_day, bool)
                or not str(week_day).isdigit() or not 1 <= int(week_day) <= 7
            ):
                raise ExternalCaptureTransientError("SCHEMA_INVALID")
            for key in ("courseName", "instructorName", "roomName", "position", "campusName", "teachingWeek", "period", "exprProjectName"):
                text = _optional_text(row.get(key))
                if text is not None:
                    typed[key] = text
            if week_day is not None:
                typed["weekDay"] = int(week_day)
        except ExternalCaptureTransientError:
            typed = {}
        typed.update(ownership)
        result.append(typed)
    return {"classTimetableVOList": result, "maxSection": max_section, **({"unverifiedItemCount": count} if room else {})}


async def _select_target(page, recipe: dict) -> None:
    outcome = await page.evaluate("""async (args) => {
      try { return { ok: true, value: await (""" + SELECT_TARGET_JS + """)(args) }; }
      catch (error) { return { ok: false, error: error && error.message ? error.message : 'action failed' }; }
    }""", {"targetId": recipe["targetId"], "targetName": recipe["targetName"]})
    if not isinstance(outcome, dict) or outcome.get("ok") is not True:
        detail = outcome.get("error", "") if isinstance(outcome, dict) else ""
        if detail == "ambiguous target":
            raise ExternalCaptureTransientError("AMBIGUOUS_TARGET")
        raise ExternalCaptureTransientError("TARGET_NOT_FOUND")


async def _clear_selected_targets(page) -> None:
    try:
        outcome = await page.evaluate(CLEAR_SELECTED_TARGETS_JS, {})
        if not isinstance(outcome, int) or outcome < 0:
            raise ExternalCaptureTransientError("CAPTURE_TRANSIENT")
    except ExternalCaptureTransientError:
        raise
    except Exception:
        raise ExternalCaptureTransientError("CAPTURE_TRANSIENT") from None


async def capture_admin_class(page, recipe: dict) -> dict:
    return await _capture_target(page, recipe)


async def capture_instructor(page, recipe: dict) -> dict:
    return await _capture_target(page, recipe)


async def _capture_target(page, recipe: dict) -> dict:
    """Search normally, select the exact ID, and capture the current table response."""
    trace = StageTrace()
    entries: list[dict] = []
    expected_page_url = urllib.parse.urlsplit(page.url)
    page_origin = f"{expected_page_url.scheme}://{expected_page_url.netloc}"
    await run_serial_inpage_gets(
        page,
        [
            {"method": "GET", "url": page_origin + SESSION_INFO_PATH},
            {"method": "GET", "url": page_origin + SESSION_LIST_PATH},
        ],
        trace,
        entries,
    )
    session = _current_session(entries)
    if recipe.get("expectedSessionId") and recipe["expectedSessionId"] != session["id"]:
        raise ExternalCaptureTransientError("CURRENT_SESSION_CHANGED")

    await _clear_selected_targets(page)
    search_action = {"instructor": perform_instructor_search, "room": perform_room_search, "admin_class": perform_admin_class_search}[recipe["sourceType"]]
    search = await search_action(page, {
        "departmentId": "", "departmentName": "", "grade": "", "keyword": recipe["targetName"],
    })
    _search_target(_json_entry(search, "CAPTURE_API_REJECTED"), recipe)

    captures: list[dict] = []
    tasks: set[asyncio.Task] = set()
    selecting = False
    closed = False
    expected_origin = page_origin
    accepted_requests: dict[int, object] = {}

    def on_request(request) -> None:
        if closed or not selecting:
            return
        if _is_expected_capture_request(request, expected_origin, recipe["sourceType"], recipe["targetId"], session["id"]):
            accepted_requests[id(request)] = request

    def on_response(response) -> None:
        if closed:
            return
        request = getattr(response, "request", None)
        if id(request) not in accepted_requests:
            return
        tasks.add(asyncio.create_task(_read_response(response, captures)))

    async def close_collector() -> None:
        nonlocal closed
        closed = True
        for task in tuple(tasks):
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    page.on_request(on_request)
    page.on_response(on_response)
    try:
        selecting = True
        await _select_target(page, recipe)
        deadline = asyncio.get_running_loop().time() + 15
        while asyncio.get_running_loop().time() < deadline:
            capture = captures[0] if captures else {}
            status = capture.get("status", 0)
            if status == 403:
                raise ExternalCaptureTransientError("PAGE_PERMISSION_DENIED")
            if status == 412:
                raise ExternalCaptureTransientError("WAF_CHALLENGE")
            if status == 401:
                raise ExternalCaptureTransientError("TGT_EXPIRED")
            if status >= 400:
                raise ExternalCaptureTransientError("CAPTURE_API_REJECTED")
            if capture and 200 <= status < 300:
                timetable = _sanitized_timetable(
                    _json_entry(capture, "CAPTURE_API_REJECTED"),
                    recipe["targetId"], recipe["sourceType"],
                )
                current_entries = []
                await run_serial_inpage_gets(page, [{"method": "GET", "url": page_origin + SESSION_INFO_PATH}], trace, current_entries)
                current_info = _json_entry(current_entries[0], "CAPTURE_API_REJECTED")
                if not isinstance(current_info, dict) or current_info.get("curSessionId") != session["id"]:
                    raise ExternalCaptureTransientError("CURRENT_SESSION_CHANGED")
                return {
                    "contractVersion": 1,
                    "sourceType": recipe["sourceType"],
                    "target": {"id": recipe["targetId"], "name": recipe["targetName"]},
                    "session": session,
                    "timetable": timetable,
                }
            await page.pause(100)
        raise ExternalCaptureTransientError("CAPTURE_MISSING")
    finally:
        await close_collector()


def sanitize_external_capture_result(value: object) -> dict:
    """Rebuild the result allowlist before it crosses the container boundary."""
    if isinstance(value, dict) and value.get("contractVersion") == 1 and value.get("sourceType") == "course":
        from cqu_course_teaching import sanitize_course_timetable
        target, session, course = value.get("target"), value.get("session"), value.get("course")
        if not all(isinstance(x, dict) for x in (target, session, course)):
            raise ExternalCaptureRecipeError("invalid course result")
        target_id = _required_text(target.get("id"), 100)
        return {"contractVersion": 1, "sourceType": "course",
                "target": {"id": target_id, "name": _required_text(target.get("name"), 200)},
                "course": {"id": _required_text(course.get("id"), 100), "name": _required_text(course.get("name"), 200)},
                "session": {"id": _required_text(session.get("id"), 100), "name": _required_text(session.get("name"), 100), "beginDate": _required_text(session.get("beginDate"), 10)},
                "timetable": sanitize_course_timetable(value.get("timetable"), target_id)}
    if not isinstance(value, dict) or value.get("contractVersion") != 1 or value.get("sourceType") not in CAPTURE_ACTIONS:
        raise ExternalCaptureRecipeError("capture result contract is invalid")
    target = value.get("target")
    session = value.get("session")
    if not isinstance(target, dict) or not isinstance(session, dict):
        raise ExternalCaptureRecipeError("capture result contract is invalid")
    target_id = _required_text(target.get("id"), 100)
    return {
        "contractVersion": 1,
        "sourceType": value["sourceType"],
        "target": {"id": target_id, "name": _required_text(target.get("name"), 200)},
        "session": {
            "id": _required_text(session.get("id"), 100),
            "name": _required_text(session.get("name"), 100),
            "beginDate": _required_text(session.get("beginDate"), 10),
        },
        "timetable": _sanitized_timetable(value.get("timetable"), target_id, value["sourceType"], sanitized=True),
    }


async def external_capture(state: dict, recipe: dict) -> dict:
    """Run the fixed action in the user's hydrated current-term browser session."""
    browser = ChromiumSession(seed_state=state)
    async with browser:
        try:
            await browser.navigate(
                ALL_COURSE_URL,
                wait_until="domcontentloaded",
                timeout_s=browser_profile.HARVEST_NAV_TIMEOUT_MS / 1000,
            )
        except Exception:
            raise ExternalCaptureTransientError("APP_READY_TIMEOUT") from None
        if is_expired_harvest({}, await browser.content(), browser.url):
            raise ExternalCaptureTransientError("TGT_EXPIRED")
        if recipe["action"] == "teaching_class_capture":
            from cqu_course_teaching import capture_teaching_class
            return sanitize_external_capture_result(await capture_teaching_class(browser, recipe))
        return sanitize_external_capture_result(await capture_admin_class(browser, recipe))
