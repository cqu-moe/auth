"""Fixed current-term course catalog and teaching-class UI actions."""
import asyncio
import json
import urllib.parse

from cqu_data_harvest import StageTrace, run_serial_inpage_gets
from cqu_external_capture import (
    ExternalCaptureTransientError, _current_session, _json_entry,
    _required_text, _optional_text, _clear_selected_targets,
    SESSION_INFO_PATH, SESSION_LIST_PATH,
)

CATALOG_PATH = '/api/timetable/course/info-by-name-or-code'
PROJECTS_PATH = '/api/timetable/optionFinder/expr-prj'
CLASSES_PATH = '/api/timetable/course/search-class-by-courseId'
ORDINARY_PATH = '/api/timetable/class/timetable/course/table-detail'
EXPERIMENT_PATH = '/api/timetable/class/timetable/expr-prj/table-detail'

RANGE_JS = """async () => {
  const visible = e => e && e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});
  const label = [...document.querySelectorAll('label,span')].find(e =>
    !e.children.length && e.textContent.trim().replace(/[:：]\\s*$/, '') === '查询范围');
  const control = label?.closest('.ant-form-item,.ant-row')?.querySelector('.ant-select')
    || label?.parentElement?.querySelector('.ant-select');
  if (!visible(control) || control.classList.contains('ant-select-disabled')) return false;
  const selected = control.querySelector('.ant-select-selection-item,.ant-select-selection-selected-value');
  if (selected?.textContent.trim() === '课程') return true;
  control.click();
  const deadline = Date.now() + 5000;
  while(Date.now() < deadline) {
    const option = [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option,[role="listbox"] [role="option"]')]
      .find(e => visible(e) && e.textContent.trim() === '课程');
    if(option) { option.click(); return true; }
    await new Promise(r => setTimeout(r,80));
  }
  return false;
}"""
INPUT_JS = """async ({keyword}) => {
  const visible = e => e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const placeholder = [...document.querySelectorAll('.ant-select-selection__placeholder')]
    .find(e => e.textContent.includes('课程名称') || e.textContent.includes('课程代码'));
  const control = placeholder?.closest('.ant-select');
  const input = control?.querySelector('input') || document.querySelector('input[placeholder*="课程"]');
  if (!input) return false;
  if (!visible(input) && visible(control)) {
    control.click();
    const deadline = Date.now() + 1000;
    while (!visible(input) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!visible(input)) return false;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(input,keyword);
  input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:keyword}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}"""
SELECT_JS = """async ({id,name}) => {
  const deadline = Date.now() + 5000;
  while(Date.now() < deadline) {
    const options = [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option,[role="listbox"] [role="option"]')]
      .filter(e => e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
    const matches = options.filter(e => {
      const value = e.dataset.value || e.getAttribute('data-value');
      const text = e.textContent.trim();
      return value ? value === id : text === name || text.startsWith(name+' ') || text.startsWith(name+'[');
    });
    if(matches.length > 1) return 'AMBIGUOUS_TARGET';
    if(matches.length === 1) { matches[0].click(); return true; }
    await new Promise(r => setTimeout(r,80));
  }
  return 'TARGET_NOT_FOUND';
}"""


def parse_course_recipe(body):
    from cqu_external_capture import ExternalCaptureRecipeError
    if not isinstance(body, dict):
        raise ExternalCaptureRecipeError('invalid course recipe')
    action = body.get('action')
    keys = {'action', 'state', 'operationTimeoutMs'}
    if action == 'course_catalog_search':
        keys |= {'keyword'}
        fields = {'keyword': 100}
    elif action in {'teaching_class_search', 'teaching_class_capture'}:
        keys |= {'courseId', 'courseName', 'expectedSessionId'}
        fields = {'courseId':100, 'courseName':200, 'expectedSessionId':100}
        if action == 'teaching_class_capture':
            keys |= {'sourceType', 'targetId', 'targetName'}
            fields |= {'targetId':100, 'targetName':200}
            if body.get('sourceType') != 'course':
                raise ExternalCaptureRecipeError('invalid course source')
    else:
        raise ExternalCaptureRecipeError('invalid course action')
    if set(body) - keys:
        raise ExternalCaptureRecipeError('unsupported course fields')
    recipe = {'action':action}
    for name, limit in fields.items():
        try:
            recipe[name] = _required_text(body.get(name),limit)
        except ExternalCaptureTransientError:
            raise ExternalCaptureRecipeError('invalid course fields') from None
    if action == 'teaching_class_capture':
        recipe['sourceType'] = 'course'
    return recipe


async def current_session(page, expected=None):
    parsed = urllib.parse.urlsplit(page.url)
    origin = f'{parsed.scheme}://{parsed.netloc}'
    entries = []
    await run_serial_inpage_gets(page, [
        {'method':'GET', 'url':origin+SESSION_INFO_PATH},
        {'method':'GET', 'url':origin+SESSION_LIST_PATH},
    ], StageTrace(), entries)
    session = _current_session(entries)
    if expected is not None and expected != session['id']:
        raise ExternalCaptureTransientError('CURRENT_SESSION_CHANGED')
    return session


