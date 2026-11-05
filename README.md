# dsh-feishu-contact

[![npm](https://img.shields.io/npm/v/dsh-feishu-contact.svg)](https://www.npmjs.com/package/dsh-feishu-contact)
[![CI](https://github.com/levelio/dsh-feishu-contact/actions/workflows/ci.yml/badge.svg)](https://github.com/levelio/dsh-feishu-contact/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-feishu-contact.svg)](LICENSE)

DeepSeek Harness 插件：在输入框里用 `@` 提及飞书联系人和群聊，模型可以读对应会话、以你的身份回消息。

- `@` 菜单多一段「飞书」：最近 / 联系人 / 群组，支持**拼音与首字母**（`zs`、`zhangsan` 都能找到张三）
- 选中后插入原子引用 `@[张三](feishu:user/ou_…)`，模型拿到的是**身份**而不是昵称
- 三个工具：`feishu_read_conversation`（读私聊/群）、`feishu_send_message`（以你本人身份发送）、`feishu_find_contact`
- 设置页里一键授权 + 后台自动续期，不依赖终端
- **自带一切**：插件不含任何人的联系人、不含任何应用凭据，也不读取其他工具的授权

## 前置条件

- DSH `>= 0.2.1-rc.2`（Web / Desktop 均可）
- 一个**你自己的**飞书自建应用（下面三步，约 5 分钟）

插件不内置应用凭据——飞书的 `user_access_token` 必须由你自己的企业应用签发，所以每个使用者都要建一个自己的应用。

## 1. 创建飞书应用

1. 打开[飞书开放平台](https://open.feishu.cn/) → 开发者后台 → **创建企业自建应用**
2. **安全设置 → 重定向 URL**，加入（端口要和你配置里的 `redirectPort` 一致，默认 3000）：

   ```
   http://localhost:3000/callback
   ```

3. **权限管理**，开通：
   - `im:message`（以用户身份发送消息）
   - `im:message:readonly`（读取会话消息）
   - `search:user`（按姓名/拼音搜同事，可选）
4. **凭证与基础信息** 里记下 `App ID` 和 `App Secret`

## 2. 安装

包已发布到 npm：[`dsh-feishu-contact`](https://www.npmjs.com/package/dsh-feishu-contact)。

### 桌面 App（最常见）

1. 侧边栏 → **插件**
2. 点 **添加插件**（或右侧箭头 → **安装第三方插件**）
3. 输入包名 `dsh-feishu-contact`，按 **安装**
4. 装完点 **立即启用**，或回到插件列表把开关打开

安装源默认自动选择 npm 官方源或国内镜像，失败可以手动切换。也支持 Git 地址、本地绝对路径和 tarball 链接。

### 命令行 / 自建 Web 实例

```bash
dsh plugin add dsh-feishu-contact            # 默认 profile
dsh plugin --profile <name> add dsh-feishu-contact
```

安装后重启该实例。注意桌面 App 的 profile 由 App 托管，CLI 会拒绝写入，只能用上面的界面安装。

### 版本要求

- DeepSeek Harness ≥ 0.2.1-rc.2（peer dependency）
- Node.js ≥ 22

### 升级

非官方插件没有独立的「更新」按钮：先在插件页**卸载**，再用新版本号重新安装。

```bash
dsh plugin add dsh-feishu-contact@0.1.1
```

## 3. 授权

1. 插件页点开**飞书联系人**卡片
2. 在「应用配置」填 **App ID** / **App Secret**，点 **保存**（写入 `~/.dsh/feishu-contact/settings.json`，0600，即时生效，不重启）
3. 点 **授权**，浏览器打开飞书授权页并同意
4. 回调 `http://localhost:3000/callback` 后自动保存 token，卡片状态变绿

已保存的 App Secret 只显示 `abc*******` 形式；不重新输入就不会覆盖。

点 **测试连接** 会拉一次真实数据，回显「N 个群 / M 位联系人」。

## 使用

```
帮我给 @张三 讲一下接口调用……      → feishu_send_message
@张三 问我了一些问题，你帮我看一下    → feishu_read_conversation
```

发送形式可以在对话里临时指定，优先于默认值：

```
给 @张三 发「你好」，用飞书卡片      → 即使默认是纯文本，这条也走卡片
给 @张三 发「你好」，用纯文本        → 即使默认是卡片，这条也走文本
```

设置页（插件详情）里的「消息设置」可改默认形式，保存即时生效（写入插件自己的 `settings.json`，不触发 profile 重组）。消息不带任何脚注。

`@` 菜单的行为：

- **空 query** 是一份点名板：最近 ≤6 → 联系人 ≤12 → 群组 ≤5，总计 ≤25 行，不会铺开全部群组
- **有 query** 时本地过滤（姓名 / 拼音 / 首字母 / 英文名 / 群名），按匹配强度排序，每段 ≤8
- 本地无命中且 ≥2 字：停顿 250ms 后调一次 `search/v1/user`，避免每敲一个字打一次 API
- `@#接口` 只搜群组

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` | 空 | 飞书自建应用 App ID（必填） |
| `appSecret` | 空 | 飞书自建应用 App Secret（必填；写 profile 配置，UI 不可用时落到 `credentials.json`） |
| `redirectPort` | `3000` | OAuth 回调端口，必须与应用登记的重定向 URL 一致 |
| `tokenFile` | 空 | 留空 = `~/.dsh/feishu-contact/user-token.json` |
| `showChats` | `auto` | `auto` = 能列出群才显示；`on` / `off` 强制 |
| `messageFormat` | `card` | 卡片（markdown）或纯文本；设置页可直接切换 |
| `requireApproval` | `false` | 发送前要求确认 |
| `defaultLimit` | `30` | 读取消息默认条数 |
| `cacheTtlMs` | `600000` | 群列表缓存时长 |
| `autoRefresh` | `true` | 后台自动续期 |
| `contactsSeedFile` | 空 | 可选：首次启动从联系人 JSON 一次性导入（`{ people: [{ name, open_id }] }`） |

## 数据与边界

- 只读写自己的两个文件：授权文件、`~/.dsh/feishu-contact/state.json`（联系人 / 群 / 使用时间）。
- 不读取任何其他工具的配置或授权，不含任何人的联系人数据。
- 联系人靠群成员与搜索自动积累；也可以 `contactsSeedFile` 一次性导入。
- 读会话会把私聊内容送进当前模型的上下文——这是功能本身，请知悉。
- 不采集遥测。

## 已知限制

- 飞书没有「私聊会话列表」API：定位某人的私聊只能靠 `POST /im/v1/messages/search`，所以**从没跟某人有过消息往来时读不到历史**，要先发一条。
- 外部联系人官方搜不到，只能从群成员里找。
- **跨租户私聊发不出去**（飞书 230038），只能发到双方共同所在的群。
- 消息体里的 `@` 已脱敏成 `@_user_1` 占位符，必须靠 `mentions[]` 还原。
- 跨页顺序不稳定，读取后必须按 `create_time` 重新排序。
- App 关闭时后台刷新不跑；refresh token 7 天滚动，超过 7 天不开 App 需要重新授权。

## 本地调试验证

插件跑在两半里（host 在 Node 进程、client 在 GUI 页面），改完不重启看不到效果时，用独立实例直接验证 API：

```bash
./scripts/dev-env.sh start                        # 独立 profile 起一个实例，打印带 token 的 URL
./scripts/dev-env.sh rpc authStatus               # 直接调 RPC，看真实返回
./scripts/dev-env.sh rpc applySettings '{"messageFormat":"text"}'
./scripts/dev-env.sh rpc sendMessage '{"target":"feishu:user/ou_xxx","text":"hi"}'
./scripts/dev-env.sh log                          # 实例日志
./scripts/dev-env.sh stop
```

实例在 `~/.dsh/profiles/feishu-dev`，用自己的 state/token/settings 文件，**不会碰桌面 profile 的真实数据**。RPC 报错会原样返回（比如 `gateway/arguments-invalid`），不用再去猜。

## 开发

```bash
npm install
node build.mjs        # tsc → lib/host，esbuild → lib/client.js，并把 pinyin-pro 内联进 lib/host/pinyin.js
node --test "test/*.test.mjs"
```

host 不打包（逐文件 ESM，堆栈可读），client 打包成 `window.__ModuleLoader__.load({ id, factory })` 形态。

### 热更新

- **配置改动**（设置页里的 App ID / 开关）：保存即生效，不用重启也不用 build。
- **代码改动**：`link:` 安装的插件，文件变化会在**下一次 profile 重组**时被替换。默认 `root: []` 只监听配置文件，所以改完代码有两种让它生效的方式：
  1. 去 Plugins 页把插件关一下再开（或改一下 profile patch 保存），触发重组；
  2. 打开源码监听，之后每次 `node build.mjs` 自动热替换：

     ```yaml
     - id: hmr
       disabled: false
       config:
         root: ["/绝对路径/到/contact-feishu"]
     ```

  热替换失败会停掉旧插件并报告 `failed` 与加载错误，不会静默留下半截状态。
