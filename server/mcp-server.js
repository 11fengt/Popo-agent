import dotenv from 'dotenv';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const state = {
  documents: [],
  chunks: []
};

const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3'
};

function uid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

function tokenize(input) {
  return input
    .toLowerCase()
    .replace(/[`*_>#\-\[\]\(\)]/g, ' ')
    .split(/[\s，。；：！？、,.!?;:\/\\|]+/)
    .filter((token) => token.length > 1);
}

function chunkText(text, chunkSize = 900, overlap = 160) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const value = text.slice(start, end).trim();
    if (value) chunks.push(value);
    start += chunkSize - overlap;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < len; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function qwenFetch(endpoint, body) {
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

  return response.json();
}

async function createEmbedding(text) {
  const result = await qwenFetch('/embeddings', {
    model: config.embeddingModel,
    input: text.slice(0, 6000)
  });

  const vector = result.data?.[0]?.embedding;
  if (!vector) {
    throw createAppError('EMBEDDING_EMPTY', 'Embedding 生成失败', '模型返回为空，无法建立向量索引。', 502);
  }

  return vector;
}

function buildCitation(chunk, score) {
  return {
    id: chunk.id,
    title: chunk.documentName,
    snippet: chunk.text,
    source: `向量知识库 / ${chunk.documentName}`,
    score: Number(score.toFixed(4))
  };
}

async function searchKnowledge(query, topK = 4) {
  if (!state.chunks.length) {
    return [];
  }

  const queryEmbedding = await createEmbedding(query);
  return state.chunks
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .filter((item) => item.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => buildCitation(chunk, score));
}

async function ingestDocuments(documents) {
  const supported = documents.filter((document) => /\.(txt|md|markdown|json)$/i.test(document.name));

  if (!supported.length) {
    throw createAppError('UNSUPPORTED_FILES', '没有可导入的知识文件', '仅支持 `.md`、`.markdown`、`.txt`、`.json` 文件。', 400);
  }

  const inserted = [];
  const nextDocuments = [];
  const nextChunks = [];

  for (const source of supported) {
    const content = source.content.trim();
    if (!content) continue;

    const document = {
      id: uid('doc'),
      name: source.name,
      content,
      createdAt: Date.now()
    };

    nextDocuments.push(document);
    inserted.push({ id: document.id, name: document.name, createdAt: document.createdAt });

    const parts = chunkText(content);
    for (const part of parts) {
      const embedding = await createEmbedding(part);
      nextChunks.push({
        id: uid('chunk'),
        documentId: document.id,
        documentName: document.name,
        text: part,
        tokens: tokenize(part),
        embedding
      });
    }
  }

  if (!inserted.length) {
    throw createAppError('EMPTY_FILES', '上传的文件内容为空', '请确认文件不是空文件，且编码为 UTF-8。', 400);
  }

  state.documents.push(...nextDocuments);
  state.chunks.push(...nextChunks);

  return inserted;
}

function listDocuments() {
  return state.documents.map((document) => ({
    id: document.id,
    name: document.name,
    createdAt: document.createdAt
  }));
}

function deleteDocument(id) {
  const before = state.documents.length;
  state.documents = state.documents.filter((document) => document.id !== id);
  state.chunks = state.chunks.filter((chunk) => chunk.documentId !== id);

  if (before === state.documents.length) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }

  return { ok: true, id };
}

function clearDocuments() {
  state.documents = [];
  state.chunks = [];
  return { ok: true };
}

function toTextContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

function toErrorContent(error) {
  return {
    content: [
      {
        type: 'text',
        text: error.details ? `${error.message}\n${error.details}` : error.message
      }
    ],
    structuredContent: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      details: error.details || ''
    },
    isError: true
  };
}

const server = new McpServer({
  name: 'yuan-agent-mcp-server',
  version: '1.0.0'
});

server.registerTool(
  'retrieve_knowledge',
  {
    description: '从后端向量知识库检索与用户问题最相关的文档片段',
    inputSchema: z.object({
      query: z.string().min(1, 'query 不能为空'),
      topK: z.number().int().min(1).max(10).optional()
    })
  },
  async ({ query, topK = 4 }) => {
    try {
      const citations = await searchKnowledge(query, topK);
      return toTextContent({ citations, count: citations.length });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'list_knowledge_documents',
  {
    description: '列出当前后端知识库中的文档',
    inputSchema: z.object({})
  },
  async () => toTextContent({ documents: listDocuments() })
);

server.registerTool(
  'ingest_knowledge_documents',
  {
    description: '导入知识文档到向量知识库中并建立向量索引',
    inputSchema: z.object({
      documents: z.array(
        z.object({
          name: z.string().min(1, 'name 不能为空'),
          content: z.string().min(1, 'content 不能为空')
        })
      ).min(1, '至少导入一份文档')
    })
  },
  async ({ documents }) => {
    try {
      const inserted = await ingestDocuments(documents);
      return toTextContent({ documents: inserted, message: `已成功导入 ${inserted.length} 份知识文件。` });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'delete_knowledge_document',
  {
    description: '删除指定的知识文档以及对应的向量索引',
    inputSchema: z.object({
      id: z.string().min(1, 'id 不能为空')
    })
  },
  async ({ id }) => {
    try {
      return toTextContent(deleteDocument(id));
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'clear_knowledge_documents',
  {
    description: '清空知识库中的所有文档与向量索引',
    inputSchema: z.object({})
  },
  async () => toTextContent(clearDocuments())
);

server.registerTool(
  'get_current_time',
  {
    description: '获取当前系统时间',
    inputSchema: z.object({})
  },
  async () =>
    toTextContent({
      iso: new Date().toISOString(),
      locale: new Date().toLocaleString('zh-CN', { hour12: false })
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