async def collect(page, expected, action):
    """Accept only responses to matching requests started by this UI operation."""
    requests = {}
    captures = {}
    tasks = set()
    active = True
    async def read(response, key):
        try:
            entry = {'status':response.status, 'body':await response.text()}
            if active:
                captures.setdefault(key, entry)
        except asyncio.CancelledError:
            raise
        except Exception:
            return
    def request_seen(request):
        if active:
            key = expected(request)
            if key:
                requests[id(request)] = (request,key)
    def response_seen(response):
        request = getattr(response,'request',None)
        match = requests.get(id(request))
        if active and match and match[0] is request:
            tasks.add(asyncio.create_task(read(response,match[1])))
    page.on_request(request_seen)
    page.on_response(response_seen)
    try:
        if await action() is not True:
            raise ExternalCaptureTransientError('TARGET_NOT_FOUND')
        deadline = asyncio.get_running_loop().time()+15
        while asyncio.get_running_loop().time() < deadline:
            for entry in captures.values():
                _json_entry(entry,'CAPTURE_API_REJECTED')
            if all(key in captures for key in expected.keys):
                return {key:_json_entry(captures[key],'CAPTURE_API_REJECTED') for key in expected.keys}
            await page.pause(100)
        raise ExternalCaptureTransientError('CAPTURE_MISSING')
    finally:
        active = False
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks,return_exceptions=True)


def matcher(page, rules):
    origin = urllib.parse.urlsplit(page.url)
    def match(request):
        url = urllib.parse.urlsplit(getattr(request,'url',''))
        if (url.scheme,url.netloc) != (origin.scheme,origin.netloc):
            return None
        if getattr(request,'resource_type','').lower() not in {'xhr','fetch'}:
            return None
        query = urllib.parse.parse_qs(url.query,keep_blank_values=True)
        for key,(path,method,params,body) in rules.items():
            if url.path != path or getattr(request,'method','').upper() != method or query != params:
                continue
            if method == 'POST':
                try:
                    posted = json.loads(request.post_data)
                    if not isinstance(posted,list) or any(not isinstance(i,str) or not i for i in posted):
                        continue
                    if body is not None and posted != body:
                        continue
                    match.bodies.setdefault(key,[]).append(posted)
                except (TypeError,ValueError):
                    continue
            return key
        return None
    match.bodies = {}
    match.keys = tuple(rules)
    return match


def catalog_rows(value):
    if not isinstance(value,dict) or value.get('status') != 200 or not isinstance(value.get('data'),list):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    return value['data']


def items(rows, classes=False):
    if not isinstance(rows,list):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    result = []
    seen = set()
    for row in rows:
        if not isinstance(row,dict):
            raise ExternalCaptureTransientError('SCHEMA_INVALID')
        item = {'id':_required_text(row.get('id'),100),'name':_required_text(row.get('name') or (row.get('classNbr') if classes else None),200)}
        if item['id'] in seen:
            raise ExternalCaptureTransientError('AMBIGUOUS_TARGET')
        seen.add(item['id'])
        if classes:
            nbr = _optional_text(row.get('classNbr'))
            teacher = _optional_text(row.get('instructorName') or row.get('teacherName'))
            item['extra'] = ' / '.join(x for x in (nbr+'班' if nbr else None,teacher) if x)
        else:
            item['extra'] = _optional_text(row.get('codeR') or row.get('code')) or ''
        result.append(item)
    return result[:200], len(rows)>=200


async def search_course_catalog(page,recipe):
    session = await current_session(page)
    if await page.evaluate(RANGE_JS,{}) is not True:
        raise ExternalCaptureTransientError('APP_READY_TIMEOUT')
    await _clear_selected_targets(page)
    expected = matcher(page, {'catalog':(CATALOG_PATH,'GET',{
        'nameOrCode':[recipe['keyword']], 'pageSize':['50'],'sessionId':[session['id']],
    },None)})
    response = await collect(page,expected,lambda:page.evaluate(INPUT_JS,{'keyword':recipe['keyword']}))
    rows = catalog_rows(response['catalog'])
    result,truncated = items(rows)
    truncated = truncated or len(rows)>=50
    await current_session(page,session['id'])
    return {'contractVersion':1,'sourceType':'course_catalog','session':{'id':session['id'],'name':session['name']},'items':result,'truncated':truncated}


async def teaching_candidates(page,recipe):
    session = await current_session(page,recipe['expectedSessionId'])
    catalog = await search_course_catalog(page,{'keyword':recipe['courseName']})
    if catalog['session']['id'] != session['id']:
        raise ExternalCaptureTransientError('CURRENT_SESSION_CHANGED')
    matches = [i for i in catalog['items'] if i['id']==recipe['courseId'] and i['name']==recipe['courseName']]
    if len(matches)!=1:
        raise ExternalCaptureTransientError('TARGET_NOT_FOUND')
    expected = matcher(page,{'classes':(CLASSES_PATH,'GET',{
        'courseId':[recipe['courseId']],'sessionId':[session['id']],
    },None)})
    response = await collect(page,expected,lambda:page.evaluate(SELECT_JS,{'id':recipe['courseId'],'name':recipe['courseName']}))
    rows = response['classes']
    typed,truncated = items(rows,True)
    await current_session(page,session['id'])
    return session,rows,typed,truncated


