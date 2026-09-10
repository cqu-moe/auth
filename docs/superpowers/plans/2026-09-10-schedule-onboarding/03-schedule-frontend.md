# Schedule 前端任务 08–10

本章 cwd 为 SCHEDULE worktree。生产页面必须修改现有 Dashboard，不能复制预览的演示页面取代业务。Task08可测试composable与Add接线，Dashboard对新composable的实际调用留给Task10，避免跨任务修改。

## Task 08：服务入口和自动初始化接续

**Files**
- 修改 `frontend/src/config/auth.ts`、`api/index.ts`、`types/api.ts`、`stores/subscriptions.ts`。
- 修改 `frontend/src/views/Home.vue`、`views/Add.vue`、`components/Navbar.vue` 的相关入口。
- 新建 `frontend/src/composables/usePersonalSetup.ts` 及 `__tests__/usePersonalSetup.test.ts`。
- 追加现有 Home/Navbar/API/Session 的测试。

**Consumes**：Auth `/cqu/bind?redirect=...`，后端 defaults 与 list.personal_setup。
**Produces**：
```ts
export function authCquBindUrl(returnTo: string, options?: { repair?: boolean }): string;
export function scheduleSetupTarget(returnTo: string): string;
// api 对象新增
ensureDefaultSubscriptions(): Promise<DefaultSubscriptionsResponse>;
// SubscriptionList 新增可选 personal_setup；store新增
personalSetup: PersonalSetupSummary | null;
// composable 返回
interface PersonalSetupController {
  preparing: Ref<boolean>;
  error: Ref<string | null>;
  startedThisVisit: Ref<boolean>;
  begin: () => Promise<void>;
}
```
DefaultSubscriptionsResponse 与 PersonalSetupSummary 的字段逐字复制后端契约到前端 types，不能把 snake_case 改成 camelCase。

- [ ] 先写 URL 红测试：
```ts
it('enters Auth binding with a dashboard setup return target', () => {
  const result = new URL(authCquBindUrl('https://schedule.cqu.moe/'));
  expect(result.origin + result.pathname).toBe('https://auth.cqu.moe/cqu/bind');
  expect(result.searchParams.get('redirect')).toBe('https://schedule.cqu.moe/dashboard?setup=1');
});
it('preserves a protected deep link', () => {
  const result = new URL(authCquBindUrl('https://schedule.cqu.moe/add?from=menu'));
  expect(result.searchParams.get('redirect')).toBe('https://schedule.cqu.moe/add?from=menu&setup=1');
});
```
- [ ] 固定实现，不修改旧authLoginUrl对其他明确调用方的语义：
```ts
export function scheduleSetupTarget(returnTo: string): string {
  const target = new URL(returnTo);
  if (target.pathname === '/') target.pathname = '/dashboard';
  target.searchParams.set('setup', '1');
  return target.toString();
}
export function authCquBindUrl(returnTo: string, options: { repair?: boolean } = {}): string {
  const binding = new URL('/cqu/bind', AUTH_BASE_URL);
  binding.searchParams.set('redirect', scheduleSetupTarget(returnTo));
  if (options.repair) binding.searchParams.set('repair', '1');
  return binding.toString();
}
```
returnTo由本站window.location.origin+route.fullPath生成，不接受任意用户输入作为身份或最终目标。
- [ ] Home主按钮固定「开始使用」。未登录/明确未绑定/状态未知→authCquBindUrl；已登录且明确active→内部`/dashboard?setup=1`。普通导航“仪表盘”仍`/dashboard`，不每次触发初始化。
- [ ] Navbar未登录“登录”入口、axios受保护请求401跳转改用authCquBindUrl；原TOKEN_EXPIRED抑制和getMe.suppressAuthRedirect保留，不能把上游过期误认为Auth登录失效。匿名公共课表页不能被强制绑账号。
- [ ] Add/Dashboard的绑定引导直接链接`/cqu/bind`，取消target=_blank（学校修改邮箱按钮仍新标签）。固定名称「绑定重庆大学统一认证账号」。NEEDS_REAUTH入口传`{repair:true}`，生成Auth的`repair=1`参数，避免仍有active凭证的账号被bootstrap立即送回原失败页面。恢复失效登录不删除已有订阅。
- [ ] api.ensureDefaultSubscriptions 执行 `client.post<DefaultSubscriptionsResponse>('/subscriptions/defaults')`，不发学号/userId/body。list.load把`personal_setup ?? null`保存，reset一并清空。
- [ ] composable内部依赖 useRoute/useRouter/useSession/useSubscriptionsStore，使用 `inFlight: Promise<void>|null` 合并同页面并发。begin控制流固定：
  1. `route.query.setup !== '1'`直接返回，不在普通GET/空列表上自动创建。
  2. 每次新的接续先重新session.load，避免返回页面读取绑定前缓存；开始加载时保留真实loading，禁止渲染“无订阅”闪屏。
  3. 无sync权限：不调用defaults，删除setup查询参数，正常继续。无新权益界面。
  4. 明确未绑定：转authCquBindUrl当前地址；unknown不自行断言未绑定，defaults返回503时显示原位重试，不能循环跨站。
  5. preparing=true，清error，startedThisVisit=true；调用defaults，随后subStore.load(true)。Queue.dispatch_status不是sync结果。
  6. created/resumed且当前为/add：replace到/dashboard，保留必要的其它query；existing停留原页面。新用户不用在Add手工选择。
  7. 成功处理后只移除setup参数（保留其他query/hash），用router.replace避免浏览器后退重复入站。
  8. 请求失败设置error，保留setup=1以便重试；不把错误当“无订阅”。finally清preparing/inFlight。
