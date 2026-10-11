# HTTP API 与 MCP 协议

开发 Base URL：`http://127.0.0.1:8787`。当前不使用账号、Cookie 或 Bearer 登录认证，知识库对应配置的同一个 Chroma 集合。

普通业务错误结构为：

```json
{
  "error": "加载知识库失败",
  "code": "CHROMA_UNAVAILABLE",
  "details": "请先启动本地 Chroma 服务，并检查连接配置。"
}
```

Express 默认 JSON 解析或 Multer 层错误未统一为这一结构。JSON 请求体上限为 4 MB，此限制不等于 multipart 上传文件限制；当前上传没有配置文件大小与数量限制。

## 1. 健康检查

### `GET /api/health`

通过 MCP 调用 `list_knowledge_documents`，会访问 Chroma。成功 HTTP 200：

```json
{ "ok": true, "documents": 4, "mcp": true }
```

不验证 Qwen API Key 或模型可用性。失败响应还包含 `ok: false`；Chroma 不可用通常返回 503。

## 2. 文档列表

### `GET /api/knowledge`

成功 HTTP 200：

```json
{
  "documents": [
    {
      "id": "doc-example-id",
      "name": "popo-guide.md",
      "createdAt": 1791676800000,
      "fileType": "md",
      "chunkCount": 3
    }
  ]
}
```

ID、时间与数量是示例值。`createdAt` 为毫秒时间戳，空知识库返回空数组。

## 3. 上传并入库

### `POST /api/knowledge/upload`

请求使用 `multipart/form-data`，重复使用 `files` 字段上传多个文件。浏览器 FormData 应自行生成 boundary，不要手动把 Content-Type 固定为无 boundary 的字符串。

```javascript
const data = new FormData()
for (const file of selectedFiles) data.append('files', file)
const response = await fetch('/api/knowledge/upload', {
  method: 'POST',
  body: data
})
```

PowerShell 可调用系统 curl：

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/knowledge/upload -F "files=@examples/popo-guide.md"
```

支持 `.md`、`.markdown`、`.txt`、`.pdf`、`.docx`。TXT / Markdown 要求 UTF-8；PDF 要求存在可提取文本层。

成功 HTTP 200：

```json
{
  "documents": [
    {
      "id": "doc-example-id",
      "name": "popo-guide.md",
      "createdAt": 1791676800000,
      "fileType": "md",
      "chunkCount": 3
    }
  ],
  "message": "已成功导入 1 份知识文件。"
}
```

处理链路：解析全部文件 → MCP 结构化分块 → 逐块 Qwen Embedding → Chroma 批量写入 → 更新内存 BM25 索引。原始文件没有作为文件附件持久化，保留的是文本片段及来源元数据。重复上传会生成新文档 ID，当前没有内容去重。

## 4. 删除文档

### `DELETE /api/knowledge/:id`

按 `documentId` 删除 Chroma 切片，更新内存列表和 BM25。成功返回：

```json
{ "ok": true }
```

此操作实际删除数据，没有回收站。

## 5. 清空知识库

### `DELETE /api/knowledge`

删除当前 Chroma 集合内全部切片并清空内存状态，成功返回 `{ "ok": true }`。集合名由 `CHROMA_COLLECTION` 配置。

## 6. 流式对话

### `POST /api/chat/stream`

Content-Type：`application/json`。

```json
{
  "messages": [
    { "role": "system", "content": "请结合知识库回答并说明来源。" },
    { "role": "user", "content": "知识库重启后还在吗？" }
  ]
}
```

前端一般提交最近 12 条用户/助手消息并添加当前提示词。后端另加 Agent 系统提示。当前接口没有完整的请求消息 Schema 校验。

响应类型为 `text/event-stream; charset=utf-8`，每条事件以空行结束：

```text
event: token
data: {"token":"根据文档，"}

event: tool
data: {"id":"call-example","name":"retrieve_knowledge","args":{"query":"知识库持久化"},"status":"running"}

event: citations
data: {"citations":[]}

