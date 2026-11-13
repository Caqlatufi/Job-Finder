# Job Finder

把岗位筛选、简历准备、投递跟进和面试复盘放在同一个本地工作台。

面向个人求职者，在 Windows 本机运行，使用内嵌数据库保存资料。

## 功能

| 功能 | 可以做什么 |
| --- | --- |
| [岗位收录与评分](docs/05-JD管理与评分.md) | 收录岗位，保留原文与来源，结合简历、公司、通勤、薪资和新鲜度判断优先级与缺口 |
| [公司与通勤](docs/06-公司资料与通勤.md) | 整理公司资料和岗位办公点，在地图上查看分布并核对通勤信息 |
| [简历管理](docs/07-简历版本管理.md) | 管理经历母版与定向版本，编辑 Markdown，预览并输出 PDF |
| [投递与跟进](docs/09-投递记录与跟进.md) | 记录实际投递、沟通阶段和下一步，查看面试安排与求职看板 |
| [面试安排与复盘](docs/10-面试安排与复盘.md) | 记录面试时间、问题、反馈和复盘，持续补齐准备材料 |
| [岗位技能图谱](docs/16-JD知识图谱.md) | 查看多个目标岗位共同要求的技能，确定准备重点 |
| [AI 辅助准备](docs/17-打招呼用语生成.md) | 根据岗位与简历生成可编辑、可复制的打招呼用语 |
| [导出与备份](docs/14-数据备份与恢复.md) | 按筛选导出岗位 CSV，备份工作台数据库 |

建议使用顺序：**导入简历 → 设置求职门槛 → 收录与筛选岗位 → 准备定向材料 → 投递跟进 → 面试记录与复盘。**

列表批量采集目前适配 BOSS，单岗位链接收录支持招聘网站和企业官网。登录、验证码、真实投递及消息发送由本人操作。

## 快速开始（Windows）

准备 **Git、Java 17、Node.js 22.12+ 和 PowerShell**，建议使用英文路径。默认使用内嵌 H2，无需安装 MySQL。在项目根目录执行以下命令即可启动工作台。

### 1. 克隆与初始化

```powershell
git clone https://github.com/Caqlatufi/Job-Finder.git
Set-Location Job-Finder
.\ops\init-local.ps1
```

### 2. 构建并打开工作台

```powershell
npm ci --prefix frontend
npm run desktop:install --prefix frontend
.\ops\build.ps1
.\ops\start-desktop.ps1
.\ops\doctor.ps1 -Running
```

桌面启动器会启动本地后端并打开工作台，页面地址为 `http://127.0.0.1:7890/jd-collector/`。后续日常打开只需运行 `.\ops\start-desktop.ps1`。

### 3. 填写资料，开始使用

- 在“简历版本”保存一份有真实正文、已启用的 `MASTER`；本地简历模板不会自动入库。
- 在“JD 门槛”填写求职条件，再按城市、关键词和数量确定本轮筛选范围。
- 需要 AI 采集时，安装并登录 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)，将 `local/env.json` 中的 `JD_RECOGNITION_ENABLED` 设为字符串 `"true"`，核对下方模型配置后重启。完整配置见下方“AI 采集配置”。

## 文档

- [功能文档与使用说明](docs/README.md)
- [JD 门槛填写](docs/15-JD门槛填写.md)
- [求职计划示例](config/sprint-plan.example.md)
- [开发与运行约定](AGENTS.md)

<details>
<summary>AI 采集配置与 Agent 接手</summary>

### AI 采集配置

默认将 H2 数据保存在 `local/data/jd-collector.mv.db`，可通过 `JD_COLLECTOR_DATA_DIR` 指向其他可写目录。已有 MySQL 数据需要先按[内嵌数据库与迁移](docs/19-内嵌数据库与迁移.md)迁移核对，不能仅改连接后把空库当作迁移成功。启用采集时将 `JD_RECOGNITION_ENABLED` 改为字符串 `"true"`，并确认 Codex 已登录。

```json
{
  "JD_COLLECTOR_DATA_DIR": "local/data",
  "JD_COLLECTOR_DB_USERNAME": "sa",
  "JD_COLLECTOR_DB_PASSWORD": "",
  "JD_RECOGNITION_ENABLED": "true",
  "JD_RECOGNITION_NODE": "node",
  "JD_RECOGNITION_CODEX": "",
  "JD_RECOGNITION_MODEL": "gpt-6-astra",
  "JD_RECOGNITION_REASONING_EFFORT": "medium",
  "JD_RECOGNITION_WORK_DIRECTORY": ""
}
```

