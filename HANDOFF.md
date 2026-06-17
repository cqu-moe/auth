# Handoff — CQU 取票根因实测终结 + 修复已设计待实现

> 2026-06-18 修订。**本文取代之前所有版本**(旧版"瑞数挡 httpx、跟 IP 无关、推荐常驻热浏览器"的定性已被本会话逐一实测推翻)。
> 项目记忆:`~/.claude/projects/-Users-uu-Documents-Coding-cqu-moe-auth/memory/project_cqu_login_cn_node_proxy.md`。

## 一句话

取票反复 `409 SESSION_EXPIRED` 的真凶 = **取票从任何服务器 IP 都触发 CQU 前置瑞数(Riverdata)的 JS 挑战,只有"水化了完整浏览器状态(跑过瑞数 JS)的真浏览器"能换 ST**。`httpx`(及伪装指纹的 `curl_cffi`)在服务器 IP 上全挂。**根因诊断完成,修复已设计 + 出 TDD 计划,待实现。**

## 实测证据(本机家用住宅 IPv4 + 成都节点 `1.14.106.150`,2026-06-17)

| 取票出口 \ 客户端 | 裸 httpx | curl_cffi 指纹 | 临时浏览器·塞3cookie | 满状态/水化浏览器 |
|---|:--:|:--:|:--:|:--:|
| 家用住宅(本机) | ✅ | ✅ | — | ✅ |
| 成都 IDC 直连 | ❌ | ❌ | ❌(T2/E1/E2) | ✅(登录ST/C)·**完整state水化✅(R1/R2)** |
| 青果住宅 同IP(N3,login==ticket) | ❌ | ❌ | — | ✅(登录ST) |
| 青果住宅 异IP(N2,=生产态) | ❌ | — | — | — |

钉死的三点:
1. **瑞数挑战只在坏 IP 触发**:住宅 IP 不挑战(裸 httpx 直接过);**IDC + 青果住宅 IP 都被挑战**。拦截轴是 IP 类别,不是换IP/IP错配/定点过期。
2. **拦的是 JS 现算的 `CtLgrmkSWHBZP` 令牌**:curl_cffi 真 chrome TLS+H2+头、甚至先拿服务端 `CtLgrmkSWHBZO`,照样挂 → 指纹不是门。
3. **不需要常驻热浏览器**:只塞 3 cookie 的新浏览器也挂(E1/E2);**水化完整 `storage_state`(12 cookie 含两个 `CtLgrmkSWHBZ*` + 2 origin localStorage)的全新浏览器能取票(R1/R2)** → 临时浏览器即可。
4. **青果该砍**:取票帮不上(同 IP N3 也挂)+ 登录抽风弹 captcha(125.85.80.60 弹 / 183.227.188.15 不弹)。成都 IDC 直连登录干净。

## 修复(已设计 + 出计划)

取票/keepalive 改 **"临时浏览器水化完整 storage_state → navigate 换 ST"**;**砍青果**直连 IDC;DO `SessionState.cookies`(3 cookie,存 DO storage)升级为 `storageState`(完整 state),`/run` 返回完整 state、keepalive 回写刷新。4G 节点实测取票并发上限 3。取票四道闸/VPC/2FA/熔断退避/caps/前端全不动。

- **设计**:`docs/plans/2026-06-17-cqu-browser-ticket-rehydration-design.md`
- **TDD 计划(6 阶段)**:`docs/plans/2026-06-17-cqu-browser-ticket-rehydration-plan.md`
- 分支 `feat/cqu-login-cn-node-proxy`(设计+计划已提交)。

## 下一步

按计划实现(subagent-driven / executing-plans)。Phase 0 先 `QG_ENABLED=0` 直连冒烟,P1-4 节点(浏览器取票/keepalive),P5 DO 改 storageState,P6 灰度+清理。

## 风险/未决

1. **状态保鲜**:state 扛过 60min keepalive 间隔未实测;用户据本地体感判 OK,**上线看日志、持续失败再切回 httpx**(计划留回滚开关)。
2. **第二把火**:2FA 邮件常 570s 内不到 → `run timeout 504`,2FA 捕获链不稳(本会话未解,另立)。
3. 临时 chromium 反复起关的长跑稳定性(僵尸/泄漏)→ 上线观测。

## 节点测试脚手架(本会话用过,可复用)

- 节点 `ubuntu@1.14.106.150`(成都,user `cqulogin`,代码 `/opt/cqu-login/app`,venv + chromium-1223 + 已装 curl_cffi)。
- 脱 ssh 跑长任务:`sudo systemd-run --unit=<n> --uid=cqulogin --gid=cqulogin --setenv=HOME=/opt/cqu-login --collect /opt/cqu-login/venv/bin/python <脚本>`;读 `sudo journalctl -u <n> -o cat`。需青果时套 `op run --environment qdsesjggqeyuhw2jziiojbxoey --`(EnvironmentFile=/etc/cqu-login/op.env)。
- 机密只经文件 stdin、读后即删,**绝不进 chat/repo/argv**。
- ⚠️ **测试账号密码本会话在对话里出现过,建议轮换。**
