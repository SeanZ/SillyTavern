# Phase 1 技术方案：增量保存

## 架构设计原则

为了让后续 ST 上游 rebase 时冲突最小化：

1. **新增文件为主，减少对现有文件的修改** — 核心逻辑放在新建的 `src/incremental/` 目录
2. **Express router 独立注册** — 新建 `src/endpoints/incremental-chats.js`，不修改原 `chats.js`
3. **前端模块化注入** — 新建 `public/scripts/incremental-save.js`，对 `script.js` 的修改限制为一行 import + 一处 hook 点
4. **graceful fallback** — 增量端点不可用时，前端自动退回原有 `saveChat()` 路径

## 目录结构

```
src/
├── incremental/                    ← 新增：核心逻辑（纯函数，可单测）
│   ├── integrity.js                ← integrity hash 管理（读/写/校验 sidecar）
│   ├── append.js                   ← append 核心逻辑（去重 + 追加）
│   ├── patch.js                    ← JSON Patch 应用（幂等化 + 校验）
│   └── meta.js                     ← metadata deep merge
├── endpoints/
│   ├── chats.js                    ← 【不修改】原有全量保存端点
│   └── incremental-chats.js        ← 新增：append/patch/meta/get-delta 路由
├── server-startup.js               ← 【最小修改】注册新 router（1 行 import + 1 行 app.use）
tests/
├── incremental/                    ← 新增：单元测试
│   ├── integrity.test.js
│   ├── append.test.js
│   ├── patch.test.js
│   └── meta.test.js
public/scripts/
├── incremental-save.js             ← 新增：前端增量保存模块
├── script.js                       ← 【最小修改】在 saveChatConditional 中调用增量模块
```

## 对现有文件的修改清单（rebase 冲突面）

| 文件 | 修改内容 | 行数 |
|------|----------|------|
| `src/server-startup.js` | +1 import, +1 app.use | 2 行 |
| `public/script.js` | +1 import, saveChatConditional 内加判断分支 | ~10 行 |

其余全部是新增文件。

## 详细设计

### 后端：`src/incremental/integrity.js`

```js
// 职责：管理 .state.json sidecar 文件
// - readIntegrity(chatFilePath) → string | null
// - writeIntegrity(chatFilePath, uuid) → void
// - validateIntegrity(chatFilePath, clientSlug, force) → { valid: boolean, current: string }
// - generateIntegrity() → string (uuid v4)
```

Sidecar 命名：`{chatFileName}.state.json`，与 JSONL 同目录。
格式：`{ "integrity": "uuid", "updated_at": timestamp }`

### 后端：`src/incremental/append.js`

```js
// 职责：追加消息到 JSONL 文件
// - appendMessages({ chatFilePath, messages, integrity, force }) → { appended, skipped, integrity, created }
// 
// 去重逻辑：
//   1. 读取文件最后一行（最后一条消息）
//   2. 如果新消息与最后一条消息深度相等（忽略 gen_id），跳过
//   3. appendFileSync 追加剩余消息
//   4. 轮转 integrity
```

### 后端：`src/incremental/patch.js`

```js
// 职责：按索引修改消息
// - patchMessages({ chatFilePath, operations, integrity, force }) → { applied, totalMessages, integrity }
//
// operations 格式（简化版 RFC 6902）：
//   { op: "replace", path: "/<index>", value: { ...message } }          — 整条替换
//   { op: "replace", path: "/<index>/<field>", value: ... }             — 字段替换
//   { op: "remove", path: "/<index>" }                                   — 删除消息
//   { op: "add", path: "/<index>", value: { ...message } }              — 插入消息
//
// 幂等逻辑：
//   replace → 目标值已等于 value 时视为 no-op
//   add → 目标位置已有等值消息时跳过
```

### 后端：`src/incremental/meta.js`

```js
// 职责：deep merge chat_metadata
// - patchMetadata({ chatFilePath, metadata, integrity, force }) → { integrity }
//
// 只重写 JSONL 第一行（header），不触碰消息行
```

### 后端：`src/endpoints/incremental-chats.js`

Express router，挂载路径 `/api/chats`（与原 chatsRouter 共享前缀，Express 按注册顺序匹配）：
- `POST /api/chats/append` → 调用 `appendMessages()`
- `POST /api/chats/patch` → 调用 `patchMessages()`
- `POST /api/chats/meta/patch` → 调用 `patchMetadata()`
- `POST /api/chats/group/append` → 群聊版
- `POST /api/chats/group/patch` → 群聊版
- `POST /api/chats/group/meta/patch` → 群聊版

### 前端：`public/scripts/incremental-save.js`

```js
// 导出：
// - appendChatMessages(messages) → Promise<boolean>  (成功返回 true，失败返回 false 表示需 fallback)
// - patchChatMessages(operations) → Promise<boolean>
// - saveChatMetadata(metadata) → Promise<boolean>
// - isIncrementalSaveAvailable() → boolean
//
// 内部状态：
// - currentIntegrity: string  (上次成功写入返回的 integrity)
// - writeQueue: Promise chain  (序列化写入)
//
// 409 处理：
//   1. refetch 完整聊天数据
//   2. 更新 currentIntegrity
//   3. 返回 false 让调用方 fallback 到全量保存
```

### 前端集成点（`public/script.js` 修改）

```diff
+ import { appendChatMessages, patchChatMessages, saveChatMetadata, setIntegrity } from './scripts/incremental-save.js';

  export async function saveChatConditional() {
      // ... existing code ...
+     // 增量保存路由（失败时自动 fallback 到下方的全量保存）
+     if (await tryIncrementalSave()) return;
      
      if (selected_group) {
          await saveGroupChat(selected_group, true);
      } else {
          await saveChat();
      }
      // ...
  }
```

`tryIncrementalSave()` 的逻辑放在 `incremental-save.js` 中，它检查上下文决定走 append/patch/meta 还是 fallback。

## 单元测试策略

测试使用 Jest（与 ST 已有测试框架一致），在 `tests/incremental/` 下：

1. **integrity.test.js** — sidecar 文件读写、UUID 轮转、校验逻辑
2. **append.test.js** — 追加消息、去重、首次创建、integrity 冲突
3. **patch.test.js** — replace/remove/add 操作、幂等性、越界处理
4. **meta.test.js** — deep merge、只改 header 不碰消息行

每个测试用 `fs.mkdtempSync` 创建临时目录，写入测试 JSONL，执行操作后验证文件内容。

## 实现顺序

1. `src/incremental/integrity.js` + tests
2. `src/incremental/append.js` + tests
3. `src/incremental/patch.js` + tests
4. `src/incremental/meta.js` + tests
5. `src/endpoints/incremental-chats.js` (路由层，调用上述模块)
6. `src/server-startup.js` 最小修改（注册路由）
7. `public/scripts/incremental-save.js` (前端模块)
8. `public/script.js` 最小修改（集成点）
