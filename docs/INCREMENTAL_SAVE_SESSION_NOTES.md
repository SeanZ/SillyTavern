# Incremental Save & Load Optimization — Session Notes

> 本文档记录了增量保存优化项目的完整上下文，供后续会话接续开发时参考。

## 1. 项目概述

### 1.1 问题

用户通过移动端浏览器远程访问 SillyTavern 服务器，高延迟网络下全量 JSON 保存（2-5MB/次）造成严重性能问题。

### 1.2 解决方案

用增量 append/patch 操作（~1-2KB）替代全量保存，大幅降低网络传输量。

### 1.3 约束

- **最小化对 ST 现有文件的修改**：确保 `git rebase upstream/release` 时冲突最少
- 需要完备的单元测试（因本地无法轻松做全集成测试）
- 参考 Luker（`/Users/bytedance/workspace/github/sillytavern/Luker`）的成熟实现模式
- 用户通过移动浏览器访问远程 ST 服务器，非桌面应用
- 用户不想切换到 Luker，倾向在自己的 fork 上做定向优化

## 2. 仓库信息

| 项目 | 路径 |
|------|------|
| SillyTavern (fork) | `/Users/bytedance/workspace/github/sillytavern/SillyTavern` |
| Git remote origin | `git@github.com:SeanZ/SillyTavern.git` |
| Git remote upstream | `https://github.com/SillyTavern/SillyTavern.git` |
| 开发分支 | `dev`（基于 `release`，8 commits ahead） |
| ST 版本 | 1.18.0 |
| Luker 参考 | `/Users/bytedance/workspace/github/sillytavern/Luker`（v2.7.0） |

## 3. Git 日志

```
ab46c91c5 fix: address code review findings from Luker comparison
e606159f6 fix: resolve black screen caused by circular dependency in incremental-save.js
338e37feb feat: Phase 3 - message edit patch routing + settings patch + compression
3044c925a feat: Phase 2 - incremental loading (get-delta, bootstrap, fast-load)
4c6c44a49 feat: complete Phase 1 - intelligent incremental save routing in saveChatConditional
11d44040a feat: integrate incremental-save module into chat load paths
f55a525a9 feat: Phase 1 endpoint + frontend module for incremental chat saves
15641d716 feat: Phase 1 core - incremental save modules (integrity, append, patch, meta)
```

## 4. 改动文件一览

### 4.1 新建文件（核心逻辑，约 2940 行）

| 文件 | 用途 |
|------|------|
| `src/incremental/integrity.js` | 完整性 hash/sidecar 管理（`.state.json`） |
| `src/incremental/append.js` | 追加消息到 JSONL，含去重 |
| `src/incremental/patch.js` | RFC 6902 风格 JSON Patch 操作 |
| `src/incremental/meta.js` | chat_metadata 深合并 |
| `src/incremental/delta.js` | 分页消息加载（只读） |
| `src/endpoints/incremental-chats.js` | Express 路由（8 个端点） |
| `src/endpoints/incremental-settings.js` | 设置增量保存端点 |
| `src/endpoints/bootstrap.js` | 聚合启动端点 |
| `public/scripts/incremental-save.js` | 前端模块（序列化写队列，自动降级） |
| `public/scripts/fast-load.js` | 前端增量加载模块 |
| `tests/incremental/*.test.js` | 49 个新测试 |
| `docs/PHASE1_TECHNICAL_DESIGN.md` | Phase 1 技术设计文档 |
| `docs/PHASE2_TECHNICAL_DESIGN.md` | Phase 2 技术设计文档 |
| `docs/CODE_REVIEW_FINDINGS.md` | 对比 Luker 的代码审查发现 |

### 4.2 修改的现有文件（仅约 41 行改动）

| 文件 | 改动内容 |
|------|----------|
| `public/script.js` | 导入 incremental-save 模块，在 `saveChatConditional()` 中调用 `tryIncrementalSave()`，调用 `setCsrfToken()` |
| `public/scripts/group-chats.js` | 导入 `initIncrementalSave`，在群聊加载时初始化 |
| `src/server-startup.js` | 注册 incremental router（在 chatsRouter 之前） |
| `default/config.yaml` | 启用请求压缩 |

## 5. 关键技术决策

### 5.1 incremental-save.js 零导入模式

`incremental-save.js` 完全自包含，**不从 script.js 导入任何东西**，避免循环依赖：
- `script.js` 导入 `incremental-save.js`（单向）
- CSRF token 通过 `setCsrfToken()` 注入，而非从 script.js 导入

**背景**：之前从 `./RossAscends-mods.js` 导入 `getRequestHeaders` 导致黑屏（该文件不导出此函数）。

### 5.2 路由注册顺序

增量路由（`/append`, `/patch` 等）注册在现有 `chatsRouter` **之前**，确保新路由优先匹配。

