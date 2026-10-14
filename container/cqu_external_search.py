"""Fixed AllCourseSchedule external-search actions.

The caller may describe only business intent. URLs, selectors, HTTP methods and
request bodies are intentionally absent from this protocol; the school page owns
those details and this module owns the fixed UI recipe.
"""
import re
import asyncio
import json
import logging
import urllib.parse

import browser_profile
from chromium_session import ChromiumSession
from cqu_data_harvest import StageTrace, is_expired_harvest, run_serial_inpage_gets



GRADE_RE = re.compile(r"^(?:19|20)\d{2}$")
ALLOWED_RECIPE_KEYS = frozenset({"action", "departmentId", "departmentName", "grade", "keyword"})
ALLOWED_BODY_KEYS = ALLOWED_RECIPE_KEYS | frozenset({"state", "operationTimeoutMs"})


class ExternalSearchRecipeError(ValueError):
    """The browser recipe is not one of the fixed typed actions."""


class ExternalSearchTransientError(RuntimeError):
    """A bounded school-page action failed without exposing raw diagnostics."""

    def __init__(self, code="SEARCH_TRANSIENT"):
        super().__init__(code)
        self.code = code if code in ERROR_STATUS else "SEARCH_TRANSIENT"


ERROR_STATUS = {
    "CURRENT_SESSION_CHANGED": 409,
    "SCHEMA_INVALID": 502,
    "TARGET_NOT_FOUND": 404,
    "AMBIGUOUS_TARGET": 409,
    "CAPTURE_MISSING": 503,
    "CAPTURE_API_REJECTED": 502,
    "CAPTURE_BODY_TIMEOUT": 504,
    "APP_READY_TIMEOUT": 503,
    "SEARCH_CAPTURE_TIMEOUT": 503,
    "SEARCH_REQUEST_HUNG": 504,
    "SEARCH_BODY_TIMEOUT": 504,
    "SEARCH_API_REJECTED": 502,
    "WAF_CHALLENGE": 503,
    "SEARCH_TRANSIENT": 503,
    "BROWSER_BUSY": 503,
    "BROWSER_DEADLINE": 503,
    "TGT_EXPIRED": 409,
    "PAGE_PERMISSION_DENIED": 403,
}

ALL_COURSE_URL = "https://my.cqu.edu.cn/tt/AllCourseSchedule"
ADMIN_SEARCH_MARKER = "/api/timetable/admin-class/dept-admin-classes"
INSTRUCTOR_SEARCH_MARKER = "/api/timetable/instructor/filter"
SESSION_INFO_URL = "https://my.cqu.edu.cn/api/resourceapi/session/info-detail"
SESSION_LIST_URL = "https://my.cqu.edu.cn/api/resourceapi/session/list"
DEPARTMENT_LIST_URL = "https://my.cqu.edu.cn/api/resourceapi/department/list"

ADMIN_CLASS_FILTER_ACTION_JS = """async ({ departmentName, grade }) => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const click = element => {
    if (!visible(element)) throw new Error('control not visible');
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const containerFor = text => {
    for (const label of document.querySelectorAll('label,span')) {
      if (label.tagName === 'SPAN' && label.children.length) continue;
      if (label.textContent.trim().replace(/[:：]\\s*$/, '') !== text) continue;
      const item = label.closest('.ant-form-item,.ant-row');
      return item?.querySelector('.ant-select') || label.nextElementSibling?.querySelector('.ant-select')
        || label.nextElementSibling?.classList?.contains('ant-select') && label.nextElementSibling
        || label.parentElement?.querySelector('.ant-select');
    }
    return null;
  };
  const optionText = option => (option.textContent || option.getAttribute('title') || '').trim();
  async function choose(label, wanted) {
    const control = containerFor(label);
    if (!control) throw new Error('control missing: ' + label);
    if (!wanted) {
      const clear = control.querySelector('.ant-select-clear,.ant-select-selection__clear');
      if (clear && visible(clear)) click(clear);
      return;
    }
    click(control.querySelector('.ant-select-selector') || control);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const options = [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option,[role="listbox"] [role="option"]')]
        .filter(option => visible(option));
      const match = options.find(option => optionText(option) === wanted
        || option.dataset.value === wanted || option.getAttribute('data-value') === wanted);
      if (match) { click(match); return; }
      await sleep(80);
    }
    throw new Error('option missing: ' + wanted);
  }
  const selectedText = label => {
    const control = containerFor(label);
    return (control?.querySelector('.ant-select-selection-item,.ant-select-selection-selected-value')?.textContent || '').trim();
  };
  const normalizeEmpty = text => ['', '全部', '全部学院'].includes(text) ? '' : text;

  await choose('查询范围', '行政班');
  await choose('学院', departmentName || '');
  await choose('年级', grade || '');
  for (const label of ['校区', '层次']) {
    const control = containerFor(label);
    const clear = control?.querySelector('.ant-select-clear,.ant-select-selection__clear');
    if (clear && visible(clear)) click(clear);
  }
  return {
    department: normalizeEmpty(selectedText('学院')),
    grade: normalizeEmpty(selectedText('年级')),
  };
}"""