async def search_teaching_classes(page,recipe):
    session,_,typed,truncated = await teaching_candidates(page,recipe)
    return {'contractVersion':1,'sourceType':'course','session':{'id':session['id'],'name':session['name']},
            'course':{'id':recipe['courseId'],'name':recipe['courseName']},'items':typed,'truncated':truncated}


def sanitize_course_timetable(value,target_id):
    if not isinstance(value,dict) or any(isinstance(v,list) and k!='classTimetableVOList' for k,v in value.items()):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    rows = value.get('classTimetableVOList')
    maximum = value.get('maxSection')
    if not isinstance(rows,list) or type(maximum) is not int or not 1<=maximum<=14:
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    result = []
    for row in rows:
        if not isinstance(row,dict):
            raise ExternalCaptureTransientError('SCHEMA_INVALID')
        class_id = _required_text(row.get('classId'),100)
        if class_id != target_id:
            continue
        typed = {}
        try:
            for key in ('courseName','exprProjectName','instructorName','roomName','position','campusName','teachingWeek','period'):
                text = _optional_text(row.get(key))
                if text is not None:
                    typed[key] = text
            day = row.get('weekDay')
            if day is not None:
                if isinstance(day,bool) or not isinstance(day,(str,int)) or not str(day).isdigit() or not 1<=int(day)<=7:
                    raise ExternalCaptureTransientError('SCHEMA_INVALID')
                typed['weekDay'] = int(day)
        except ExternalCaptureTransientError:
            typed = {}
        typed['classId'] = class_id
        result.append(typed)
    return {'classTimetableVOList':result,'maxSection':maximum}


async def capture_teaching_class(page,recipe):
    session = await current_session(page,recipe['expectedSessionId'])
    catalog = await search_course_catalog(page,{'keyword':recipe['courseName']})
    if catalog['session']['id'] != session['id']:
        raise ExternalCaptureTransientError('CURRENT_SESSION_CHANGED')
    if not any(i['id']==recipe['courseId'] and i['name']==recipe['courseName'] for i in catalog['items']):
        raise ExternalCaptureTransientError('TARGET_NOT_FOUND')
    # Course selection naturally loads finder IDs, all current class IDs, and
    # both tables. Validate page-owned POST bodies against those captured lists.
    expected = matcher(page,{
        'projects':(PROJECTS_PATH,'GET',{'courseId':[recipe['courseId']]},None),
        'classes':(CLASSES_PATH,'GET',{'courseId':[recipe['courseId']],'sessionId':[session['id']]},None),
        'ordinary':(ORDINARY_PATH,'POST',{'sessionId':[session['id']]},None),
        'experiments':(EXPERIMENT_PATH,'POST',{'sessionId':[session['id']]},None),
    })
    captured = await collect(page,expected,lambda:page.evaluate(SELECT_JS,{'id':recipe['courseId'],'name':recipe['courseName']}))
    classes,_ = items(captured['classes'],True)
    target = [r for r in classes if r['id']==recipe['targetId'] and r['name']==recipe['targetName']]
    if len(target)!=1:
        raise ExternalCaptureTransientError('TARGET_NOT_FOUND')
    projects = captured['projects']
    if not isinstance(projects,list) or any(not isinstance(r,dict) for r in projects):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    project_ids = [_required_text(r.get('id'),100) for r in projects if r.get('id') != '']
    class_ids = [r['id'] for r in classes]
    if len(classes) != len(captured['classes']) or len(set(project_ids)) != len(project_ids):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    if expected.bodies.get('ordinary') != [class_ids] or expected.bodies.get('experiments') != [project_ids]:
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    ordinary_raw = captured['ordinary']
    if not isinstance(ordinary_raw,dict) or not isinstance(ordinary_raw.get('classTimetableVOList'),list):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    if any(not isinstance(r,dict) or r.get('classId') not in class_ids for r in ordinary_raw['classTimetableVOList']):
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    ordinary = sanitize_course_timetable(ordinary_raw,recipe['targetId'])
    experiments = captured['experiments']
    # Research established successful empty expr tables for nonempty project
    # requests, but no ownership schema for nonempty expr rows. Fail closed.
    if not isinstance(experiments,dict) or experiments.get('classTimetableVOList') != []:
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    typed_experiments = sanitize_course_timetable(experiments,recipe['targetId'])
    if ordinary['maxSection'] != typed_experiments['maxSection']:
        raise ExternalCaptureTransientError('SCHEMA_INVALID')
    await current_session(page,session['id'])
    return {'contractVersion':1,'sourceType':'course','target':{'id':recipe['targetId'],'name':recipe['targetName']},
            'course':{'id':recipe['courseId'],'name':recipe['courseName']},'session':session,'timetable':ordinary}
