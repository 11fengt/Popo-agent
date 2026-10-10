import type { ApiErrorPayload, BackendStreamEvent, QwenMessage, ServerDocumentResponse } from '@/types/chat';

function formatApiError(payload: Partial<ApiErrorPayload>, fallback: string) {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

function parseSseChunk(chunk: string) {
  const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
  const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim() || '{}';
  return { event, data };
}

export async function streamAgentChat(
  messages: QwenMessage[],
  onEvent: (event: BackendStreamEvent) => void,
  signal?: AbortSignal
) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages }),
    signal
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `请求失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }

    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split('\n\n');
    buffer = segments.pop() ?? '';

    for (const segment of segments) {
      const { event, data } = parseSseChunk(segment);
      const payload = JSON.parse(data);

      if (event === 'token') {
        onEvent({ type: 'token', token: payload.token });
      }

      if (event === 'tool') {
        onEvent({
          type: 'tool',
          tool: {
            id: payload.id,
            name: payload.name,
            args: payload.args || {},
            status: payload.status,
            result:
              typeof payload.result === 'string'
                ? payload.result
                : payload.result
                  ? JSON.stringify(payload.result, null, 2)
                  : undefined
          }
        });
      }

      if (event === 'citations') {
        onEvent({ type: 'citations', citations: payload.citations || [] });
      }

      if (event === 'error') {
        onEvent({
          type: 'error',
          message: payload.message || '请求失败',
          details: payload.details,
          code: payload.code
        });
      }

      if (event === 'done') {
        onEvent({ type: 'done', citations: payload.citations || [], tools: payload.tools || [] });
      }
    }
  }
}

export async function fetchKnowledgeDocuments(): Promise<ServerDocumentResponse[]> {
  const response = await fetch('/api/knowledge');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(formatApiError(data, '加载知识库失败'));
  }

  return data.documents || [];
}

export async function uploadKnowledgeDocuments(files: FileList | File[]): Promise<ServerDocumentResponse[]> {
  const formData = new FormData();
  Array.from(files).forEach((file) => formData.append('files', file));

  const response = await fetch('/api/knowledge/upload', {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '上传失败'));
  }

  return data.documents || [];
}

export async function deleteKnowledgeDocument(id: string) {
  const response = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    let data: Partial<ApiErrorPayload> = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatApiError(data, '删除失败'));
  }
}

export async function clearKnowledgeDocuments() {
  const response = await fetch('/api/knowledge', { method: 'DELETE' });
  if (!response.ok) {
    let data: Partial<ApiErrorPayload> = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatApiError(data, '清空失败'));
  }
}
