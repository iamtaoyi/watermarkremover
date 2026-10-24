# watermarkremover · 全自动视频去水印 / 去字幕

给公司内部员工用的 Web 网站：**输入 Token 登录 → 上传带字幕的视频 → 调用去字幕接口 → 在线预览 → 下载无字幕视频**。

Node.js 无第三方包依赖；服务端计费时长校验需要系统安装 `ffprobe`（FFmpeg 提供，可用 `FFPROBE_PATH` 指定可执行文件）。安装后运行 `node server.mjs`。

当前版本使用手机号/密码登录、积分计费和批次任务；下文部分 Token 示例属于历史版本。修复说明与验证方式见 [可靠性修复说明](docs/reliability-fixes.md)。

**去字幕只走指定的接口**（火山引擎 mediakit `erase-video-subtitle-pro`），代码里没有任何本地替代实现，也不会静默降级成「假装处理」；接口没配好时提交任务会被直接拒绝并说明缺什么。

---

## 1. 核心链路

```
① 浏览器上传视频
      ├─ 本地算 MD5（Web Worker 分片，边读边算）
      ├─ 先问服务端「有没有这个 MD5」→ 有就秒传，一个字节都不传
      └─ 没有才真的上传：落盘名 = <md5><ext>，同时算出 sha256
② 服务端给文件生成唯一 ID（vf_xxx）与公网 URL（/f/vf_xxx，支持 Range，可匿名拉取）
③ 提交去字幕任务：POST {去字幕接口}{ video_url, mode:"Subtitle" } → 拿到 task_id
④ 前端按 task_id 轮询进度，页面显示阶段 + 百分比
⑤ 接口返回产物地址 → 服务端把产物回传到本地
⑥ 页面预览源视频与无字幕视频，产物可下载
⑦ 上传文件 12 小时后过期：删除文件 + 移除 MD5 索引 + 清理派生产物
```

---

## 2. 去字幕接口（必须走这个接口）

| 项目 | 值 |
| --- | --- |
| 提交 | `POST {AMK_API_BASE}{AMK_TOOL_PATH}`，body `{ "video_url": "<公网可访问的视频地址>", "mode": "Subtitle" }` |
| 默认地址 | `https://mediakit.cn-beijing.volces.com/api/v1/tools/erase-video-subtitle-pro` |
| 鉴权 | `Authorization: Bearer <AMK_API_KEY>`（`AMK_AUTH_HEADER=amk-api-key` 可改用该 Header 名） |
| 轮询 | `GET {AMK_API_BASE}/tasks/{task_id}` → `processing` / `succeeded` / `failed` |
| 成功产物 | 响应里的 `video_url` / `output_url` / `url` / `result_url` / `file_url`（服务端会逐个尝试） |
| 失败 | 响应里的 `error.code` / `error.message`；`UrlDownloadFail` / `DownloadFileError` 会被翻译成「接口拉不到你的源视频，请确认 PUBLIC_BASE_URL」 |

两个硬性前提：

1. **`AMK_API_KEY`**：去字幕接口的密钥。
2. **`PUBLIC_BASE_URL`**：接口在公网侧，必须能**匿名 HEAD/GET** 到 `PUBLIC_BASE_URL/f/<fileId>`。同局域网的内网 IP 对云端不可达，需要反向代理域名或隧道（例如 `cloudflared tunnel --url http://127.0.0.1:8787`）。

缺任何一个，`POST /api/files/:id/process` 会返回 `503` 并列出缺失项，前端直接显示原因。

---

## 3. 运行

> 要部署到阿里云（公网地址 + systemd + Nginx + HTTPS/备案），见 **[deploy/ALIYUN.md](deploy/ALIYUN.md)**，一条命令完成安装：
> `sudo ACCESS_TOKEN='你的口令' ./deploy/install.sh`


```bash
cd clipflow
npm start                 # 等价于 node server.mjs
# 打开 http://127.0.0.1:8787
```

启动日志会打印：登录 Token、会话到期时间、去字幕接口地址与配置是否完整。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AMK_API_KEY` | 空 | 去字幕接口密钥（必填，否则无法提交任务） |
| `PUBLIC_BASE_URL` | 空 | 对外基址（必填，接口要能匿名拉取源文件） |
| `AMK_API_BASE` | `https://mediakit.cn-beijing.volces.com/api/v1` | 接口基址 |
| `AMK_TOOL_PATH` | `/tools/erase-video-subtitle-pro` | 去字幕工具路径 |
| `AMK_AUTH_HEADER` | `bearer` | 设为 `amk-api-key` 时改用该 Header 名鉴权 |
| `AMK_POLL_MS` | `3000` | 轮询间隔 |
| `AMK_TIMEOUT_MS` | `1800000` | 任务总超时（30 分钟） |
| `AMK_DOWNLOAD_TIMEOUT_MS` | `600000` | 回传产物的超时 |
| `ACCESS_TOKEN` | 自动生成 | 登录口令；不配则生成随机值并写入 `data/access-token.txt` |
| `SESSION_END_MINUTE` | `1439`（23:59） | 会话每日失效的分钟点 |
| `LOGIN_MAX_FAILS` / `LOGIN_WINDOW_MS` | `10` / `600000` | 同 IP 失败次数上限与统计窗口（超出返回 429） |
| `UPLOAD_TTL_HOURS` | `12` | 源文件与产物的存活小时数 |
| `SWEEP_INTERVAL_MS` | `300000` | 过期扫描间隔（启动时也会扫一次） |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `MAX_UPLOAD_BYTES` | `104857600` | 单文件上限（100 MB） |
| `MAX_BATCH_SIZE` | `30` | 一批最多多少个文件 |
| `PROCESS_CONCURRENCY` | `2` | 同时处理的任务数 |
| `DATA_DIR` | `./data` | 上传、产物、Token、`db.json` 的存放目录 |

