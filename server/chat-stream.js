function streamError(code, message, details = '') {
  return Object.assign(new Error(message), { code, details, status: 502 });
}

function eventData(event) {
  return event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
}

async function* readSseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const data = eventData(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (data) yield data;
      }
      if (done) {
        ended = true;
        const data = eventData(buffer);
        if (data) yield data;
        break;
      }
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Text is forwarded immediately; tool arguments are assembled before any tool runs.
export async function readChatCompletionStream(response, onToken) {
  if (!response.body) throw streamError('MODEL_STREAM_EMPTY', '模型没有返回可读取的数据流');

  let content = '';
  let finishReason = null;
  let completed = false;
  const calls = new Map();

  for await (const data of readSseData(response.body)) {
    if (data.trim() === '[DONE]') {
      completed = true;
      break;
    }

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw streamError('MODEL_STREAM_INVALID', '模型返回了无效的流式数据');
    }
    if (chunk.error) {
      throw streamError('MODEL_STREAM_ERROR', '模型流式输出失败', chunk.error.message || JSON.stringify(chunk.error));
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue; // Some providers send a final usage-only chunk.
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onToken(delta.content);
    }

    for (const fragment of delta.tool_calls || []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0) {
        throw streamError('MODEL_TOOL_INVALID', '模型返回的工具调用缺少有效索引');
      }
      let call = calls.get(fragment.index);
      if (!call) {
        call = { id: '', type: 'function', function: { name: '', arguments: '' } };
        calls.set(fragment.index, call);
      }
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
    }
  }

  if (!completed && !finishReason) {
    throw streamError('MODEL_STREAM_INTERRUPTED', '模型输出意外中断，请重试');
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.length && finishReason !== 'tool_calls') {
    throw streamError('MODEL_TOOL_INCOMPLETE', '模型的工具调用未完整生成，请重试');
  }
  for (const call of toolCalls) {
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      throw streamError('MODEL_TOOL_INVALID', '模型返回的工具参数不是完整 JSON');
    }
    if (!call.id || !call.function.name || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw streamError('MODEL_TOOL_INVALID', '模型返回的工具调用格式无效');
    }
  }
  return { content, toolCalls };
}

export async function runStreamingChat({
  messages, tools, requestCompletion, executeTool, onEvent, signal, maxToolRounds = 4
}) {
  const citations = [];
  const executedTools = [];

  // After the tool budget, make one final streaming request without tools.
  for (let round = 0; round <= maxToolRounds; round += 1) {
    signal?.throwIfAborted();
    const allowTools = round < maxToolRounds && tools.length > 0;
    const response = await requestCompletion({
      stream: true,
      messages,
      ...(allowTools ? { tools, tool_choice: 'auto' } : {})
    });
    signal?.throwIfAborted();
    const { content, toolCalls } = await readChatCompletionStream(response, (token) => {
      signal?.throwIfAborted();
      onEvent('token', { token });
      signal?.throwIfAborted();
    });
    signal?.throwIfAborted();

    if (!toolCalls.length) {
      onEvent('done', { citations, tools: executedTools });
      return;
    }
    if (!allowTools) throw streamError('MODEL_TOOL_LIMIT', '模型超出了工具调用次数限制');

    messages.push({ role: 'assistant', content, tool_calls: toolCalls });
    for (const call of toolCalls) {
      signal?.throwIfAborted();
      const args = JSON.parse(call.function.arguments || '{}');
      onEvent('tool', { id: call.id, name: call.function.name, args, status: 'running' });
      signal?.throwIfAborted();
      const executed = await executeTool(call);
      signal?.throwIfAborted();
      const status = executed.isError ? 'error' : 'success';
      citations.push(...executed.citations);
      executedTools.push({ id: call.id, name: call.function.name, args: executed.args, status, result: executed.resultText });
      onEvent('tool', { id: call.id, name: call.function.name, args: executed.args, status, result: executed.resultPayload });
      if (executed.citations.length) onEvent('citations', { citations: executed.citations });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(executed.resultPayload) });
    }
  }
}