ADMIN_CLASS_KEYWORD_ACTION_JS = """async ({ keyword }) => {
  const visible = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const label = [...document.querySelectorAll('label,span')].find(element =>
    (element.tagName === 'LABEL' || element.children.length === 0)
    && element.textContent?.trim().replace(/[:：]\\s*$/, '').startsWith('班级名称'));
  const placeholder = [...document.querySelectorAll('.ant-select-selection__placeholder')]
    .find(element => element.textContent?.includes('行政班名字快速查询'));
  const item = label?.closest('.ant-form-item,.ant-row') || label?.parentElement
    || placeholder?.closest('.ant-select')?.parentElement;
  const input = item?.querySelector('input')
    || placeholder?.closest('.ant-select')?.querySelector('input')
    || document.querySelector('input[placeholder*="班级"],input[placeholder*="行政班"]');
  if (!input || !visible(input)) throw new Error('keyword control missing');
  input.focus();
  input.value = keyword;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: keyword }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.value;
}"""

INSTRUCTOR_FILTER_ACTION_JS = """async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const click = element => {
    if (!visible(element)) throw new Error('control not visible');
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const controlFor = text => {
    for (const label of document.querySelectorAll('label,span')) {
      if (label.tagName === 'SPAN' && label.children.length) continue;
      if (label.textContent.trim().replace(/[:：]\\s*$/, '') !== text) continue;
      const item = label.closest('.ant-form-item,.ant-row');
      return item?.querySelector('.ant-select') || label.nextElementSibling?.querySelector('.ant-select')
        || label.nextElementSibling?.classList?.contains('ant-select') && label.nextElementSibling
        || label.parentElement?.querySelector('.ant-select');
    }
    return null;
  };
  const optionText = option => (option.textContent || option.getAttribute('title') || '').trim();
  const choose = async (label, wanted) => {
    const control = controlFor(label);
    if (!control) throw new Error('control missing: ' + label);
    click(control.querySelector('.ant-select-selector') || control);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const options = [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option,[role="listbox"] [role="option"]')]
        .filter(option => visible(option));
      const match = options.find(option => optionText(option) === wanted);
      if (match) { click(match); return; }
      await sleep(80);
    }
    throw new Error('option missing: ' + wanted);
  };

  await choose('查询范围', '教师');
  for (const label of ['校区', '层次']) {
    const control = controlFor(label);
    const clear = control?.querySelector('.ant-select-clear,.ant-select-selection__clear');
    if (clear && visible(clear)) click(clear);
  }
  const keywordControl = [...document.querySelectorAll('.ant-select')].find(control =>
    control.querySelector('input[placeholder*="教师"],input[placeholder*="工号"]'));
  const targetClear = keywordControl?.querySelector('.ant-select-clear,.ant-select-selection__clear');
  if (targetClear && visible(targetClear)) click(targetClear);
  return [...document.querySelectorAll('.ant-select-selection-item,.ant-select-selection-selected-value')]
    .some(element => (element.textContent || '').trim() === '教师') ? '教师' : '';
}"""