---

## 4. 登录与会话

- 登录页只输一个 Token，服务端比对 `sha256(输入)` 与 `sha256(ACCESS_TOKEN)`（常量时间比较），成功后签发 HttpOnly 会话 Cookie，前端不存任何凭证。
- **会话保持**：刷新 / 重开页面自动恢复，无需重复输入。
- **每天 23:59:59 失效**：会话记录的 `expiresAt` 就是当天 23:59:59，服务端每次请求都校验，跨天后必须重新登录；前端顶栏实时显示「会话剩余」，归零自动回到登录页。
- 同 IP 10 分钟内失败 10 次返回 429，避免 Token 被暴力枚举。

---

## 5. 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | 公开 | `{ token }` → 200 + 会话 Cookie（失败 401，频繁失败 429） |
| `GET` | `/api/auth/session` | 公开 | `{ authenticated, expiresAt }` |
| `POST` | `/api/auth/logout` | 公开 | 注销并清 Cookie |
| `GET` | `/api/config` | 登录 | 对外基址、上限、处理类型、阶段、TTL、会话策略 |
| `POST` | `/api/uploads/precheck` | 登录 | 秒传预检 `{ md5, name? }` → `{ exists, file?, savedBytes }` |
| `POST` | `/api/uploads` | 登录 | 原始字节流上传；`X-File-Name`、`X-File-MD5`（可选）→ `{ file, deduped, md5 }` |
| `GET&#124;HEAD` | `/f/vf_xxx` | **公开** | 能力 URL：匿名可拉取（去字幕接口就是拉这里），支持 Range |
| `POST` | `/api/files/:fileId/process` | 登录 | 提交去字幕任务 → `202 { task, poll }`；未配好接口 → `503` |
| `GET` | `/api/tasks/:taskId` | 登录 | **轮询接口**（`status progress stage stageKey`） |
| `DELETE` | `/api/tasks/:taskId` | 登录 | 取消排队中/处理中的任务 |
| `GET` | `/api/artifacts/:taskId/video`、`…/poster.svg` | 登录 | 产物预览（视频支持 Range） |
| `GET` | `/api/download/:taskId` | 登录 | 下载无字幕视频（`attachment`；过期任务 410） |

```bash
TOKEN=内部口令; B=http://127.0.0.1:8787
curl -s -c jar.txt -X POST $B/api/auth/login -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}"
curl -s -b jar.txt -X POST $B/api/uploads -H 'X-File-Name: clip.mp4' --data-binary @clip.mp4
curl -s -b jar.txt -X POST $B/api/files/vf_xxx/process -H 'content-type: application/json' -d '{"operation":"erase-subtitle"}'
curl -s -b jar.txt $B/api/tasks/task_yyy
curl -s -b jar.txt -OJ $B/api/download/task_yyy
```

---

## 6. 上传与 MD5 秒传

MD5 只有读完整个文件才知道，所以「服务器已有同一文件就不上传」必须由客户端先算：

```
本地算 MD5 → POST /api/uploads/precheck → 命中：直接复用（0 字节） / 未命中：带着 MD5 上传
```

浏览器 WebCrypto 不支持 MD5，因此自带增量 MD5 实现（`public/md5.js`，RFC 1321），在 Worker（`public/md5-worker.js`）里按 8 MB 分片边读边算：主线程不卡、内存不随文件增长、可随时取消。

服务端三道关：

| 环节 | 行为 |
| --- | --- |
| 预检 | 命中 `md5Index` 且文件完好 → 复用；只把本次文件名记进 `names`，不接收字节；命中已过期文件则清索引并按未命中处理 |
| 上传 | 先写 `.incoming-*` 临时文件，边收边算 MD5 + SHA-256；收完才发现重复（并发兜底）就删临时文件复用旧记录；带 `X-File-MD5` 时必须与实算值一致，否则 400 并清理临时文件 |
| 存储 | 内容寻址：落盘名即 `<md5><ext>`，同一内容只存一份 |

> MD5 可构造碰撞，做同内容去重够用但不能当信任边界（服务端同时保存 `sha256`）。跨用户秒传还会暴露「服务器上是否存在该内容」，生产建议按租户隔离索引。