- [ ] Add与Dashboard共用composable；只有新用户自动初始化成功时从Add回Dashboard。已有用户的Add正常功能保留。不得为此新建另一套课表主页。
- [ ] 已有setup的未投递恢复：若list.personal_setup为created，dispatch_status为pending/sending，使用Dashboard原有runSyncPoll轮询节奏重试defaults以恢复已存在的投递记录；后端只恢复同一记录，不新增订阅。最多保持一个in-flight请求，尊重429退避。dispatch_status为failed显示可重试错误；后台cron仍负责无人停留时的投递恢复。不要额外启动另一套setInterval。
- [ ] 缓存恢复：Dashboard在pageshow.persisted或从Auth返回获得focus时重新load session/list；与现有轮询合并，防止重复请求。不要在focus事件直接调用defaults，只有带setup=1的显式begin才创建。
- [ ] 测试矩阵：setup不存在零POST；同页重复begin只一次POST；无权限零POST；session已active后创建；unknown显示错误不跳Auth；query清理保留其他参数；请求失败可重试；created返回Add→Dashboard；existing返回Add仍Add；reload/list读取已有metadata不重新创建；401/上游TOKEN_EXPIRED分支保持原意。
- [ ] 运行前端对应测试和 `npm --prefix frontend run build`。提交建议 `feat(schedule): continue service entry into automatic personal setup`。

## Task 09：固定同步提示组件与真实状态推导

**Files**
- 新建 `frontend/src/components/FirstSyncNotice.vue`、`components/__tests__/FirstSyncNotice.test.ts`。
- 新建 `frontend/src/lib/first-sync-state.ts`、`lib/__tests__/first-sync-state.test.ts`。

**Consumes**：真实订阅对象、setup.subscription_ids、现有pendingRefresh/localSyncErrors。
**Produces**：固定 FirstSyncNotice 和纯状态函数；不包含fetch，不产生模拟timer。