INSTRUCTOR_KEYWORD_ACTION_JS = """async ({ keyword }) => {
  const visible = element => !!element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // Ant Design Vue 1 renders its hint beside the input, not in input.placeholder.
  const placeholder = [...document.querySelectorAll('.ant-select-selection__placeholder')]
    .find(element => element.textContent?.includes('教师') || element.textContent?.includes('工号'));
  const control = placeholder?.closest('.ant-select');
  const input = control?.querySelector('input') || [...document.querySelectorAll('input')]
    .filter(element => element.placeholder?.includes('教师') || element.placeholder?.includes('工号'))
    .find(visible);
  if (!input) throw new Error('keyword control missing');
  if (!visible(input) && visible(control)) {
    control.click();
    const deadline = Date.now() + 1000;
    while (!visible(input) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!visible(input)) throw new Error('keyword control not visible');
  input.focus();
  input.value = keyword;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: keyword }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.value;
}"""


def _is_expected_search_request(request, expected_origin: str, filters: dict) -> bool:
    parsed = urllib.parse.urlsplit(getattr(request, "url", ""))
    response_origin = f"{parsed.scheme}://{parsed.netloc}"
    if response_origin != expected_origin or parsed.path != ADMIN_SEARCH_MARKER:
        return False
    if getattr(request, "method", "").upper() != "POST":
        return False

    query = urllib.parse.parse_qs(parsed.query)
    expected_grade = filters.get("grade", "")
    for name in ("grade", "gradeId"):
        if name in query and query[name] != [expected_grade]:
            return False
    expected_keyword = filters.get("keyword", "")
    for name in ("className", "adminClassName", "keyword"):
        if name in query and query[name] != [expected_keyword]:
            return False

    post_data = getattr(request, "post_data", None)
    if not isinstance(post_data, str):
        return False
    try:
        body = json.loads(post_data)
    except Exception:
        return False
    if not isinstance(body, list):
        return False
    return body == [] if not filters.get("departmentName", "") else len(body) > 0


def _is_expected_keyword_request(request, expected_origin: str, marker: str) -> bool:
    parsed = urllib.parse.urlsplit(getattr(request, "url", ""))
    response_origin = f"{parsed.scheme}://{parsed.netloc}"
    if response_origin != expected_origin or parsed.path != marker:
        return False
    if getattr(request, "method", "").upper() != "GET":
        return False
    # The production anti-bot layer can rewrite query text. The fixed path and
    # final-keypress correlation carry the business identity; do not require a
    # plaintext nameOrCode value to survive transport rewriting.
    return True