---

## 7. 12 小时过期与清理

到期扫描（启动时 + 每 5 分钟）：

```
├─ 删除 data/uploads/<md5><ext>
├─ 删除 db.files[id] 与 db.md5Index[md5]      ← 「去除 MD5 信息」
├─ 该文件派生的任务：状态置为 expired、清空 result 与下载/预览链接
├─ 删除 data/outputs/<taskId>/（无字幕视频与封面）
└─ 兜底：清理 .incoming-* 临时文件与无主产物目录
```

用户可见行为：文件卡片与结果卡片都有倒计时；到期后源文件 URL 变 404、下载/预览变 **410 Gone**、历史任务显示「已过期」并提示重新上传。

---

## 8. 预览与下载

- **源视频**：`<video controls>` 指向 `/f/<fileId>`（支持 Range，可拖进度条）；浏览器不支持的容器/编码会显示「无法在线预览，可下载后查看」而不是留黑屏。
- **产物**：按输出类型自动选择 `<video>` / `<audio>` / `<img>`；无字幕视频走 `/api/artifacts/<taskId>/video`，可拖进度条。
- **下载**：`下载无字幕视频` → `/api/download/<taskId>`（`Content-Disposition: attachment`，中文名用 RFC 5987 编码，支持断点续传）。

---

## 9. 视觉设计（灰白 + 柔和卡片）

底色沿用 DeepSeek Harness 浅色主题的中性阶，造型上采用「浅灰画布 + 无描边白卡 + 大圆角 + 柔和阴影」：

| 用途 | 值 |
| --- | --- |
| 画布 / 卡片 | `#f4f5f7` / `#ffffff`（内嵌浅底 `#f6f7f9`、`#fbfbfd`） |
| 文字 | 主 `#0f1115`、次 `#5b6068`、三级 `#8b9199`、最浅 `#aeb3ba` |
| 描边 | 只在必要处用 1px `#e7e9ed`；卡片靠阴影区分层次 |
| 主按钮 | 填充 `#0f1115`，hover `#26282e` |
| 唯一强调色 | `#4176e6`（可点击文字 / 选中态 / 链接） |
| 语义色 | 成功 `#22c55e`、警告 `#f59e0b`、错误 `#ec1313` |
| 圆角 | 卡片 24px、内层 16px、控件 12px、胶囊 999px |
| 阴影 | `0 2px 4px rgba(16,24,40,.03), 0 24px 48px -28px rgba(16,24,40,.20)` 等三档 |

页面结构是**网站**而不是应用面板：页头（品牌 + 会话剩余 + 退出）→ 居中 Hero（大标题 / 说明 / 三条要点）→ 步骤条 → 主流程卡片（上传 / 就绪 / 处理中 / 完成 / 失败）→ 页脚。内容居中 1128px。

## 10. 目录结构

```
clipflow/
├── server.mjs          # 登录会话 + 上传/秒传 + TTL 清理 + 任务队列 + 预览/下载 + Range
├── pipeline.mjs        # 去字幕接口调用：提交 / 轮询 / 回传产物、阶段与进度、封面
├── public/
│   ├── index.html      # 登录门 + 五张卡片（上传 / 就绪 / 处理中 / 完成 / 失败）
│   ├── styles.css      # 灰白设计系统
│   ├── app.js          # 鉴权 → 本地 MD5 → 秒传 → 上传 → 提交任务 → 轮询 → 预览下载
│   ├── md5.js          # 增量 MD5（RFC 1321）+ 分片读取
│   ├── md5-worker.js   # Worker 里分片算 MD5
│   └── favicon.svg
└── data/               # 运行时：uploads/ outputs/ db.json access-token.txt（已 gitignore）
```

---

## 11. 已知限制

- 单进程内存队列：进程重启后处于 `processing` 的任务需要重新提交。
- 取消任务只停止本地轮询并标记 canceled，不会撤销接口侧已提交的任务（上游通常也不支持取消）。
- 单一整文件上传，没有分片/断点续传：超大文件（>100 MB）会被拒绝。
- 会话按「当天 23:59」失效：23:58 登录只剩 1 分钟（可用 `SESSION_END_MINUTE` 调整）。
- 所有登录用户共用一个 Token，且共享同一份文件/MD5 索引空间，没有多租户隔离。

## 12. 上线前清单

1. `ACCESS_TOKEN` 用密码管理器下发，公网入口必须 HTTPS（HTTPS 下会话 Cookie 自动带 `Secure`）。
2. 网关层给登录、上传、提交任务分别限流；按人/按天限制上传量与并发。
3. 上传内容校验（`ffprobe` 容器/时长/分辨率）、病毒扫描与内容审核。
4. 反向代理：放开 `client_max_body_size`、`proxy_request_buffering off`（保持流式上传），保留 `Range` 透传（预览拖进度条依赖它）。
5. 日志里已有 `[auth] [ttl] [dedupe] [erase] [worker]` 前缀，可直接接入采集与告警（任务成功率、队列深度、清理结果）。
