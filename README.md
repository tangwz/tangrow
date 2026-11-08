# Tangrow

给现有 Obsidian 笔记库补充一个右侧工作台与原生 Bases。保留自己的目录、链接和笔记分类，用轻量入口完成捕获、收藏、写作、专注与习惯记录。

## 使用方式

| 工作区 | 日常用途 | 数据位置 |
| --- | --- | --- |
| Tools | 当前页操作、新建笔记、打开数据库、查看待办入口 | 原笔记和现有目录 |
| Capture | 快速记录想法，回看最近捕获 | 配置的 Inbox |
| Pins | 收藏当前笔记并快速返回 | 原笔记的 `tangrow_pin` 属性 |
| Studio | 保存临时写作，再转成草稿笔记 | 插件草稿缓存与配置的 Inbox |
| Focus | 开始、暂停、继续、结束专注 | 补充目录中的结构化记录 |
| Habits | 添加习惯、每日记录、查看近期连续情况 | 补充目录中的结构化记录 |

Bases 是查询视图，不是另一份笔记存储。笔记、近期修改、项目、领域、资源、Inbox、来源、捕获、收藏、草稿、专注、习惯和任务笔记分别有独立入口。现有没有属性的笔记也能通过路径、文件名和修改时间进入基础视图。正文复选框由侧栏单独索引，Bases 的任务视图只展示任务笔记，不能把每个正文复选框变成数据库行。

## 安装

要求 Obsidian 1.10.0 或更新版本，并开启核心插件 Bases。桌面构建需要 Node.js 22 或更新版本，以及 npm；打包脚本还需要系统 `zip`。

```sh
npm ci
npm run build
npm test
npm run install:vault -- --vault /absolute/path/to/vault --dry-run
npm run install:vault -- --vault /absolute/path/to/vault
```

随后在 Obsidian 的 Community plugins 中启用 Tangrow。也可以在安装命令后增加 `--enable`，将插件 ID 追加到现有启用列表；如果应用已经运行，重新加载应用后生效。安装器不修改受限模式，不自动批准其他插件。若安装期间启用列表被 Obsidian 修改，安装器会保留最新列表并停止启用步骤；此时运行文件已经安装，可在应用内启用 Tangrow 或重新运行安装命令。

安装器只写入 `.obsidian/plugins/tangrow/manifest.json`、`main.js` 和 `styles.css`，不会覆盖 `data.json`。替换已有文件或启用列表前，会将原文件备份到用户主目录的 `.local/state/tangrow/backups`。它不触碰现有 Markdown、目录分类或 `workspace.json`，并拒绝通过插件路径的符号链接写入。

首次使用时打开命令面板，执行 `Tangrow: Open companion`；在设置中核对路径，再执行 `Tangrow: Set up companion Bases`。这一步只新增补充目录和缺失的视图文件。默认位置为 `10-Life(Meta)/Tangrow`，普通新笔记仍进入 `00-Inbox`，项目仍进入 `20-Project`。可在插件设置中替换为自己已有的路径，无需重新组织目录。修改目录设置不会改写已有 Bases；如需调整旧视图，请手动修改其筛选条件，或选择新的补充目录后重新初始化。

## 数据约定

插件使用 `tangrow_` 前缀属性，避免与已有 `type`、`status`、`created`、`source` 等字段冲突。初始化不批量补齐属性，也不迁移旧笔记；收藏、封面和时间标记只在明确触发对应动作时修改当前页。

- 捕获、草稿和普通笔记遵循配置的 Inbox，项目遵循配置的项目目录。
- 专注和习惯是独立 Markdown 记录，可以在 Bases 中查看，也可以直接编辑。
- 临时写作和进行中的专注状态保存在插件 `data.json`。暂停不会累计工作时长；重启后的剩余时间以持久化状态恢复。
- 日记入口遵循配置的 Journal 路径与日期格式；已有日记会直接打开。
- 不发送笔记、统计或使用数据到外部服务，不需要账户或订阅。

原生主题、文件树定位与堆叠标签页没有完整公开的宿主接口；兼容适配器仅在运行时确认可用后调用，失败时提供原生操作指引，不直接写宿主私有配置。行宽由插件作用域样式控制，卸载后恢复。升级 Obsidian 后应复核这些宿主集成功能。

## 开发与验证

```sh
npm run dev
npm run typecheck
npm test
npm run build
npm run package
```

`npm run package` 生成 `dist/tangrow-0.1.0.zip`，包含运行文件、MIT 许可和第三方声明。`main.js`、依赖与发布包不提交到源码仓库。

安装后的人工验收：

1. 对照原库，确认顶层目录和原笔记路径保持不变，新增内容仅位于补充目录及插件目录。
2. 打开笔记与 Bases，切换六个工作区；空列表、无活动页、窄侧栏与深色模式都应可用。
3. 保存捕获、收藏当前页、转存草稿，确认进入原定目录并出现在对应数据库中。
4. 开始专注，暂停后等待，确认剩余时间不变；继续、重启、结束后检查记录没有重复。
5. 同日多次点击习惯记录，确认一天只有一条；隔日检查近期网格与连续天数。
6. 关闭并重新启用插件，确认原笔记、其他插件与工作区不受影响。

设计边界见 [DESIGN.md](docs/DESIGN.md)，独立实现与许可说明见 [PROVENANCE.md](docs/PROVENANCE.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目源码按 [MIT](LICENSE) 许可发布。