async def perform_admin_class_search(page, filters: dict) -> dict:
    """Drive visible controls and capture only the admin-class business response."""
    captures: list[dict] = []
    expected_page_url = urllib.parse.urlsplit(page.url)
    expected_origin = f"{expected_page_url.scheme}://{expected_page_url.netloc}"
    accepted_requests: dict[int, object] = {}
    tasks: set[asyncio.Task] = set()
    closed = False
    submit_started = False

    def on_request(request) -> None:
        if closed or not submit_started:
            return
        if _is_expected_search_request(request, expected_origin, filters):
            accepted_requests[id(request)] = request

    def on_response(response) -> None:
        if closed:
            return
        request = getattr(response, "request", None)
        if id(request) not in accepted_requests:
            return
        tasks.add(asyncio.create_task(_read_search_response(response, captures)))

    async def close_collector() -> None:
        nonlocal closed
        closed = True
        for task in tuple(tasks):
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    try:
        outcome = await page.evaluate("""async (args) => {
          try { return { ok: true, value: await (""" + ADMIN_CLASS_FILTER_ACTION_JS + """)(args) }; }
          catch (error) { return { ok: false, error: error ? String(error.message || error) : 'action failed' }; }
        }""", {
            "departmentName": filters.get("departmentName", ""),
            "grade": filters.get("grade", ""),
        })
        if not isinstance(outcome, dict) or outcome.get("ok") is not True:
            raise RuntimeError(str(outcome.get("error", "admin-class action failed")) if isinstance(outcome, dict) else "admin-class action failed")
        visibleFilters = outcome.get("value")
        expectedFilters = {
            "department": filters.get("departmentName", ""),
            "grade": filters.get("grade", ""),
        }
        if visibleFilters != expectedFilters:
            raise RuntimeError("admin-class filters did not settle")

        page.on_request(on_request)
        page.on_response(on_response)
        submit_started = True
        keywordOutcome = await page.evaluate("""async (args) => {
          try { return { ok: true, value: await (""" + ADMIN_CLASS_KEYWORD_ACTION_JS + """)(args) }; }
          catch (error) { return { ok: false, error: error ? String(error.message || error) : 'action failed' }; }
        }""", {"keyword": filters.get("keyword", "")})
        if (
            not isinstance(keywordOutcome, dict) or keywordOutcome.get("ok") is not True
            or keywordOutcome.get("value") != filters.get("keyword", "")
        ):
            raise RuntimeError(
                str(keywordOutcome.get("error", "admin-class keyword failed"))
                if isinstance(keywordOutcome, dict) else "admin-class keyword failed"
            )
        deadline = asyncio.get_running_loop().time() + 12
        while asyncio.get_running_loop().time() < deadline:
            capture = captures[0] if captures else {}
            status = capture.get("status", 0)
            if status == 403:
                raise ExternalSearchTransientError("PAGE_PERMISSION_DENIED")
            if status == 412:
                raise ExternalSearchTransientError("WAF_CHALLENGE")
            if status == 401:
                raise ExternalSearchTransientError("TGT_EXPIRED")
            if status >= 400:
                raise ExternalSearchTransientError("SEARCH_API_REJECTED")
            if capture and 200 <= capture["status"] < 300:
                return capture
            await page.pause(100)
        raise ExternalSearchTransientError("SEARCH_CAPTURE_TIMEOUT")
    finally:
        await close_collector()


async def _read_search_response(response, captures: list[dict], instructor: bool = False) -> None:
    try:
        status = getattr(response, "status", 0)
        body = await response.text()
        if instructor and 200 <= status < 300:
            raw = json.loads(body)
            if not isinstance(raw, list) or any(not isinstance(item, dict) for item in raw):
                body = "null"
            else:
                body = json.dumps([{key: item[key] for key in
                    ("id", "name", "code", "departmentName", "campusName") if key in item}
                    for item in raw])
        captures.append({"status": status, "body": body})
    except asyncio.CancelledError:
        raise
    except Exception:
        return


async def perform_instructor_search(page, filters: dict) -> dict:
    return await _perform_keyword_search(page, filters, "instructor")


async def perform_room_search(page, filters: dict) -> dict:
    return await _perform_keyword_search(page, filters, "room")


async def perform_laboratory_search(page, filters: dict) -> dict:
    return await _perform_keyword_search(page, filters, "laboratory")