event: done
data: {"citations":[],"tools":[]}
```

事件顺序由模型决定；普通回答可以没有工具事件。实际引用和工具结果并非固定为空，上面只展示传输格式。

| 事件 | 字段 | 含义 |
| --- | --- | --- |
| `token` | `token` | 立即追加文本 |
| `tool` | `id`、`name`、`args`、`status`、可选 `result` | 执行前 running，结束后 success/error |
| `citations` | `citations` | 某次工具返回的来源 |
| `done` | `citations`、`tools` | 当前回答的来源与工具汇总 |
| `error` | `code`、`message`、`details` | 当前流运行失败 |

服务端提前发送 SSE 响应头，并设置 `X-Accel-Buffering: no`。之后发生的模型/工具错误通过 `error` 事件返回，HTTP 200 本身不代表回答成功。

前端可通过 AbortController 停止请求；后端监听连接关闭，将 signal 传递给模型 fetch 与 MCP 调用。中断后不再发送 done，也不继续执行后续轮次；已完成写操作不会撤销。

### 引用对象

```json
{
  "id": "chunk-example-id",
  "title": "使用指南.pdf",
  "snippet": "保留数据目录即可恢复知识库……",
  "source": "混合检索 / 使用指南.pdf / 第 2 页（向量 #1 · BM25 #2）",
  "score": 0.0325,
  "retrieval": {
    "vectorRank": 1,
    "vectorScore": 0.81,
    "keywordRank": 2,
    "bm25Score": 2.7,
    "rrfScore": 0.0325
  }
}
```

这是示例结构。未被某路召回时，对应排名与分数为 null；`score` 是 RRF 分数，不是置信概率。页码来自 PDF，章节来自 Markdown / DOCX，纯文本与 DOCX 不提供页码定位。

## MCP 工具

MCP Server 通过 stdio 与 Express 通信，没有另外暴露 HTTP MCP 端口。

| 工具 | 输入 |
| --- | --- |
| `retrieve_knowledge` | `{ query: string, topK?: number }`；query 非空，topK 为 1～10 整数，默认 4 |
| `list_knowledge_documents` | `{}` |
| `ingest_knowledge_documents` | `{ documents: [{ name, fileType?, content?, blocks? }] }`，至少一项 |
| `delete_knowledge_document` | `{ id: string }`，非空 |
| `clear_knowledge_documents` | `{}` |
| `get_current_time` | `{}` |

`blocks` 包含 `text`、可选 `type`、`heading`、`pageStart`、`pageEnd`。HTTP 文件解析后将结构块交给 MCP；其结果使用文本 content 与 structuredContent，业务错误带 `isError: true`。

所有工具当前都会作为模型可用工具，包含知识库写操作。没有基于用户、角色或二次确认的工具权限层。

## 常见错误

| code | 常见状态 | 含义 |
| --- | --- | --- |
| `UNSUPPORTED_FILE` / `UNSUPPORTED_FILES` | 400 | 格式不支持 |
| `INVALID_TEXT_ENCODING` | 400 | TXT / Markdown 不是有效 UTF-8 |
| `EMPTY_DOCUMENT` / `EMPTY_FILES` | 400 | 未提取到正文 |
| `SCANNED_PDF_UNSUPPORTED` | 400 | PDF 无足够文本，当前不做 OCR |
| `PDF_PARSE_FAILED` / `DOCX_PARSE_FAILED` | 400 | 文档解析失败 |
| `CHROMA_UNAVAILABLE` | 503 | 向量库连接、查询或写入失败 |
| `MISSING_API_KEY` | 500 | 未配置模型 Key |
| `INVALID_API_KEY` | 401 | 上游拒绝 Key |
| `RATE_LIMITED` | 429 | 上游调用频率或配额限制 |
| `NETWORK_UNREACHABLE` / `QWEN_HTTP_ERROR` | 502 | 模型网络或 HTTP 错误 |
| `MODEL_STREAM_*` / `MODEL_TOOL_*` | SSE error | 流内容或工具参数异常 |

模型 Key 不需要也不应该由浏览器随每次请求传入，后端从环境变量读取。
