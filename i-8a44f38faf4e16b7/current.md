id: TEST-001
token: c910a74333cf1eb92c4f3a64
status: open
---
# 测试单 TEST-001（只读，不改任何东西）

这是自动取单通道的第一单，只验证回路，不动任何文件和设置：

1. 记录本机当前时间和主机名。
2. 确认 `D:\openlist` 目录是否存在（只看在不在，不打开、不改动）。
3. 列出 `D:\wb-share\` 里的文件名（只列名字，不读内容）。

完成后：
- 把回报发邮件到 **jierryssb@gmail.com**，标题固定为 `[取单回报] TEST-001`，正文写三项结果（不要写 token）；
- 同时在本机 `D:\agent-inbox\reports\TEST-001.md` 存一份同样的回报；
- 把本单 id 记入 `D:\agent-inbox\state.txt` 的 last_id。
