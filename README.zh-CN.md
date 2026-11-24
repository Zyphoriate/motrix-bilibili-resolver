# Motrix Bilibili Resolver

面向 Motrix 2.x 的哔哩哔哩视频链接解析插件，原始 ID 保持为 `community.bilibili-resolver`。

参考：[官方插件示例](https://github.com/motrixapp/builtin-plugins)、[官方 SDK](https://github.com/motrixapp/plugin-sdk)。

源码仓库：[Zyphoriate/motrix-bilibili-resolver](https://github.com/Zyphoriate/motrix-bilibili-resolver)。[English](README.md) · [Build 构建与下载](https://github.com/Zyphoriate/motrix-bilibili-resolver/actions/workflows/build.yml)。

配套 [Motrix fork](https://github.com/Zyphoriate/motrix) 已接入媒体选择和合并任务创建。下文关于原版 Motrix 2.4.5 的限制针对原版宿主；已完成接线的宿主可以使用公共媒体协议。

## 1.3.7 修复

- 在插件设置的“首选清晰度”下拉框增加“最高”，并设为默认；已保存的具体清晰度继续保留。最高请求 QN 127 和 DASH 能力标记，按接口实际返回的分辨率选择最佳流，包含 8K 和未来更高分辨率，选择阶段没有 QN 或分辨率上限。
- 同一插件设置面板增加“单 P 视频显示选择弹窗”，默认关闭。兼容宿主关闭时按首选直接下载单 P，开启后先选清晰度；多 P 始终弹窗。
- 媒体预览和公共解析全程保留 `highest`，同时保留五个具体档位。需配套支持 `2.3.0-media.3` 协议的新宿主；旧宿主会校验失败，须一起升级。

### 保留 1.3.5 的标题命名修复

- 下载文件按视频标题命名：单 P 为 `视频标题.mp4`，多 P 为 `视频标题 - P2 分P标题.mp4`。
- 将文件名存入任务元数据，在 `beforeFinalize` 设置最终发布名称，声明必需的 `metadata` 权限。Motrix 2.4.5 会忽略 `beforeCreate.filename` 的结果，因此不依赖该字段。
- 长标题截断时保留 P 编号和分 P 名称，避免多个 P 被截成相同文件名。
- 添加入口测试，验证 `?p=2` 确实请求第二 P 的 CID，并设置对应标题。
- 修正文档：公共解析命令的 DASH 支持不等于 Web/NAS 新建任务已经支持 DASH。

## 媒体选择协议

兼容宿主可以公开调用 `community.bilibili-resolver.inspectMedia`，参数为 `{url}`，在创建下载前列出全部分 P。v1 结果包含稳定 CID id、`P<N>` 标题、规范 `?p=N` 链接、时长、`highest`／`2160p`／`1440p`／`1080p`／`720p`／`480p` 选项，以及首选设置对应的默认值（默认 `highest`）。检查只读元数据，不请求媒体流；超过 500 条时明确报错。

每个选中条目分别调用现有 `.resolve`，参数为 `{url: entry.url, quality, cookies?}`。它返回一组所选画质的 DASH 视频／音频（不可用时允许较低画质回退），标题保留分 P。宿主负责创建任务和合并。插件首选设置默认“最高”，预览和单文件 hook 均使用该偏好并按实际流回退。manifest 同时声明 `post-action` 分类以支持 `beforeFinalize` 标题处理；插件 ID 保持不变。

## 安装

安装 `dist/community.bilibili-resolver-1.3.7.moext`，确认 `http` 和 `metadata` 权限。后者用于持久化任务的标题文件名，确保服务端重启后仍能在下载完成时按标题命名。插件通过 `beforeFinalize` 设置最终路径，由宿主处理实际重命名和同名冲突，不直接写入媒体文件。

清单目标版本为 Motrix `>=2.0.0 <3.0.0`；媒体预览和解析需支持 `highest`（`2.3.0-media.3` 协议）的新配套宿主。仅支持五档清晰度的旧宿主会校验失败，宿主和插件须配对升级。“最高”选项标签和单 P 开关需要支持插件选项标签本地化及媒体偏好的宿主。升级保留原 ID 和现有设置。新任务下载过程中可能仍显示 CDN 文件名，完成后发布为标题文件名；升级前创建的任务没有标题元数据，不会自动重命名。

## 清晰度与入口区别

| 入口 | 当前行为 |
| --- | --- |
| Motrix 2.4.5 Web/NAS 新建任务 | 调用 `beforeCreate`，下载音视频合一的 MP4；匿名接口通常最高 720P |
| 接入公共解析命令的宿主 mux 入口 | 命令返回 DASH 视频和音频，宿主负责下载与 FFmpeg 合并；可尝试匿名 1080P |

默认首选清晰度为“最高”（`highest`），请求 QN 127，按实际 DASH 分辨率选择，没有 QN 或分辨率上限。已保存的 `720p` 等具体档位继续作为上限。旧版单文件 hook 从 QN 127 开始逐级回退，保持无 mux 行为，并不承诺获得 8K。单文件 MP4 的可用画质仍取决于接口，DASH 高清需要宿主合并支持。

yt-dlp 的匿名 1080P 使用 `try_look=1` 获取 DASH 分轨，再通过 FFmpeg 合并。本插件的公共命令也实现了这一步解析，但 **Motrix 2.4.5 Web/NAS 新建任务没有调用该命令和 mux pipeline**。在 Web 里安装 FFmpeg、填写 Cookie 或选择 1080P，都不等于补齐这条宿主调用链。

要让 Web/NAS 同样支持高清合并，需要宿主把公共解析命令接入新建任务，并交给现有媒体任务协调器管理下载、合并、取消和恢复。1.3.7 没有声称修复这一宿主限制。

### 4K / 2K 请求语义

`2160p` 请求 Bilibili QN 120，并携带 `fourk=1` 和 DASH 能力标记。`1440p` 同样请求该流列表，然后按视频宽高中较短边筛选，选择不超过 1440 像素的最高可用 DASH 流（兼容竖屏）。Bilibili 没有独立 1440p QN：112 表示 **1080P+**，116 表示 **1080P60**，两者都不是 2K。缺少真实 1440p 流时回退至 1080p 或更低档，不会把 1080P+ 标成 2K。已知 QN 127 缺少尺寸时按 4320p，QN 120 按 2160p；未知 QN 缺少尺寸时排在已知尺寸之后。依次比较短边分辨率、QN、AVC 兼容性、带宽和 URL 顺序；排除无效 HTTP(S) 流链接。

实际 4K/2K 可用性取决于视频、账号权益、Cookie 和接口返回；插件不进行升频。DASH 合并要求宿主接线并具备 FFmpeg。协议参考：[Bilibili 播放 QN 表](https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/video/videostream_url.md)。

## 分 P

支持 BV、av、b23.tv 短链和 `?p=N` 指定分 P，例如：

```text
https://www.bilibili.com/video/BV17Yy3zxE9F/?p=1
https://www.bilibili.com/video/BV17Yy3zxE9F/?p=2
```

原版宿主的 `beforeCreate` hook 路径中，每条链接创建一个对应 P 的任务；不带 `p` 时默认第一 P。该路径不自动展开全部 P。

配套 Motrix fork 会调用 `inspectMedia` 打开分 P 选择列表，再为每个选中的 P 分别创建媒体任务。Motrix 的 `ctx.update({ uris })` 中多个 URI 仍表示同一文件的镜像，不是多个视频。插件 SDK 没有创建子下载任务的接口，列表展开和调度由接入媒体协议的宿主完成；使用仅调用 hook 的原版宿主时，可把每 P 的页面链接分别加入任务列表。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 创建任务时解析受支持的链接 |
| 首选清晰度 | 最高（`highest`） | 最高 / `2160p` / `1440p` / `1080p` / `720p` / `480p`；实际清晰度受接口和宿主下载路径限制 |
| 单 P 视频显示选择弹窗 | 关 | 开启后先选清晰度；关闭后按首选直接下载；多 P 始终弹窗，需要兼容宿主支持 |
| 登录 Cookie | 空 | 可选 SESSDATA 或完整 Cookie，仅由解析器发往 Bilibili API；不保证单文件接口达到 1080P |

解析器给媒体请求添加 Referer 和 User-Agent，并优先选择稳定的 upos CDN 镜像。支持 WBI 签名、接口缓存和 412/429/5xx 退避重试。

## 排错与旧版本熔断状态

正常任务日志应出现：

```text
bilibili: beforeCreate hook invoked
bilibili: beforeCreate matched a Bilibili URL
bilibili: resolved video link ... filename=视频标题.mp4
HTTP task: beforeCreate.output ...
HTTP task: engine.dispatch ...
bilibili: final filename selected filename=视频标题.mp4
```

旧版本失败可能触发两种状态：

1. SQLite 中的插件禁用状态。
2. 服务端进程内的 hook 熔断状态。升级插件、重新启用插件或回收 worker 都不会重建该熔断器。

若日志显示 `hasOrchestrator:true`、调用链包含本插件，却在同一毫秒返回原 URL 且没有 hook 执行日志，请检查用户数据目录中的 `plugin-audit/hooks.ndjson` 是否有 `chain.skip` / `breaker_open`。重启 Motrix 服务端进程可以清除内存熔断状态；Web 页面刷新不能清除它。

Docker Compose 服务名为 `server` 时：

```bash
docker compose restart server
```

如仍处于持久化禁用状态，先停止 Motrix，再使用源码中的脚本修复原 ID；脚本会先备份数据库：

```bash
node scripts/reset-plugin-state.mjs --inspect
node scripts/reset-plugin-state.mjs --db "/path/to/motrix.db"
```

脚本清理 SQLite 中的对应状态，不能清除另一个仍运行的 Motrix 进程内存。

`shutting down resolver` 也会由默认 5 分钟空闲回收触发，本身不能说明插件被禁用。插件会捕获自身的解析错误；宿主在 hook 返回后执行的权限或补丁校验错误仍可能触发熔断，因此必须授权清单中请求的权限。

## 开发与验证

```bash
npm ci
npm test
npm run typecheck
npm run live-check
```

单元测试、mock host 和打包烟雾测试不能代替真实 Web/NAS 端到端验证。1.3.7 增加清晰度偏好和单 P 弹窗设置；兼容宿主负责设置渲染、弹窗、调度和合并任务。

不支持番剧、直播、课程、付费或 DRM 内容。Bilibili 接口及可用清晰度可能变化。

### 独立仓库与可复现 Build

推荐 Node.js 24 LTS，最低 22.16，使用 npm；真实扩展包烟雾检查需要 `unzip`。在仓库根目录执行上述本地测试和类型检查命令。build、validate、lint、pack 和真实归档烟雾检查交给 GitHub Actions，最终构建产物从 Actions 获取。`vendor/sdk` 已包含 SDK API、CLI 和 manifest-schema tarball，锁文件记录完整性；构建不依赖相邻源码目录、全局 Motrix CLI 或 npm 发布。SDK 为配套 fork 的 `2.3.0-media.3` 媒体协议版本，上游 SDK 使用 MIT，归档内保留许可证。

**Build** 工作流支持 push、PR 和手动触发，顺序执行 `npm ci`、类型检查、单 worker 测试、validate、build、lint、pack 和打包烟雾检查，Node 内存上限为 1536 MiB。在成功运行页面的 **Artifacts** 下载 `bilibili-resolver-1.3.7-<commit>`，解压后包含 `community.bilibili-resolver-1.3.7.moext` 和 `SHA256SUMS`；在解压目录执行 `sha256sum -c SHA256SUMS`，再将 `.moext` 导入 Motrix。下载 GitHub artifact 可能要求登录。Build 不向 npm 发布，也不创建 release tag。live-check 是可选联网检查，不纳入 CI。

## License

MIT。本插件与哔哩哔哩官方无关。
