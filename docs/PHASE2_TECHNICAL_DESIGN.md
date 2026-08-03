# Phase 2 技术方案：加载优化

## 目标

减少页面打开和聊天切换时的等待时间，特别是在高延迟网络环境下。

## 已完成

### 2.1 GET-DELTA 增量加载端点

**问题**：页面刷新/重连时，`/api/chats/get` 返回完整聊天历史（500 条消息 = 2-5MB）。

**端点**：
- `POST /api/chats/get-delta` — 角色聊天
- `POST /api/chats/group/get-delta` — 群聊

```js
// Request
{ avatar_url, file_name, from_index: 450, limit: 50 }

// Response
{
  chat: [...],           // messages[from_index..from_index+limit]
  chat_metadata: {...},  // always included (header)
  from_index: 450,
  next_index: 500,
  total_messages: 500,
  has_more: false,
  integrity: "uuid"      // current integrity slug
}
```

**用途**：
1. Show More 按钮可按需从服务端加载历史（如前端只缓存最近 N 条）
2. 页面刷新时配合 sessionStorage 缓存做增量拉取
3. 扩展可用于按需读取历史片段

### 2.2 Bootstrap 聚合端点

**端点**：`POST /api/bootstrap`

```js
// Response
{
  avatars: [...],       // 头像文件名列表
  settings: {...}       // 用户设置
}
```

**效果**：头像列表 + 设置两个请求合一，节省 1 RTT（~150ms）。

### 2.3 前端 fast-load.js 模块

提供以下 API 供渐进式集成：
- `fetchChatDelta({ avatarUrl, fileName, fromIndex, limit })` → 加载消息范围
- `fetchGroupChatDelta({ groupChatId, fromIndex, limit })` → 群聊消息范围
- `loadChatTail({ ..., tailSize })` → 智能尾部加载（先探测总数，再取最后 N 条）
- `fetchBootstrap()` → 聚合启动数据

## 渐进式集成建议

这些端点已就绪，可以在以下场景渐进式接入：

| 场景 | 接入方式 | 节省 |
|------|----------|------|
| 启动时获取头像列表 | 用 `fetchBootstrap()` 替代单独 avatars 请求 | 1 RTT |
| 超长聊天（500+ 条）首次打开 | 用 `loadChatTail(50)` 先渲染尾部，再懒加载 | 首屏时间大幅降低 |
| Show More 按钮 | 配合 get-delta 从服务端按需分页 | 减少初始加载量 |
| 页面刷新/F5 | sessionStorage 缓存 + get-delta 增量拉取 | 避免全量重传 |

## 未来扩展

### 2.4 基于 sessionStorage 的增量重加载（Phase 2.5）

```
// 页面卸载前
sessionStorage.set('chat_cache', { integrity, chatLength, chatId })

// 页面加载时
if (sessionStorage has valid cache for this chat) {
  load cached messages + fetchChatDelta(from: cachedLength)
} else {
  full load (existing path)
}
```

### 2.5 characters + groups 加入 bootstrap（Phase 3）

当前 bootstrap 只包含轻量数据（avatars + settings），避免干扰 characters/groups
的复杂初始化逻辑（tags、排序等）。未来可以在充分测试后纳入。
