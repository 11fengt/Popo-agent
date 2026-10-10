import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '4mb' }));

const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  model: process.env.QWEN_MODEL || 'qwen-plus',
  port: Number(process.env.SERVER_PORT || 8787)
};

function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

function getErrorPayload(error, fallbackMessage) {
  if (error && typeof error === 'object' && 'message' in error) {
    return {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message || fallbackMessage,
      details: error.details || '',
      status: error.status || 500
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: fallbackMessage,
    details: '',
    status: 500
  };
}

async function qwenFetch(endpoint, body, stream = false) {
  if (!config.apiKey) {
    throw createAppError('MISSING_API_KEY', '缺少 Qwen API Key', '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。', 500);
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw createAppError(
      'NETWORK_UNREACHABLE',
      '无法连接到 Qwen 服务',
      '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
      502
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw createAppError('INVALID_API_KEY', 'Qwen API Key 无效或已过期', text || '请检查 `QWEN_API_KEY` 是否正确。', 401);
    }

    if (response.status === 429) {
      throw createAppError('RATE_LIMITED', 'Qwen 请求过于频繁', text || '请稍后重试，或检查账户配额是否充足。', 429);
    }

    throw createAppError('QWEN_HTTP_ERROR', `Qwen 请求失败（${response.status}）`, text || '上游模型服务返回异常响应。', 502);
  }

  if (stream) {
    return response;
  }

  return response.json();
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

let mcpSessionPromise = null;

async function createMcpSession() {
  if (mcpSessionPromise) {
    return mcpSessionPromise;
  }

  mcpSessionPromise = (async () => {
    const client = new McpClient({
      name: 'yuan-agent-chat-orchestrator',
      version: '1.0.0'
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, './mcp-server.js')],
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'development'
      },
      stderr: 'pipe'
    });

    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[mcp-server] ${message}`);
        }
      });
    }

    await client.connect(transport);

    const session = {
      client,
      transport,
      async close() {
        mcpSessionPromise = null;
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    };

    return session;
  })().catch((error) => {
    mcpSessionPromise = null;
    throw error;
  });

  return mcpSessionPromise;
}

function normalizeStructuredContent(result) {
  if (result && typeof result === 'object' && 'structuredContent' in result && result.structuredContent) {
    return result.structuredContent;
  }
  if (result && typeof result === 'object' && 'toolResult' in result) {
    return result.toolResult;
  }
  return {};
}

function contentToText(result) {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    return '';
  }

  return result.content
    .filter((item) => item && typeof item === 'object' && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

function buildToolDefinitions(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {}
      }
    }
  }));
}

async function executeToolCallWithMcp(client, toolCall) {
  const name = toolCall.function?.name || 'unknown';
  const args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
  const result = await client.callTool({
    name,
    arguments: args
  });

  const structured = normalizeStructuredContent(result);
  const text = contentToText(result);
  const isError = !!(result && typeof result === 'object' && 'isError' in result && result.isError);

  return {
    args,
    isError,
    resultText: text || JSON.stringify(structured, null, 2),
    resultPayload: structured,
    citations: Array.isArray(structured?.citations) ? structured.citations : []
  };
}

app.get('/api/health', async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'list_knowledge_documents',
      arguments: {}
    });

    const structured = normalizeStructuredContent(result);
    res.json({
      ok: true,
      documents: Array.isArray(structured.documents) ? structured.documents.length : 0,
      mcp: true
    });
  } catch (error) {
    const payload = getErrorPayload(error, 'MCP 健康检查失败');
    res.status(payload.status).json({
      ok: false,
      code: payload.code,
      error: payload.message,
      details: payload.details
    });
  }
});

app.get('/api/knowledge', async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'list_knowledge_documents',
      arguments: {}
    });

    const structured = normalizeStructuredContent(result);
    res.json({
      documents: structured.documents || []
    });
  } catch (error) {
    const payload = getErrorPayload(error, '加载知识库失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.post('/api/knowledge/upload', upload.array('files'), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'ingest_knowledge_documents',
      arguments: {
        documents: files.map((file) => ({
          name: file.originalname,
          content: file.buffer.toString('utf-8')
        }))
      }
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '知识库导入失败', structured.details || '', 400);
    }

    res.json({
      documents: structured.documents || [],
      message: structured.message || '上传成功'
    });
  } catch (error) {
    const payload = getErrorPayload(error, '知识库导入失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'delete_knowledge_document',
      arguments: { id: req.params.id }
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '删除失败', structured.details || '', 400);
    }

    res.json({ ok: true });
  } catch (error) {
    const payload = getErrorPayload(error, '删除失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.delete('/api/knowledge', async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'clear_knowledge_documents',
      arguments: {}
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '清空失败', structured.details || '', 400);
    }

    res.json({ ok: true });
  } catch (error) {
    const payload = getErrorPayload(error, '清空失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.post('/api/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const session = await createMcpSession();
    const availableTools = await session.client.listTools();
    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = [
      {
        role: 'system',
        content: [
          '你是一个中文 Agent 助手。',
          '你可以通过 MCP 工具检索知识库、查看文档列表、导入或删除文档、获取当前时间。',
          '当用户的问题依赖知识库内容时，优先调用 retrieve_knowledge。',
          '最终回答需要清晰、结构化、简洁。'
        ].join('\n')
      },
      ...incomingMessages
    ];

    const gatheredCitations = [];
    const gatheredTools = [];
    const toolDefinitions = buildToolDefinitions(availableTools.tools || []);

    for (let round = 0; round < 4; round += 1) {
      const completion = await qwenFetch('/chat/completions', {
        model: config.model,
        stream: false,
        temperature: 0.4,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto'
      });

      const choice = completion.choices?.[0]?.message;
      const toolCalls = choice?.tool_calls || [];

      if (!toolCalls.length) {
        if (choice) {
          messages.push(choice);
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: choice.content || '',
        tool_calls: toolCalls
      });

      for (const toolCall of toolCalls) {
        const previewArgs = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        sendSse(res, 'tool', {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: previewArgs,
          status: 'running'
        });

        const executed = await executeToolCallWithMcp(session.client, toolCall);

        gatheredCitations.push(...executed.citations);
        gatheredTools.push({
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? 'error' : 'success',
          result: executed.resultText
        });

        sendSse(res, 'tool', {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? 'error' : 'success',
          result: executed.resultPayload
        });

        if (executed.citations.length) {
          sendSse(res, 'citations', { citations: executed.citations });
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(executed.resultPayload)
        });
      }
    }

    const streamResponse = await qwenFetch('/chat/completions', {
      model: config.model,
      stream: true,
      temperature: 0.4,
      messages
    }, true);

    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const lines = event.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') {
            sendSse(res, 'done', { citations: gatheredCitations, tools: gatheredTools });
            res.end();
            return;
          }

          try {
            const json = JSON.parse(raw);
            const token = json.choices?.[0]?.delta?.content;
            if (token) {
              sendSse(res, 'token', { token });
            }
          } catch {
            // ignore invalid chunks
          }
        }
      }
    }

    sendSse(res, 'done', { citations: gatheredCitations, tools: gatheredTools });
    res.end();
  } catch (error) {
    const payload = getErrorPayload(error, '服务异常');
    sendSse(res, 'error', {
      code: payload.code,
      message: payload.message,
      details: payload.details
    });
    res.end();
  }
});

app.use(express.static(path.resolve(__dirname, '../dist')));
app.get('*', (_, res) => {
  res.sendFile(path.resolve(__dirname, '../dist/index.html'));
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Server running at http://127.0.0.1:${config.port}`);
});
