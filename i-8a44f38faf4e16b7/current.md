id: TAPMCP-002
token: path_segment=i-8a44f38faf4e16b7
token=c910a74333cf1eb92c4f3a64
url=https://qrjssbb.github.io/i-8a44f38faf4e16b7/current.md
status: open
---
# 操作单 TAPMCP-002：安装 TapTap 官方开发工具（开放 MCP + Maker）

## 目标
在这台 Windows 电脑上接入 TapTap 官方仓库 `taptap/instant-games-open-mcp` 的两套工具：
1. Maker 开发工具（建项目 / 构建 / 本地预览 / 出二维码）
2. 小游戏开放 MCP（排行榜、分享、多人联机、云存档、H5 上传发布、广告状态等）

本单按“标准 MCP 手动注册”为主路线：**不限定使用官方列出的那几个 agent**。官方 `init` 自动识别 Codex / Cursor / Claude / Trae / OpenCode / WorkBuddy / DSH 只是方便自动写配置，不是白名单；当前 agent 只要支持 MCP，就手动注册。若当前 agent 支持插件 marketplace，也可以添加该 GitHub 仓库作为共享仓库来源，但这不是必须项。

## 工作目录（本单新增要求）
- 在 D 盘新建文件夹：`D:\taptap-maker`
- 本次安装、初始化、配置备份都只在这个新文件夹及其子目录里进行。
- 不要动已有游戏项目目录，不要移动 / 删除 / 覆盖任何已有项目文件。

## 执行前检查
在 PowerShell 里进入 `D:\taptap-maker` 后，记录以下版本到回报里：
- `node -v`
- `npx -v`
- `git --version`
- `python --version`（没有就写“未发现”）

如果 Node / npx 不存在，先停下回报，不要自行安装来路不明的软件。

## 步骤
1. 新建目录 `D:\taptap-maker`（已存在则直接使用），进入该目录。
2. 运行 Maker 初始化：
   - `npx -y @taptap/maker init`
   - 如果它自动检测到本机已有 agent 并提出写 MCP 配置，可以允许它写；但不要为了这一步去安装新的 agent。
3. **登录 / 授权步骤必须停下等用户本人**：
   - 如果出现设备码、二维码、浏览器授权、TapTap 登录确认，立即停止后续操作。
   - 发邮件到 `jierryssb@gmail.com`，标题：`[取单待确认] TAPMCP-002 需要本人授权`
   - 邮件里写清：卡在哪一步、需要用户做什么、当前窗口不要关。
   - 不要代填账号、密码、验证码，不要索要或保存 token / JWT。
4. **选择 app 步骤必须停下等用户选**：
   - 如果 `init` 显示 app 列表，或要求选择 / 新建 app，把列表原样回报给用户，等用户决定。
   - 不要代选，不要擅自新建 app。
   - 用户选定后，重新运行 `npx -y @taptap/maker init` 续完流程（该命令可重复运行）。
5. 注册小游戏开放 MCP（手动注册为本单主路线）：
   - 在当前 agent / MCP 客户端的配置中新增条目 `taptap-minigame`：
     - command: `npx`
     - args: `-y`, `@taptap/instant-games-open-mcp`
     - env: `TAPTAP_MCP_WORKSPACE_ROOT` = `D:\taptap-maker`（如果客户端支持变量，也可用 `${workspaceFolder}`，但本单优先写 D 盘新目录）
   - 修改任何 MCP 配置文件前，先在同目录备份原文件，备份名带日期时间。
   - 如果已存在同名 `taptap-minigame` 条目，不要重复添加；回报“已存在，跳过”。
   - 不要改动其他 MCP 条目。
   - 本次只完成注册，不要主动触发开放 MCP 的 OAuth 授权；如客户端保存配置时强制要求授权，停下按第 3 条发 [取单待确认]。
6. 验证 Maker：
   - 运行 `npx -y @taptap/maker doctor`
   - 运行 `npx -y @taptap/maker mcp verify`
   - 把两条命令的完整结果摘要写进回报；失败时保留错误原文的关键几行，不要只写“失败”。
7. 可选：插件 marketplace
   - 如果当前 agent 明确支持插件 marketplace，可把 `https://github.com/taptap/instant-games-open-mcp` 加为 marketplace 来源，并回报结果。
   - 如果不支持，跳过即可，不要报错中断；手动 MCP 注册已经满足本单目标。

## 边界
- 只在 `D:\taptap-maker` 内新建 / 写文件；MCP 配置文件按第 5 条备份后最小修改。
- 不上传、不构建、不发布任何游戏项目。
- 不产生费用，不购买任何服务。
- 不处理实名、备案、收款、项目认领等只能用户本人办的事项；遇到就停下发 [取单待确认]。
- 不删除文件；本单没有删除动作。

## 回报
完成后发邮件到 `jierryssb@gmail.com`，标题：`[取单回报] TAPMCP-002 TapTap 开发工具安装`
正文包含：
- 主机名
- Node / npx / Git / Python 版本
- `D:\taptap-maker` 是否已创建
- `init` 实际走到哪一步，是否中途停在授权或选 app
- `doctor` 与 `mcp verify` 的结果摘要
- 给哪些客户端写了 MCP 配置：配置文件路径 + 备份文件路径
- 是否添加了 marketplace 来源
- 未完成项与错误原文摘要（如有）

同一份回报另存到本机：`D:\agent-inbox\reports\TAPMCP-002.md`
