# 设计说明

> 目标：在 DSH 输入框里 `@` 出飞书联系人和群聊，选中后模型既能「给 TA 发消息」，也能「读 TA 和我的私聊」。
>
> 这个插件装在**任意** DSH 环境里都能工作：不含任何人的联系人数据，不含任何应用凭据，不读取其他工具的授权。

---

## 1. 为什么是这个方案

`@` 菜单有官方的扩展点，不需要 hack 输入框：

| 能力 | 包 / 契约 | 关键 API |
|---|---|---|
| `@` 菜单源 | `@deepseek-ai/dsh-client-ui-input-trigger` | `ctx.inputTriggers.registerSource({ trigger:'@', name, candidates, onPick, codec, … })` |
| 现成范本 | `@deepseek-ai/dsh-client-ui-reference` | `@文件` + `@会话` 就是这么做出来的（client bundle 可读） |
| 插入原子 chip | `ReferenceInsert` | `{ source, ref, label, appearance:'session'\|'file'\|'folder', clipboardText }` |
| 模型侧序列化 | `ReferenceCodec` | `serialize(ref, signal)` 决定模型看到的文本；抛错即阻止发送 |
| host ↔ client | `connection.rpc.call('/api', '<ns>/<method>', { args }, signal)` | 返回 `{ ok, value }`，args 按**参数名**传 |
| 模型工具 | `@deepseek-ai/dsh-tools` | `ctx.tools.register(defineTool({ … }))` |
| 系统提示 | `@deepseek-ai/dsh-system-prompt` | `agent.ctx.inject(['systemPrompt','tools'], …)` + `scope.systemPrompt.section()` |

被否决的路线：直接让模型调 MCP —— user 模式下 `im.v1.message.create/list` 是 tenant-only，会被 tools/list 过滤；bot 身份又发不出「我本人」的消息。

## 2. 架构

```
Web 前端 (client bundle)                Host 进程 (host bundle)
─────────────────────────               ──────────────────────────
@ source "feishu"                       FeishuContactService (Remote)
  ├─ candidates(query) ──── RPC ─────►    ├─ candidates / searchCandidates
  ├─ onPick → 插入 chip                   ├─ authStatus / authorize / probe
  └─ codec.serialize                      └─ validate
                                           FeishuApi（群列表 / 成员 / 历史 / 搜索 / 发送）
对话转录里的 chip 渲染                     Tools（read / send / find）
                                           System prompt section
~/.dsh/feishu-contact/user-token.json（0600）
~/.dsh/feishu-contact/state.json（联系人·群·使用时间）
```

要点：

- **token 不进浏览器**：所有飞书 REST 调用在 host 进程，client 只拿脱敏候选。
- **每个安装自带应用凭据**：`appId` / `appSecret` 在设置页填写；插件不内置、不借用。
- **零外部读取**：只读写上面两个自有文件。

## 3. 菜单规则

- 空 query 是点名板：最近 ≤6 → 联系人 ≤12 → 群组 ≤5，总计 ≤25 行。
- 有 query：姓名 / 拼音全拼 / 首字母 / 英文名 / 群名匹配，按强度排序（字面 > 首字母 > 全拼 > 模糊），每段 ≤8。
  - 拼音由 `pinyin-pro` 在**构建期**打进 `lib/host/pinyin.js`，运行时零依赖；~460 个名字首次转换约 12ms，之后每次按键 1~2ms。
- 本地无命中且 ≥2 字：停顿 250ms 后调一次 `search/v1/user`。
- `#` 前缀只搜群组。
- 群组段在列表为空或拉取失败时整段消失，联系人不受影响。

## 4. 引用格式

| 类型 | 序列化 |
|---|---|
| 私聊 | `@[张三](feishu:user/ou_…)` |
| 群聊 | `@[项目对接群](feishu:chat/oc_…)` |

姓名只是显示标签，URI 才是身份；模型据此调用工具，工具接受引用串、裸 id 或唯一姓名。

## 5. 授权与 token

- 设置页填 `appId` / `appSecret` → 「授权」→ 浏览器 OAuth v3（`scope=offline_access`，少了拿不到 refresh_token）→ 回调 `http://localhost:<redirectPort>/callback` → 原子写盘 0600。
- 续期：启动检查一次，之后每 10 分钟检查、离过期 < 20 分钟就刷；API 返回 `99991677` 立即单飞刷新后重试一次。
- **单飞 + 文件锁**：飞书 refresh_token 用一次就失效，两个写者同时刷新必然丢一个。刷新前拿 `O_EXCL` 锁、拿到锁后**先重读**再决定是否真的刷新。
- `redirectPort` 必须与应用后台登记的重定向 URL 一致，所以端口不能随便改。

## 6. 踩过的坑（都已由测试守着）

1. **`ctx.remote.<ns>` 对第三方插件不存在**。它只由 `dsh-api-remotes` 为 app 自己的 API 生成；插件用 `TypertRemoteService` 注册的命名空间不会挂上去。写进 client 插件的 `inject` 会让依赖永远不满足，**整个 UI 起不来**。
   → 正确姿势：`ctx.get('connection').rpc.call('/api', '<ns>/<method>', { args: { <参数名>: … } }, signal)`。
2. **`output.schema` 不是 JSON Schema，而是 value-schema DSL**。必填要写成属性级 `required: true`，根对象要显式声明 `additionalProperties`。写 `required: [...]` 会在注册期抛 `UNSUPPORTED_SCHEMA`；而注册在同一个 `ctx.inject` 回调里，**三个工具会一起消失**，模型只能自己用 bash 摸接口。
   → `test/tools.test.mjs` 直接调用真实 `defineTool` 校验；注册回调加 try/catch 与启动日志。
3. **跨租户私聊发不出去**（230038）。必须映射成可执行的提示（改发共同群），否则模型会去搜文档。
4. **消息体里的 `@` 已脱敏**成 `@_user_1`，要用 `mentions[]` 还原；跨页顺序不稳定，读后必须按 `create_time` 重排。

## 7. 已知限制

- 飞书没有「私聊会话列表」API：定位私聊只能靠 `POST /im/v1/messages/search`，没聊过就读不到历史。
- 外部联系人官方搜不到，只能从群成员里找。
- App 关闭时后台刷新不跑；refresh token 7 天滚动。
- 「最近联系人」没有官方数据源，靠本地使用记录 + 联系人列表排序近似。