识别进程直接运行原生可执行文件。在 Windows 上，若自动发现失败，将 `JD_RECOGNITION_CODEX` 填为本机 `codex.exe` 的绝对路径，不能填 `codex.cmd` 或 `.bat`。使用**同一份可执行文件**执行 `login`；安装与认证方法见 [官方认证说明](https://learn.chatgpt.com/docs/auth)。模型需支持图片输入并对当前账号可用；更换模型或强度必须由用户明确配置，不自动降级。

配置、简历和截图均保留在本地被忽略的位置。已有配置不会被初始化脚本覆盖；升级时按 [配置示例](config/env.example.json) 手动补需要的字段。

### 交给 Agent 接手

按 [Dot 官方连接说明](https://learn.chatgpt.com/docs/dots/computers-and-apps)，在 Windows ChatGPT 应用中打开 Dot 资料页，通过 Computers → Your computer → Allow access 连接本机。保持电脑在线、ChatGPT 应用打开，并让它在此项目目录创建本地 Codex/Work 任务。GitHub 地址用于取得源码，本机任务负责运行项目和 Electron workflow。

可复制以下指令，并提供你的简历与本轮筛选范围：

```text
请在已连接的 Windows 电脑上接手 JD Collector，先读取项目 AGENTS.md 和 README 快速开始。
使用我提供的新简历作为事实来源；附件和配置放 local/，不要提交个人资料或密钥。
先运行环境自检，完成本地配置、构建和桌面启动。
将简历整理为 Markdown，通过简历 API 保存为启用 MASTER，回读核对，不能编造经历。
将我提供的范围保存为已确认 JD 门槛，并建立本地搜索任务单；未提供的条件不要自行补限制。
采集前读取当前 criteria API、唯一启用 MASTER 的正文，以及 BOSS Skill。
先试采 3 个 JD，核对截图证据、门槛、查重和基于简历的匹配分；按我的采集授权保存并回读。
报告已保存数量、排除原因和待核实项。登录及验证码由我在 Electron 页面处理。
不要自动投递、联系招聘者或向招聘网站上传简历。
```

首次试采的落库与回读通过后，再扩大批次。列表批量采集目前适配 BOSS，操作规则见 [.agents/skills/jd-boss/SKILL.md](.agents/skills/jd-boss/SKILL.md)；单岗位链接收录可读取招聘网站或企业官网岗位页，保留页面有效性、完整性与截图识别核对。登录和验证码由本人完成。

自检默认不调用模型；需要验证图片识别接入时，可运行 `.\ops\doctor.ps1 -Running -ProbeModel`，该操作会消耗模型额度。探测成功只表示模型链路可用，实际岗位仍需按截图、门槛和简历核对。

</details>

<details>
<summary>运行配置、个人数据与备份</summary>

## 运行配置与常用命令

统一入口是被 Git 忽略的 `local/env.json`，值全部使用字符串。默认识别模型为 Astra/medium。

| 配置键 | 默认值 / 用途 |
| --- | --- |
| `JD_COLLECTOR_DATA_DIR` | 默认 `local/data`，可改到外部可写目录 |
| `JD_COLLECTOR_DB_URL`、`JD_COLLECTOR_DB_USERNAME`、`JD_COLLECTOR_DB_PASSWORD` | 默认 H2 / sa / 空密码；已有实例使用本地配置，支持显式 MySQL |
| `JD_RECOGNITION_ENABLED` | 初始化示例为 `false`；采集时设为 `true` |
| `JD_RECOGNITION_NODE` | `node`；可指定 Node 可执行文件 |
| `JD_RECOGNITION_CODEX` | 空字符串自动发现；可指定原生 `codex.exe` |
| `JD_RECOGNITION_MODEL` | `gpt-6-astra`；需支持图片且账号有权限 |
| `JD_RECOGNITION_REASONING_EFFORT` | `medium`；支持 `low`、`medium`、`high`、`xhigh`，实际可用范围由模型决定 |
| `JD_RECOGNITION_WORK_DIRECTORY` | 空字符串使用 `runtime/jd-screenshots`；相对路径以项目根为基准 |
| `JD_COLLECTOR_BUILD_ROOT` | 可选 ASCII junction，解决中文路径的 Gradle/JUnit 兼容问题 |

`GET /jd-collector/api/recognition/config` 返回后端当前生效的开关、模型、强度和工作目录。修改运行配置后先停止后端，打开新的 PowerShell 再启动，避免当前会话已加载的进程变量覆盖新文件；运行 `doctor.ps1 -Running` 核对。

```powershell
# 构建网页、Electron 和一体化 JAR
.\ops\build.ps1

# 启动 / 停止
.\ops\start.ps1
.\ops\stop.ps1

# 打开 Electron，并在需要时启动后端
.\ops\start-desktop.ps1

# 数据库备份
.\ops\backup.ps1
```

`build/start/backup` 共用 `ops/env.ps1`，配置优先级为进程环境变量、`local/env.json`、兼容的 Windows 用户数据库环境变量。配置值按字符串读取，不执行其中的代码，不回显秘密。直接运行 Gradle 前可在项目根执行 `. .\ops\env.ps1`，再进入 `backend`。路径建议使用 `/`，相对文件路径以项目根为基准。

中文路径下若 Gradle/JUnit 不兼容，可在本地配置 `JD_COLLECTOR_BUILD_ROOT` 指向一个 ASCII junction；构建脚本会验证目标。公开源码不绑定任何绝对工作目录。

## 个人配置与数据

| 位置 | 用途 | 覆盖变量 |
| --- | --- | --- |
| `local/env.json` | 数据库连接及运行参数 | `JD_COLLECTOR_ENV_FILE` |
| `local/data/` | 内嵌 H2 业务文件，不提交、不打入 JAR | `JD_COLLECTOR_DATA_DIR` |
| `local/JD门槛.json` | 薪资、通勤、经验、工作安排等；通过 `/api/criteria` 读写 | `JD_COLLECTOR_CRITERIA_FILE` |
| `local/resume-starter.md` | 新增简历的初始正文 | `JD_RESUME_STARTER_FILE` |
| `local/resume/photo.png` | 运行时提供的 PNG 照片，不打入前端或 JAR | `JD_RESUME_PHOTO_FILE` |
| `local/JD搜索任务单*.md` | 搜索关键词、区域、平台筛选与执行进度 | Agent 读取本地任务单 |
| `local/求职冲刺计划.md` | 个人目标与日程 | 本地编辑 |
| `runtime/`、`backups/` | 截图、日志、识别结果、数据库与历史账号密钥备份 | 不提交、不发布 |

`config/` 只存无个人答案的示例。`init-local.ps1` 只补缺失文件，不覆盖已有配置。没有本地简历模板时使用匿名示例；没有照片时不显示照片。明确指定了不存在的模板会报错。门槛缺失时要求初始化，不静默采用示例答案。

新增简历模板通过 `/api/resume-starter` 读取；照片通过 `/resume/photo.png` 提供。已保存的简历正文与版本仍在数据库中。旧照片 URL 可通过 `JD_RESUME_LEGACY_PHOTO_ROUTE` 在本地配置兼容，无需批量更新已有简历。

平台会话保留在 Electron 用户数据目录中；Codex 登录沿用本机 CLI，不保存到源码。截图识别配置和环境自检见上文，工作流协议见 [.agents/skills/platform-workflow.md](.agents/skills/platform-workflow.md)。

</details>

<details>
<summary>技术栈、开发验证与源码发布</summary>

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Element Plus、Pinia、axios、SCSS。
- 前端结构：业务域各自通过 `index.ts` 注册懒加载路由，由 `main.ts` 逐个挂载，`app/router.ts` 统一装配。
- 后端：Java 17、Spring Boot 3.1.1、Gradle、Spring Data JPA、内嵌 H2（兼容显式 MySQL / MariaDB 连接）、Lombok。
- 工作台后端的公共实体及 REST 响应由本项目维护，不需要本机私有框架。
- 接口：REST，统一前缀 `/jd-collector/api`。
- 本地端口：打包版统一使用 `7890`；前端独立开发时使用 `3002`。
- 数据表：首版使用 JPA DDL update 管理，不新增 Simple Migration 建表脚本。

工作台 `backend` 已移除 `yhc.framework:commons` 依赖：基础实体与 REST 响应源码位于 `backend/common`，仓储直接使用 Spring Data JPA。构建无需框架源码、私有 Maven、本机 `mavenLocal()` 或另行提供的框架 JAR，可按[快速开始](#快速开始windows)构建工作台。

## 验证与发布源码

```powershell
Set-Location backend
.\gradlew.bat :app:test :account:test :criteria:test :recognition:test :resume:test
Set-Location ../frontend
npm run build
npm run desktop:check
Set-Location ..
node ops/audit-public.mjs
node --test ops/public-source.test.mjs
node --test ops/doctor.test.mjs ops/recognition/recognition.test.mjs ops/recognition/screen-batch.test.mjs
node ops/export-source.mjs
```

导出脚本先审查 Git 当前索引及未忽略的新文件，再创建 `runtime/open-source/jd-collector-<时间戳>/`，只复制当前项目的公开源码，保留 `.agents/`、公开配置与构建文件；不复制 `.git`、个人文件、依赖或产物。导出目录可作为全新的开源仓库起点。规则扫描是辅助检查，新增文件应在发布前自行审阅。

`.gitignore` 不会清除旧提交。原仓库已有个人资料时，请使用无历史的源码导出建立新仓库，勿将父目录仓库或其旧历史直接公开。当前工具不改写历史、不提交、不推送。

完整命令、自动启动和恢复约定见[开发与运行约定](AGENTS.md)。测试使用独立 H2 / Electron userData；访问真实个人库的只读用例不代表通用夹具验证。

</details>

## 许可证

本项目源码采用 [Apache License 2.0](LICENSE)，官方文本见 [Apache 网站](https://www.apache.org/licenses/LICENSE-2.0.txt)。第三方依赖及 Gradle Wrapper 保留其各自许可证和现有声明；许可证不包含个人简历、数据库、招聘网站内容或本地截图。
