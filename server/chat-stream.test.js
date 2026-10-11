import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatCompletionStream, runStreamingChat } from './chat-stream.js';

const encoder = new TextEncoder();
const tools = [{ type: 'function', function: { name: 'retrieve_knowledge' } }];
const chunk = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;

function responseFor(events, { byteSize = Infinity, crlf = false, done = true } = {}) {
  let text = events.map(frame).join('') + (done ? frame('[DONE]') : '');
  if (crlf) text = text.replaceAll('\n', '\r\n');
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += byteSize) {
        controller.enqueue(bytes.slice(offset, offset + byteSize));
      }
      controller.close();
    }
  }));
}

const textResponse = (...parts) => responseFor([
  ...parts.map((content) => chunk({ content })), chunk({}, 'stop')
]);

function toolResponse(id = 'call_1') {
  return responseFor([
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'retrieve_', arguments: '{"query":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: 'knowledge', arguments: '"奖学金"}' } }] }),
    chunk({}, 'tool_calls')
  ]);
}

function toolResult(call, overrides = {}) {
  const resultPayload = { citations: [{ id: 'source_1', title: '评选要求' }] };
  return {
    args: JSON.parse(call.function.arguments), isError: false,
    resultText: JSON.stringify(resultPayload), resultPayload, citations: resultPayload.citations,
    ...overrides
  };
}

test('ordinary answers arrive before upstream finishes and use only one streaming request', async () => {
  let upstream;
  let firstToken;
  const first = new Promise((resolve) => { firstToken = resolve; });
  const response = new Response(new ReadableStream({ start(controller) { upstream = controller; } }));
  const requests = [];
  const events = [];
  const task = runStreamingChat({
    messages: [{ role: 'user', content: '你好' }], tools,
    requestCompletion: async (body) => { requests.push(body); return response; },
    executeTool: () => assert.fail('ordinary answers must not execute tools'),
    onEvent: (event, data) => { events.push({ event, data }); if (event === 'token') firstToken(); }
  });

  upstream.enqueue(encoder.encode(frame(chunk({ content: '你好' }))));
  await first;
  assert.deepEqual(events, [{ event: 'token', data: { token: '你好' } }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);

  upstream.enqueue(encoder.encode(frame(chunk({ content: '，世界' })) + frame(chunk({}, 'stop')) + frame('[DONE]')));
  upstream.close();
  await task;
  assert.deepEqual(events.map(({ event }) => event), ['token', 'token', 'done']);
  assert.equal(requests.length, 1);
});

test('SSE handles split UTF-8 bytes, CRLF boundaries, comments and usage-only events', async () => {
  const tokens = [];
  const result = await readChatCompletionStream(responseFor([
    chunk({ content: '奖学金😀' }), { choices: [], usage: { total_tokens: 12 } }, chunk({}, 'stop')
  ], { byteSize: 1, crlf: true }), (token) => tokens.push(token));
  assert.equal(result.content, '奖学金😀');
  assert.deepEqual(tokens, ['奖学金😀']);
  const commentResponse = new Response(': heartbeat\n\n' + frame(chunk({ content: 'ok' })) + frame(chunk({}, 'stop')) + 'data: [DONE]');
  assert.equal((await readChatCompletionStream(commentResponse, () => {})).content, 'ok');
});

test('interleaved tool calls keep separate argument buffers and execute in index order', async () => {
  const result = await readChatCompletionStream(responseFor([
    chunk({ tool_calls: [
      { index: 1, id: 'call_second', function: { name: 'get_current_time', arguments: '{' } },
      { index: 0, id: 'call_first', function: { name: 'retrieve_knowledge', arguments: '{"query":"奖' } }
    ] }),
    chunk({ tool_calls: [
      { index: 0, id: '', function: { arguments: '学金"}' } },
      { index: 1, function: { arguments: '}' } }
    ] }), chunk({}, 'tool_calls')
  ], { byteSize: 7 }), () => {});
  assert.deepEqual(result.toolCalls.map((call) => [call.id, JSON.parse(call.function.arguments)]), [
    ['call_first', { query: '奖学金' }], ['call_second', {}]
  ]);
});

test('tools wait for complete arguments, results return to the model, and the answer streams with citations', async () => {
  const requests = [];
  const events = [];
  const executed = [];
  await runStreamingChat({
    messages: [{ role: 'user', content: '奖学金要求是什么' }], tools,
    requestCompletion: async (body) => {
      requests.push(structuredClone(body));
      return requests.length === 1 ? toolResponse() : textResponse('申请条件', '如下');
    },
    executeTool: async (call) => { executed.push(call); return toolResult(call); },
    onEvent: (event, data) => events.push({ event, data })
  });
  assert.equal(requests.length, 2);
  assert(requests.every((request) => request.stream === true));
  assert.equal(executed.length, 1);
  assert.equal(executed[0].function.name, 'retrieve_knowledge');
  assert.equal(executed[0].function.arguments, '{"query":"奖学金"}');
  assert.deepEqual(requests[1].messages.map((message) => message.role), ['user', 'assistant', 'tool']);
  assert.equal(requests[1].messages[2].tool_call_id, 'call_1');
  assert.deepEqual(events.map(({ event }) => event), ['tool', 'tool', 'citations', 'token', 'token', 'done']);
  assert.equal(events.at(-1).data.citations[0].id, 'source_1');
  assert.equal(events.at(-1).data.tools[0].status, 'success');
});

test('four tool rounds are followed by one streaming answer without tools', async () => {
  const requests = [];
  const executed = [];
  const events = [];
  await runStreamingChat({
    messages: [], tools,
    requestCompletion: async (body) => {
      requests.push(structuredClone(body));
      return requests.length <= 4 ? toolResponse(`call_${requests.length}`) : textResponse('最终', '答案');
    },
    executeTool: async (call) => { executed.push(call); return toolResult(call); },
    onEvent: (event, data) => events.push({ event, data })
  });
  assert.equal(executed.length, 4);
  assert.equal(requests.length, 5);
  assert(requests.every((request) => request.stream));
  assert.equal(requests[4].tools, undefined);
  assert.equal(requests[4].tool_choice, undefined);
  assert.deepEqual(events.filter(({ event }) => event === 'token').map(({ data }) => data.token), ['最终', '答案']);
  assert.equal(events.filter(({ event }) => event === 'done').length, 1);
});

test('invalid or truncated tool arguments never execute a tool', async () => {
  for (const [args, finishReason, done, code] of [
    ['{"query":', 'tool_calls', true, 'MODEL_TOOL_INVALID'],
    ['{"query":"完整"}', null, false, 'MODEL_STREAM_INTERRUPTED'],
    ['{"query":"截断"}', 'length', true, 'MODEL_TOOL_INCOMPLETE']
  ]) {
    await assert.rejects(runStreamingChat({
      messages: [], tools,
      requestCompletion: async () => responseFor([
        chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'retrieve_knowledge', arguments: args } }] }),
        ...(finishReason ? [chunk({}, finishReason)] : [])
      ], { done }),
      executeTool: () => assert.fail('incomplete tool calls must not execute'),
      onEvent: () => {}
    }), { code });
  }
});