async def _perform_keyword_search(page, filters: dict, source_type: str) -> dict:
    """Drive the fixed type-specific controls and capture the matching candidate response."""
    label, marker = {
        "instructor": ("教师", INSTRUCTOR_SEARCH_MARKER),
        "room": ("教室", "/api/resourceapi/room/roomName-filter"),
        "laboratory": ("实验室", "/api/timetable/course/LaboratoryId-filter"),
    }[source_type]
    filter_js = INSTRUCTOR_FILTER_ACTION_JS if source_type == "instructor" else INSTRUCTOR_FILTER_ACTION_JS.replace("教师", label).replace("工号", label)
    keyword_js = INSTRUCTOR_KEYWORD_ACTION_JS if source_type == "instructor" else INSTRUCTOR_KEYWORD_ACTION_JS.replace("教师", label).replace("工号", label)
    if source_type == "laboratory":
        filter_js = filter_js.replace("['校区', '层次']", "['校区', '层次', '实验中心']")
    captures: list[dict] = []
    expected_page_url = urllib.parse.urlsplit(page.url)
    expected_origin = f"{expected_page_url.scheme}://{expected_page_url.netloc}"
    accepted_requests: dict[int, object] = {}
    tasks: set[asyncio.Task] = set()
    closed = False
    submit_started = False

    def on_request(request) -> None:
        if closed or not submit_started:
            return
        if _is_expected_keyword_request(request, expected_origin, marker):
            accepted_requests[id(request)] = request

    def on_response(response) -> None:
        if closed:
            return
        request = getattr(response, "request", None)
        if id(request) not in accepted_requests:
            return
        tasks.add(asyncio.create_task(_read_search_response(response, captures, instructor=source_type == "instructor")))

    async def close_collector() -> None:
        nonlocal closed
        closed = True
        for task in tuple(tasks):
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    try:
        outcome = await page.evaluate("""async () => {
          try { return { ok: true, value: await (""" + filter_js + """)() }; }
          catch (error) { return { ok: false, error: error ? String(error.message || error) : 'action failed' }; }
        }""", {})
        if not isinstance(outcome, dict) or outcome.get("ok") is not True or outcome.get("value") != label:
            raise RuntimeError(
                str(outcome.get("error", "instructor filter action failed"))
                if isinstance(outcome, dict) else "instructor filter action failed"
            )

        page.on_request(on_request)
        page.on_response(on_response)
        submit_started = True
        keyword_outcome = await page.evaluate("""async (args) => {
          try { return { ok: true, value: await (""" + keyword_js + """)(args) }; }
          catch (error) { return { ok: false, error: error ? String(error.message || error) : 'action failed' }; }
        }""", {"keyword": filters.get("keyword", "")})
        if (
            not isinstance(keyword_outcome, dict) or keyword_outcome.get("ok") is not True
            or keyword_outcome.get("value") != filters.get("keyword", "")
        ):
            raise RuntimeError(
                str(keyword_outcome.get("error", "instructor keyword failed"))
                if isinstance(keyword_outcome, dict) else "instructor keyword failed"
            )
        deadline = asyncio.get_running_loop().time() + 12
        while asyncio.get_running_loop().time() < deadline:
            capture = captures[0] if captures else {}
            status = capture.get("status", 0)
            if status == 403:
                raise ExternalSearchTransientError("PAGE_PERMISSION_DENIED")
            if status == 412:
                raise ExternalSearchTransientError("WAF_CHALLENGE")
            if status == 401:
                raise ExternalSearchTransientError("TGT_EXPIRED")
            if status >= 400:
                raise ExternalSearchTransientError("SEARCH_API_REJECTED")
            if capture and 200 <= capture["status"] < 300:
                return capture
            await page.pause(100)
        raise ExternalSearchTransientError("SEARCH_CAPTURE_TIMEOUT")
    finally:
        await close_collector()


def _json_body(entry: dict, code: str) -> object:
    if entry.get("status") == 403:
        raise ExternalSearchTransientError("PAGE_PERMISSION_DENIED")
    if entry.get("status") == 412:
        raise ExternalSearchTransientError("WAF_CHALLENGE")
    if entry.get("status") == 401:
        raise ExternalSearchTransientError("TGT_EXPIRED")
    if entry.get("status") != 200:
        raise ExternalSearchTransientError(code)
    try:
        return json.loads(entry["body"])
    except Exception:
        raise ExternalSearchTransientError("SEARCH_BODY_TIMEOUT") from None


def _current_session(entries: list[dict]) -> dict:
    info = _json_body(entries[0], "SEARCH_API_REJECTED")
    full = _json_body(entries[1], "SEARCH_API_REJECTED")
    if not isinstance(info, dict) or not isinstance(full, dict):
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    session_id = info.get("curSessionId")
    sessions = full.get("sessionVOList")
    if not isinstance(session_id, str) or not isinstance(sessions, list):
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    matching = [item for item in sessions if isinstance(item, dict) and item.get("id") == session_id]
    if len(matching) != 1:
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    finder = info.get("sessionFinder")
    fallback = ""
    if isinstance(finder, list):
        fallback = next((item.get("name", "") for item in finder
                         if isinstance(item, dict) and item.get("id") == session_id), "")
    name = f"{matching[0].get('year', '')}{matching[0].get('term', '')}" or fallback
    if not name:
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    return {"id": session_id, "name": name}