- [ ] 先写组件行为红测试：
```ts
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import FirstSyncNotice from '../FirstSyncNotice.vue'

describe('FirstSyncNotice', () => {
  it('keeps a readable waiting state without a pretend percentage', () => {
    const wrapper = mount(FirstSyncNotice,{props:{phase:'syncing'}})
    expect(wrapper.find('[role=status]').text()).toContain('正在同步课表')
    expect(wrapper.text()).not.toMatch(/\d+%/)
    expect(wrapper.find('button').exists()).toBe(false)
  })
  it('emits retry only when an enabled retry is chosen', async () => {
    const wrapper = mount(FirstSyncNotice,{props:{phase:'error'}})
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await wrapper.setProps({retryDisabled:true})
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
  it('lets the user dismiss the completed notice', async () => {
    const wrapper = mount(FirstSyncNotice,{props:{phase:'success'}})
    await wrapper.find('[aria-label="关闭同步提示"]').trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })
  it('does not claim subscriptions were saved when creation failed', () => {
    const wrapper = mount(FirstSyncNotice,{props:{phase:'error',preparationFailed:true}})
    expect(wrapper.text()).toContain('订阅准备未完成')
    expect(wrapper.text()).not.toContain('订阅已保留')
  })
})
```
- [ ] 将冻结包 `implementation-reference/FirstSyncNotice.vue` 原样复制到目标文件。这是本计划提供的生产组件参考，只包含已确认UI和必要props/emits，没有演示数组。不要自行选择另一套颜色、排版或动效。后续真实业务修正props接口必须保持本计划契约并有失败测试。
- [ ] 状态函数固定接口：
```ts
import type { Subscription } from '@/types/api'
export type FirstSyncPhase = 'preparing' | 'syncing' | 'success' | 'error'
export interface FirstSyncInput {
  subscriptions: Subscription[]
  targetIds: string[]
  pendingIds: ReadonlySet<string>
  localErrors: Readonly<Record<string,string>>
  preparing: boolean
  preparationError: string | null
}
export function deriveFirstSyncPhase(input: FirstSyncInput): FirstSyncPhase | null {
  if (input.preparing) return 'preparing'
  if (input.preparationError) return 'error'
  const targets=input.subscriptions.filter(sub=>input.targetIds.includes(sub.id))
  if (targets.length===0) return null
  if (targets.some(sub=>input.pendingIds.has(sub.id)||sub.sync_status==='queued'||sub.sync_status==='running')) return 'syncing'
  if (targets.some(sub=>Boolean(input.localErrors[sub.id])||sub.sync_status==='error')) return 'error'
  if (targets.every(sub=>sub.sync_status==='success'&&Boolean(sub.last_synced_at))) return 'success'
  return 'preparing'
}
```
卡片状态、提示状态必须消费同一批服务器数据。不能把一个HTTP201/202当sync success。临时混合状态先等待，全部结束后再给整体结论。
- [ ] 纯函数测试至少包括：queued、running、三success、success+error、success+queued、旧success但localPending存在、preparationError、空目标、删除一张后的剩余目标、null last_synced_at不得success、本地超时error优先于旧数据success。
```ts
it('does not mistake existing data for completion of a new request', () => {
  const subscription=mockSubscription({id:'a',sync_status:'success',last_synced_at:'2026-09-10T08:00:00Z'})
  expect(deriveFirstSyncPhase({subscriptions:[subscription],targetIds:['a'],pendingIds:new Set(['a']),localErrors:{},preparing:false,preparationError:null})).toBe('syncing')
})
```
mockSubscription来自现有`@/test-utils`，不得用状态函数自己生成expected。
- [ ] 绿组件测试/状态测试/build。提交建议 `feat(schedule): add the approved first-sync status notice`。

## Task 10：在原 Dashboard 接线，保留现有功能

**Files**
- 修改 `frontend/src/views/Dashboard.vue`，不得整文件替换。
- 修改 `frontend/src/views/__tests__/Dashboard.test.ts`。
- 最小修改 `frontend/src/components/Navbar.vue` 的手机换行/留白；desktop导航样式不变。

**Consumes**：Task08的控制器/store metadata；Task09组件与状态函数；原pendingRefresh、localSyncErrors、handleSyncAll、canManualRefresh、syncAllCooldownSeconds。
**Produces**：与冻结第二版外观一致、使用真实API的首次同步反馈。