test('upstream error events and malformed JSON fail instead of reporting successful completion', async () => {
  await assert.rejects(readChatCompletionStream(responseFor([{ error: { message: 'quota exceeded' } }]), () => {}), {
    code: 'MODEL_STREAM_ERROR', details: 'quota exceeded'
  });
  await assert.rejects(readChatCompletionStream(new Response('data: {invalid}\n\n'), () => {}), {
    code: 'MODEL_STREAM_INVALID'
  });
});

test('tool failures are shown and returned to the model so it can explain the failure', async () => {
  let requestCount = 0;
  const events = [];
  await runStreamingChat({
    messages: [], tools,
    requestCompletion: async (body) => {
      if (++requestCount === 1) return toolResponse();
      assert.equal(JSON.parse(body.messages.at(-1).content).message, '检索失败');
      return textResponse('暂时无法检索');
    },
    executeTool: async (call) => toolResult(call, {
      isError: true, resultPayload: { message: '检索失败' }, resultText: '检索失败', citations: []
    }),
    onEvent: (event, data) => events.push({ event, data })
  });
  assert.equal(events[1].data.status, 'error');
  assert.equal(events.at(-1).data.tools[0].status, 'error');
});

test('aborting during tool execution prevents further model requests and output', async () => {
  const controller = new AbortController();
  let requests = 0;
  const events = [];
  await assert.rejects(runStreamingChat({
    messages: [], tools, signal: controller.signal,
    requestCompletion: async () => { requests++; return toolResponse(); },
    executeTool: async (call) => { controller.abort(); return toolResult(call); },
    onEvent: (event) => events.push(event)
  }), { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.deepEqual(events, ['tool']);
});

test('aborting on a text fragment cancels the upstream reader and emits no done event', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode(frame(chunk({ content: '第一段' })))); },
    cancel() { cancelled = true; }
  }));
  const events = [];
  await assert.rejects(runStreamingChat({
    messages: [], tools, signal: controller.signal,
    requestCompletion: async () => response,
    executeTool: () => assert.fail('unexpected tool call'),
    onEvent: (event) => { events.push(event); controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.deepEqual(events, ['token']);
});