def _department_nodes(value: object) -> list[dict]:
    if isinstance(value, dict):
        value = value.get("data")
    if not isinstance(value, list):
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ExternalSearchTransientError("SEARCH_API_REJECTED")
        children = _department_nodes(item.get("subDepartmentVOList", []))
        node = {"id": str(item.get("id", "")), "name": str(item.get("name", ""))}
        if children:
            node["children"] = children
        result.append(node)
    return result


def _admin_items(value: object) -> tuple[list[dict], bool]:
    if not isinstance(value, list):
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    items = []
    for item in value[:200]:
        if not isinstance(item, dict):
            raise ExternalSearchTransientError("SEARCH_API_REJECTED")
        extra = " / ".join(str(part) for part in (
            item.get("grade", ""), item.get("personNumber", ""), item.get("departmentName", "")
        ) if part != "")
        items.append({
            "id": str(item.get("id", "")),
            "name": str(item.get("className", "")),
            "extra": extra,
        })
    return items, len(value) >= 200


def _instructor_items(value: object) -> tuple[list[dict], bool]:
    if not isinstance(value, list):
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    items = []
    for item in value[:50]:
        if not isinstance(item, dict):
            raise ExternalSearchTransientError("SEARCH_API_REJECTED")
        extra = " / ".join(part for part in (
            item.get("code", ""), item.get("departmentName", ""), item.get("campusName", "")
        ) if isinstance(part, str) and part != "")
        items.append({
            "id": _typed_text(item.get("id")),
            "name": _typed_text(item.get("name")),
            "extra": extra,
        })
    return items, len(value) >= 50



def _room_items(value: object, source_type: str = "room") -> tuple[list[dict], bool]:
    if not isinstance(value, list):
        raise ExternalSearchTransientError("SEARCH_API_REJECTED")
    items = []
    for item in value[:50]:
        if not isinstance(item, dict):
            raise ExternalSearchTransientError("SEARCH_API_REJECTED")
        items.append({"id": _typed_text(item.get("id")), "name": _typed_text(item.get("roomName" if source_type == "laboratory" else "name")),
            "extra": " / ".join(part for part in (item.get("buildingName"), item.get("campusName"), item.get("roomTypeName")) if isinstance(part, str) and part)})
    return items, len(value) >= 50

def parse_external_search_recipe(body: dict) -> dict:
    if isinstance(body, dict) and body.get("action") in {"course_catalog_search", "teaching_class_search"}:
        from cqu_course_teaching import parse_course_recipe
        from cqu_external_capture import ExternalCaptureRecipeError
        try:
            return parse_course_recipe(body)
        except ExternalCaptureRecipeError:
            raise ExternalSearchRecipeError("invalid course recipe") from None
    if not isinstance(body, dict):
        raise ExternalSearchRecipeError("recipe must be an object")
    unknown = set(body) - ALLOWED_BODY_KEYS
    if unknown:
        raise ExternalSearchRecipeError("recipe contains unsupported transport fields")
    action = body.get("action")
    if action not in {"department_list", "admin_class_search", "instructor_search", "room_search", "laboratory_search"}:
        raise ExternalSearchRecipeError("unsupported action")

    department_id = body.get("departmentId", "")
    department_name = body.get("departmentName", "")
    grade = body.get("grade", "")
    keyword = body.get("keyword", "")
    if not all(isinstance(value, str) for value in (department_id, department_name, grade, keyword)):
        raise ExternalSearchRecipeError("filters must be strings")
    if len(department_id) > 100 or len(department_name) > 200 or len(keyword) > 100:
        raise ExternalSearchRecipeError("filter length exceeded")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in department_id + department_name + keyword):
        raise ExternalSearchRecipeError("filter control character")
    if grade and not GRADE_RE.fullmatch(grade):
        raise ExternalSearchRecipeError("invalid grade")
    if action == "department_list" and (department_id or department_name or grade or keyword):
        raise ExternalSearchRecipeError("department list accepts no filters")
    if action in {"instructor_search", "room_search", "laboratory_search"} and (department_id or department_name or grade or not keyword):
        raise ExternalSearchRecipeError("instructor search accepts only a keyword")
    return {
        "action": action,
        "departmentId": department_id,
        "departmentName": department_name,
        "grade": grade,
        "keyword": keyword,
    }


