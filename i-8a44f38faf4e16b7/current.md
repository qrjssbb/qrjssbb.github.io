id: VID-004
token: c910a74333cf1eb92c4f3a64
status: open
---
# 任务单 VID-004（装 rclone + 用户点一次授权 + 补传 Drive）

用户已拍板：装 rclone，他本人点一次 Google 授权，之后你无人值守把 VID-003 卡住的两处上传补完。

## 第一步：装 rclone
- 官方渠道二选一：winget `winget install -e --id Rclone.Rclone`，或从 rclone.org 下 Windows amd64 zip 解压到 `D:\agent-inbox\tools\rclone\`。装完 `rclone version` 能出版本号才算好。
- 不要用第三方下载站的包。

## 第二步：建 Drive 远程（只差用户点一次）
- 远程名固定 `gdrive`，类型 drive，**scope 选 `drive.file`**（只许碰它自己建的文件，够用且最小权限），client_id / client_secret 留空（用 rclone 内置的）。
- 参考：`rclone config create gdrive drive scope=drive.file`，它会拉起浏览器打开 Google 授权页。**授权页打开后你停下**：发一封 `[取单待确认] VID-004` 邮件到 jierryssb@gmail.com，写明「授权页已在电脑上打开，请用户选 jierryssb@gmail.com 账号并点允许」；同时保持命令等待，不要关。
- 红线：选账号、点允许、可能出现的密码/验证，全部用户本人完成，你不代点授权、不代输密码、不代扫码。用户点完后流程会自动拿到令牌，你继续。
- `rclone lsd gdrive:` 能列出根目录 = 授权成功。
- 安全：生成的 rclone.conf 含刷新令牌，**只存本机**，不外发、不进回报、不写进任何邮件。

## 第三步：补传（授权成功后无人值守完成）
1. `gdrive:生化讲义音频` ← 传 `D:\agent-inbox\audio\` 里 35 个 mp3（不要传 `_extract.log`）。本地基准：35 个文件、合计 363,039,909 字节。
2. `gdrive:生化讲义` ← 传 `D:\agent-inbox\jiangyi\` 里那个 PDF（235,411,423 字节）。
3. 用 `rclone copy` 传，传完逐边核对：`rclone size` 和文件清单与本地一致（数量+字节数）。对不上就补传缺的，不要整批重来。

## 回报
- 邮件发 jierryssb@gmail.com，标题 `[取单回报] VID-004`，写明：rclone 版本、两个文件夹各自的文件数与总字节（与本地基准是否一致）、失败/重试情况。
- 本地存一份到 `D:\agent-inbox\reports\VID-004.md`；把本单 id 记入 `D:\agent-inbox\state.txt` 的 last_id。
- 回报里不要出现 token、令牌、rclone.conf 内容。