- [ ] 在当前Dashboard测试的mockApi补`ensureDefaultSubscriptions`，返回真实契约；list fixture增加personal_setup。默认旧用例personal_setup为null，确保老页面不被强行显示首次提示。
- [ ] 先写以下红测试，再接线：
  1. 新用户创建完成后显示三张原Card，标题/额度取服务端，包含复制、二维码、网页预览、更多。
  2. 初始同步中提示只出现一次；不是三个大提示，也不创建新的课表网格。
  3. 201/202返回而列表queued时仍同步中。
  4. 三项success后提示可关闭，现有操作按钮可用。
  5. 一项error、无任何pending时出现重试，调用现有个人组刷新一次。
  6. 初始化失败时重试调用defaults，同步失败时重试调用现有syncs，两者不混淆。
  7. 首次无数据复制/二维码/预览禁用；已有last_synced_at的老订阅在后台刷新时仍可复制旧链接。
  8. 已经完成初始化后普通再次打开Dashboard不重复祝贺、不创建订阅。
  9. 关闭提示只隐藏提示，不取消同步、不删除卡片；刷新中断重新进来能读取真实状态。
  10. 既有通知、删除确认、share管理、下载菜单和429冷却用例不退化。

- [ ] composable在原onMounted流程内调用，避免和原subStore.load并发竞速：先加载session，再begin（只有setup=1执行）；然后使用原加载和trackRefresh逻辑。不要同时保留旧一次初始load与新增另一次无序写回。
- [ ] targetIds来自`subStore.personalSetup?.status==='created'`时的subscription_ids；不是根据“看到三个卡片”猜。初始化准备中只显示提示；等真实三条创建返回后再显示卡片，不构造假Subscription。
- [ ] 提示可见性用本页状态：这次begin启动，或载入时setup创建的订阅仍首次未同步，才显示。成功后本页继续显示，用户可关；下次普通访问成功的老订阅不再显示。sessionStorage可以按当前user+setup.run_id存关闭状态，只保存布尔值，不能把它当初始化完成记录。storage异常不影响使用。
- [ ] 在script中将composable的Ref解构成顶层变量，避免模板中嵌套Ref总为truthy：
```ts
const { preparing, error: preparationError, startedThisVisit, begin: beginPersonalSetup } = usePersonalSetup()
```
- [ ] 在原loading skeleton之后、绑定引导之前插入：
```vue
<FirstSyncNotice
  v-if="showFirstSyncNotice && firstSyncPhase"
  :phase="firstSyncPhase"
  :preparation-failed="Boolean(preparationError)"
  :error-message="preparationError ?? ''"
  :retry-disabled="firstSyncRetryDisabled"
  :retry-hint="firstSyncRetryHint"
  @retry="retryFirstSync"
  @dismiss="dismissFirstSync"
/>
```
模板只用上述顶层Ref名称，依靠Vue自动解包；不要写setup.error或额外的.value。
`firstSyncPhase` 用deriveFirstSyncPhase computed；`pendingIds` 来自Object.keys(pendingRefresh)，`localErrors`来自原localSyncErrors。`firstSyncRetryDisabled`：创建失败时preparing；同步失败时原canManualRefresh=false/组冷却/已有pending。`firstSyncRetryHint`复用原cooldownLabel或额度提示。
`retryFirstSync`：有preparationError调用beginPersonalSetup，否则await原handleSyncAll。`dismissFirstSync`只写本页dismissed和可选sessionStorage，不清除setup表。
- [ ] 初始无数据的按钮条件固定：`const unavailable = !item.sub.last_synced_at`。仅在新初始化相关卡片上应用，并且GET失败不能把旧数据擦成null。同步已成功但空课表仍有last_synced_at，复制链接可用，不虚构课程。
- [ ] 将首次卡片状态短文案改为「首次同步中…」「刚刚同步」「同步失败」；已有订阅保留原具体同步时间与错误详情。NEEDS_REAUTH保留现有可操作链接，不能只显示一个无效重试按钮；链接直达Auth绑定，修好回来使用同一订阅。
- [ ] 保留所有现有按钮/菜单处理器。不要复制预览中的demo()、copy()、replay()、notification ref或假链接。
- [ ] 手机仅补已确认的换行约束：Navbar内部flex-wrap与小屏间距，Dashboard起始留白随导航高度避让，卡片按钮原flex-wrap。不新建汉堡菜单或更换导航。390px时不横向溢出，键盘焦点能到达所有按钮。
- [ ] 运行完整前端测试与build，检查Dashboard diff只涉及上述范围。提交建议 `feat(schedule): integrate approved first-sync feedback into subscriptions`。