def _typed_text(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 200:
        raise ExternalSearchRecipeError("typed text is invalid")
    return value


def _typed_departments(value: object) -> list[dict]:
    if not isinstance(value, list):
        raise ExternalSearchRecipeError("departments must be a list")
    result = []
    for node in value:
        if not isinstance(node, dict):
            raise ExternalSearchRecipeError("department node must be an object")
        children = node.get("children")
        typed = {
            "id": _typed_text(node.get("id")),
            "name": _typed_text(node.get("name")),
        }
        if children is not None:
            typed["children"] = _typed_departments(children)
        result.append(typed)
    return result


def sanitize_external_search_result(value: object) -> dict:
    """Rebuild the response allowlist; state and diagnostics never cross this boundary."""
    if not isinstance(value, dict):
        raise ExternalSearchRecipeError("search result must be an object")
    source_type = value.get("sourceType")
    session = value.get("session")
    if value.get("contractVersion") != 1 or source_type not in {"department", "admin_class", "course_catalog", "course", "instructor", "room", "laboratory"}:
        raise ExternalSearchRecipeError("search result contract is invalid")
    if not isinstance(session, dict):
        raise ExternalSearchRecipeError("search session is invalid")
    typed = {
        "contractVersion": 1,
        "sourceType": source_type,
        "session": {
            "id": _typed_text(session.get("id")),
            "name": _typed_text(session.get("name")),
        },
    }
    if source_type == "department":
        typed["departments"] = _typed_departments(value.get("departments"))
        return typed
    items = value.get("items")
    truncated = value.get("truncated")
    if not isinstance(items, list) or not isinstance(truncated, bool):
        raise ExternalSearchRecipeError("search result is invalid")
    typed_items = []
    for item in items[:200]:
        if not isinstance(item, dict):
            raise ExternalSearchRecipeError("admin-class item is invalid")
        typed_items.append({
            "id": _typed_text(item.get("id")),
            "name": _typed_text(item.get("name")),
            "extra": item.get("extra") if isinstance(item.get("extra"), str) and item["extra"] else "",
        })
    if source_type == "course":
        course = value.get("course")
        if not isinstance(course, dict):
            raise ExternalSearchRecipeError("course context missing")
        typed["course"] = {"id": _typed_text(course.get("id")), "name": _typed_text(course.get("name"))}
    typed["items"] = typed_items
    typed["truncated"] = bool(truncated or len(items) > 200)
    return typed


EXTERNAL_APP_READY_JS = """() => {
  const label = [...document.querySelectorAll('label,span')].find(element =>
    (element.tagName === 'LABEL' || element.children.length === 0)
    && element.textContent.trim().replace(/[:：]\\s*$/, '') === '查询范围');
  const control = label?.closest('.ant-form-item,.ant-row')?.querySelector('.ant-select')
    || label?.nextElementSibling?.querySelector('.ant-select')
    || (label?.nextElementSibling?.classList?.contains('ant-select') && label.nextElementSibling)
    || label?.parentElement?.querySelector('.ant-select');
  return !!control && !control.classList.contains('ant-select-disabled')
    && control.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});
}"""


async def wait_for_external_app(page) -> None:
    """Poll across bootstrap navigation; an in-page promise dies on a reload."""
    started = asyncio.get_running_loop().time()
    deadline = started + 15
    context_errors = 0
    while (remaining := deadline - asyncio.get_running_loop().time()) > 0:
        try:
            if await asyncio.wait_for(page.evaluate(EXTERNAL_APP_READY_JS, {}), remaining) is True:
                return
        except Exception:
            # Startup redirects replace the execution context. Recheck the new
            # document within the same deadline rather than failing the search.
            context_errors += 1
        await page.pause(100)
    expired = False
    try:
        content = await asyncio.wait_for(page.content(), 1)
        expired = is_expired_harvest({}, content, page.url)
    except Exception:
        pass
    # Fixed values only: never log the document, URL, cookies, or browser state.
    logging.getLogger(__name__).warning(
        "external-page readiness timeout (elapsed_ms=%d context_errors=%d expired=%s)",
        round((asyncio.get_running_loop().time() - started) * 1000), context_errors, expired,
    )
    raise ExternalSearchTransientError("TGT_EXPIRED" if expired else "APP_READY_TIMEOUT")


async def external_search(state: dict, recipe: dict) -> dict:
    """Run one fixed action in the user's hydrated AllCourseSchedule browser session."""
    if recipe.get("action") not in {"department_list", "admin_class_search", "instructor_search", "room_search", "laboratory_search", "course_catalog_search", "teaching_class_search"}:
        raise ExternalSearchRecipeError("unsupported action")
    browser = ChromiumSession(seed_state=state)
    async with browser:
        try:
            await browser.navigate(
                ALL_COURSE_URL,
                wait_until="domcontentloaded",
                timeout_s=browser_profile.HARVEST_NAV_TIMEOUT_MS / 1000,
            )
        except Exception:
            raise ExternalSearchTransientError("APP_READY_TIMEOUT") from None
        if is_expired_harvest({}, await browser.content(), browser.url):
            raise ExternalSearchTransientError("TGT_EXPIRED")
        await wait_for_external_app(browser)

        if recipe["action"] in {"course_catalog_search", "teaching_class_search"}:
            from cqu_course_teaching import search_course_catalog, search_teaching_classes
            from cqu_external_capture import ExternalCaptureTransientError
            try:
                action = search_course_catalog if recipe["action"] == "course_catalog_search" else search_teaching_classes
                return await action(browser, recipe)
            except ExternalCaptureTransientError as error:
                raise ExternalSearchTransientError(error.code) from None
        trace = StageTrace()
        fixed_fetches = [
            {"method": "GET", "url": SESSION_INFO_URL},
            {"method": "GET", "url": SESSION_LIST_URL},
        ]
        if recipe["action"] == "department_list":
            fixed_fetches.append({"method": "GET", "url": DEPARTMENT_LIST_URL})
        entries: list[dict] = []
        await run_serial_inpage_gets(browser, fixed_fetches, trace, entries)

        session = _current_session(entries)
        if recipe["action"] == "department_list":
            return {
                "contractVersion": 1,
                "sourceType": "department",
                "session": session,
                "departments": _department_nodes(_json_body(entries[2], "SEARCH_API_REJECTED")),
            }

        if recipe["action"] in {"instructor_search", "room_search", "laboratory_search"}:
            source_type = recipe["action"].removesuffix("_search")
            action = {"instructor": perform_instructor_search, "room": perform_room_search, "laboratory": perform_laboratory_search}[source_type]
            capture = await action(browser, recipe)
            try:
                raw = json.loads(capture["body"])
            except Exception:
                raise ExternalSearchTransientError("SEARCH_BODY_TIMEOUT") from None
            items, truncated = _instructor_items(raw) if source_type == "instructor" else _room_items(raw, source_type)
        else:
            capture = await perform_admin_class_search(browser, recipe)
            try:
                raw = json.loads(capture["body"])
            except Exception:
                raise ExternalSearchTransientError("SEARCH_BODY_TIMEOUT") from None
            items, truncated = _admin_items(raw)
            source_type = "admin_class"
        return {
            "contractVersion": 1,
            "sourceType": source_type,
            "session": session,
            "items": items,
            "truncated": truncated,
        }