### 5.3 完整性管理

- 使用 sidecar 文件 `{chatName}.state.json`（有意区别于 Luker 的 `.luker-state.*`）
- UUID-based slug，每次写操作后轮转
- 409 Conflict 表示乐观并发冲突

### 5.4 智能路由逻辑

`tryIncrementalSave()` 的检测逻辑：
- `chat.length > lastSavedChatLength` → 追加新消息 → `/append`
- 同长度 + `pendingEditedIndices` 非空 → 编辑补丁 → `/patch`
- 否则降级到全量保存

### 5.5 优雅降级

所有增量操作返回 boolean；`false` 表示调用方应降级到原始全量保存。服务端 404 自动禁用模块。

### 5.6 validateAvatarUrlMiddleware

最新提交中为字符聊天的 4 个端点（append/patch/meta/get-delta）添加了 `validateAvatarUrlMiddleware`。该中间件从 `src/middleware/validateFileName.js` 的 **default export** 导入（该文件底部导出了预配置的 `avatar_url` 验证器）。

### 5.7 append 去重改为 while 循环

匹配 Luker 的模式，处理多条消息重试场景（不只检查第一条）。

### 5.8 chat_metadata.integrity 回写

增量保存成功后，同步 `chat_metadata.integrity` 到前端全局状态，确保后续全量保存时 header 中的 integrity 是最新的。

## 6. API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/append` | 字符聊天追加消息 |
| POST | `/api/chats/patch` | 字符聊天补丁操作 |
| POST | `/api/chats/meta/patch` | 字符聊天元数据补丁 |
| POST | `/api/chats/get-delta` | 字符聊天增量加载 |
| POST | `/api/chats/group/append` | 群聊追加消息 |
| POST | `/api/chats/group/patch` | 群聊补丁操作 |
| POST | `/api/chats/group/meta/patch` | 群聊元数据补丁 |
| POST | `/api/chats/group/get-delta` | 群聊增量加载 |
| POST | `/api/settings/patch` | 设置增量保存 |
| GET  | `/api/bootstrap` | 聚合启动数据 |

## 7. 测试

```bash
cd /Users/bytedance/workspace/github/sillytavern/SillyTavern/tests
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json
```

结果：**364 tests passing**（49 新增量测试 + 315 原始 ST 测试）

## 8. 启动服务器

```bash
cd /Users/bytedance/workspace/github/sillytavern/SillyTavern
node server.js  # 端口 8000
```

CSRF 保护需要 cookie-based session，curl 直接测试会返回 403。

## 9. 代码审查发现（对比 Luker）

| # | 严重度 | 问题 | 状态 |
|---|--------|------|------|
| 1 | 🔴 | patch.js 残留 `require` 引用 | ✅ 已修复 |
| 2 | 🟡 | `readLastLine()` 读全文件 | ⏭️ 与 Luker 一致 |
| 3 | 🔴 | 缺少 `validateAvatarUrlMiddleware` | ✅ 已添加 |
| 4 | 🔴 | dedup 只检查第一条消息 | ✅ 改为 while 循环 |
| 5 | 🟡 | 缺少 generation_id 去重 | ⏭️ 记录为 Known limitation |
| 6 | 🟡 | remove 操作索引漂移 | ✅ 实现正确 |
| 7 | 🟡 | applied=0 时 integrity 轮转 | ⏭️ 当前行为安全 |
| 8 | 🟡 | lastSavedChatLength=0 初始状态 | ✅ 安全 fallback |
| 9 | 🟡 | 缺少 chat_metadata.integrity 回写 | ✅ 已修复 |
| 10 | 🟢 | loadChatTail 需 2 RTT | ⏭️ 未来优化 |
| 11 | 🟢 | settings patch 缺并发保护 | ⏭️ 前端 debounce 覆盖 |

## 10. 后续计划

1. **推送到远程**：`git push origin dev`
2. **部署测试**：在用户服务器上部署，真实使用场景验证
3. **可选 Phase 2.5**：SessionStorage 缓存聊天状态，页面刷新时用 get-delta 增量恢复
4. **可选**：将 `fetchBootstrap()` 接入启动流程，合并 avatar+settings 请求
5. **可选**：对长聊天使用 `loadChatTail()` 先渲染最后 N 条消息，懒加载旧消息

## 11. 已知问题 & 注意事项

- 用户报告的 `ERR_CONNECTION_REFUSED` 错误是**服务器未运行**导致的，与增量保存代码无关
- 之前的黑屏问题已修复（circular dependency in incremental-save.js）
- 所有增量操作在失败时静默降级到全量保存，不会破坏现有功能
- Sidecar 文件命名 `{chatName}.state.json` 有意区别于 Luker 的格式，避免冲突
