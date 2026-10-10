import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  clearKnowledgeDocuments,
  deleteKnowledgeDocument,
  fetchKnowledgeDocuments,
  streamAgentChat,
  uploadKnowledgeDocuments
} from '@/services/qwen';
import type { ChatMessage, ChatSession, KnowledgeDocument, QwenMessage, ToolInvocation } from '@/types/chat';

const SESSION_STORAGE_KEY = 'yuan-agent-chat-sessions-v2';
const ACTIVE_SESSION_KEY = 'yuan-agent-active-session-id-v2';

// 流式响应期间，最多每200ms持久化一次
const PERSIST_INTERVAL_MS = 200;

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: uid(role),
    role,
    content,
    createdAt: Date.now(),
    status: 'idle'
  };
}

function createInitialAssistantMessage(content: string) {
  const message = createMessage('assistant', content);
  message.status = 'done';
  return message;
}

function createSession(title = '新对话'): ChatSession {
  const now = Date.now();
  return {
    id: uid('session'),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [createInitialAssistantMessage('你好，我是你的 Popo 私人小助手。你可以直接提问，也可以先上传资料，让我通过后端向量检索结合工具调用来回答。')]
  };
}

function toConversationMessages(messages: ChatMessage[]): QwenMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content
    }));
}

function mergeTool(tools: ToolInvocation[], nextTool: ToolInvocation) {
  const current = tools.find((item) => item.id === nextTool.id);
  if (current) {
    Object.assign(current, nextTool);
    return;
  }

  tools.push(nextTool);
}

function buildSessionTitle(messages: ChatMessage[]) {
  const userMessage = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!userMessage) {
    return '新对话';
  }

  return userMessage.content.trim().slice(0, 24) || '新对话';
}

function serializeSessions(sessions: ChatSession[]) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function deserializeSessions() {
  if (typeof window === 'undefined') {
    return { sessions: [createSession()], activeSessionId: '' };
  }

  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  const activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || '';

  if (!raw) {
    const session = createSession();
    return { sessions: [session], activeSessionId: session.id };
  }

  try {
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed) || !parsed.length) {
      const session = createSession();
      return { sessions: [session], activeSessionId: session.id };
    }

    const normalized = parsed.map((session) => {
      const title = typeof session.title === 'string' && session.title.trim() ? session.title : '新对话';
      const messages = Array.isArray(session.messages) && session.messages.length
        ? session.messages
        : [createInitialAssistantMessage('你好，我是你的 Popo 私人小助手。')];

      return {
        ...session,
        title,
        messages,
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
        createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now()
      };
    });

    return {
      sessions: normalized,
      activeSessionId: normalized.some((session) => session.id === activeSessionId) ? activeSessionId : normalized[0].id
    };
  } catch {
    const session = createSession();
    return { sessions: [session], activeSessionId: session.id };
  }
}

const initialState = deserializeSessions();

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>(initialState.sessions);
  const activeConversationId = ref(initialState.activeSessionId || initialState.sessions[0].id);
  const input = ref('');
  const isResponding = ref(false);
  const documents = ref<KnowledgeDocument[]>([]);
  const ragEnabled = ref(true);
  const errorMessage = ref('');
  const noticeMessage = ref('');
  const sidebarOpen = ref(typeof window !== 'undefined' && window.innerWidth > 1080);
  const abortController = ref<AbortController | null>(null);

  /**
 * 当前等待执行的持久化定时器。
 *
 * null：当前没有等待执行的保存任务
 * 非null：已经安排了一次延迟保存
 */
  let persistenceTimer:
    ReturnType<typeof setTimeout> | null = null;

  /**
   * 内存里的会话是否存在尚未保存的变化。
   *
   * true：有变化，需要保存
   * false：当前数据已经保存
   */
  let hasPendingPersistence = false;

  const activeSession = computed(() => {
    return sessions.value.find((session) => session.id === activeConversationId.value) || sessions.value[0];
  });
  const messages = computed(() => activeSession.value.messages);
  const messageCount = computed(() => activeSession.value.messages.length);
  const documentCount = computed(() => documents.value.length);
  const sessionList = computed(() =>
    [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)
  );

  type PersistenceMode =
    | 'immediate'
    | 'scheduled';

  /**
   * 真正执行JSON.stringify和localStorage写入。
   *
   * 所有保存方式最终都会走到这里。
   */
  function writeSessionsToStorage() {
    serializeSessions(sessions.value);

    if (typeof window !== 'undefined') {
      localStorage.setItem(
        ACTIVE_SESSION_KEY,
        activeConversationId.value
      );
    }
  }

  /**
   * 清除还没有执行的延迟保存任务。
   */
  function clearPersistenceTimer() {
    if (persistenceTimer === null) {
      return;
    }

    clearTimeout(persistenceTimer);
    persistenceTimer = null;
  }

  /**
   * 立即保存。
   *
   * 创建、删除、切换会话等操作继续使用它，
   * 保持原有行为不变。
   */
  function persistSessions() {
    // 如果之前安排过延迟保存，就取消它，
    // 避免立即保存后又重复保存一次
    clearPersistenceTimer();

    hasPendingPersistence = false;

    writeSessionsToStorage();
  }

  /**
   * 安排一次合并保存。
   *
   * 第一个Token到达时启动200ms定时器；
   * 后续Token只更新数据，不再创建新定时器。
   */
  function schedulePersistSessions() {
    // 只要消息发生变化，就标记为尚未保存
    hasPendingPersistence = true;

    // 已经存在定时器时，不重复创建
    if (persistenceTimer !== null) {
      return;
    }

    persistenceTimer = setTimeout(() => {
      // 定时器已经开始执行
      persistenceTimer = null;

      // 可能已经被其他立即保存处理过
      if (!hasPendingPersistence) {
        return;
      }

      hasPendingPersistence = false;

      writeSessionsToStorage();
    }, PERSIST_INTERVAL_MS);
  }

  /**
   * 强制保存尚未落盘的最终状态。
   *
   * 回答完成、停止生成或发生异常时使用。
   */
  function flushPendingSessions() {
    clearPersistenceTimer();

    // 没有新变化时不重复写入
    if (!hasPendingPersistence) {
      return;
    }

    hasPendingPersistence = false;

    writeSessionsToStorage();
  }

  /**
   * 更新当前会话的时间和标题，
   * 再根据场景选择立即保存或合并保存。
   */
  function touchActiveSession(
    mode: PersistenceMode = 'immediate'
  ) {
    activeSession.value.updatedAt = Date.now();

    activeSession.value.title =
      buildSessionTitle(
        activeSession.value.messages
      );

    if (mode === 'scheduled') {
      schedulePersistSessions();
      return;
    }

    // 立即保存前先标记发生过变化，
    // 然后由flush统一完成最终写入
    hasPendingPersistence = true;
    flushPendingSessions();
  }

  async function refreshDocuments() {
    try {
      documents.value = await fetchKnowledgeDocuments();
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '加载知识库失败';
    }
  }

  async function uploadKnowledge(files: FileList | File[]) {
    noticeMessage.value = '';
    try {
      const uploaded = await uploadKnowledgeDocuments(files);
      documents.value = [...documents.value, ...uploaded];
      errorMessage.value = '';
      noticeMessage.value = uploaded.length ? `已成功导入 ${uploaded.length} 份知识文件。` : '';
      sidebarOpen.value = true;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '上传知识库失败';
    }
  }

  async function removeDocument(id: string) {
    noticeMessage.value = '';
    try {
      await deleteKnowledgeDocument(id);
      documents.value = documents.value.filter((item) => item.id !== id);
      errorMessage.value = '';
      noticeMessage.value = '知识文件已移除。';
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '删除知识库失败';
    }
  }

  async function clearKnowledge() {
    noticeMessage.value = '';
    try {
      await clearKnowledgeDocuments();
      documents.value = [];
      errorMessage.value = '';
      noticeMessage.value = '知识库已清空。';
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '清空知识库失败';
    }
  }

  function appendInput(text: string) {
    input.value = text;
  }

  function switchSession(sessionId: string) {
    if (sessionId === activeConversationId.value || isResponding.value) {
      return;
    }

    activeConversationId.value = sessionId;
    input.value = '';
    errorMessage.value = '';
    noticeMessage.value = '';
    persistSessions();
    closeSidebar();
  }

  function createNewSession() {
    if (isResponding.value) {
      return;
    }

    const session = createSession();
    sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)];
    activeConversationId.value = session.id;
    input.value = '';
    errorMessage.value = '';
    noticeMessage.value = '已创建新的对话。';
    persistSessions();
    closeSidebar();
  }

  function deleteSession(sessionId: string) {
    if (isResponding.value || sessions.value.length === 1) {
      return;
    }

    const nextSessions = sessions.value.filter((session) => session.id !== sessionId);
    if (!nextSessions.length) {
      return;
    }

    sessions.value = nextSessions;
    if (activeConversationId.value === sessionId) {
      activeConversationId.value = nextSessions[0].id;
    }
    noticeMessage.value = '会话已删除。';
    errorMessage.value = '';
    persistSessions();
  }

  function clearMessages() {
    if (isResponding.value) {
      return;
    }

    activeSession.value.messages = [createInitialAssistantMessage('新的会话已开始。你可以继续提问，或者上传文件后让我使用向量知识库来辅助回答。')];
    activeSession.value.updatedAt = Date.now();
    activeSession.value.title = '新对话';
    input.value = '';
    errorMessage.value = '';
    noticeMessage.value = '当前会话已清空。';
    persistSessions();
  }

  function startFreshConversation() {
    createNewSession();
  }

  function toggleRag() {
    ragEnabled.value = !ragEnabled.value;
    noticeMessage.value = ragEnabled.value ? '已启用 RAG 检索。' : '已关闭 RAG 检索。';
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value;
  }

  function closeSidebar() {
    if (typeof window === 'undefined' || window.innerWidth <= 1080) {
      sidebarOpen.value = false;
    }
  }

  function stopStreaming() {
    abortController.value?.abort();
    abortController.value = null;
    isResponding.value = false;

    const assistantMessage = [...activeSession.value.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'streaming');
    if (assistantMessage) {
      assistantMessage.status = assistantMessage.content.trim() ? 'done' : 'error';
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '已停止本次输出。';
      }
    }

    noticeMessage.value = '已停止生成。';
    touchActiveSession();
  }

  async function sendMessage(raw?: string) {
    const content = (raw ?? input.value).trim();
    if (!content || isResponding.value) {
      return;
    }

    errorMessage.value = '';
    noticeMessage.value = '';

    const userMessage = createMessage('user', content);
    activeSession.value.messages.push(userMessage);
    input.value = '';
    isResponding.value = true;
    touchActiveSession();

    const assistantMessageDraft: ChatMessage = {
      id: uid('assistant'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      citations: [],
      tools: []
    };

    activeSession.value.messages.push(assistantMessageDraft);
    const assistantMessage = activeSession.value.messages[activeSession.value.messages.length - 1] as ChatMessage;
    touchActiveSession();

    const controller = new AbortController();
    abortController.value = controller;

    try {
      await streamAgentChat(
        [
          ...(ragEnabled.value
            ? []
            : [
              {
                role: 'user' as const,
                content: '请注意：本轮对话用户关闭了 RAG，如果不是必须，不要调用 retrieve_knowledge。'
              }
            ]),
          ...toConversationMessages(activeSession.value.messages.slice(0, -1))
        ],
        (event) => {
          if (event.type === 'token' && event.token) {
            // 每个Token仍然立即更新内存，
            // 因此页面上的文字依然逐步显示
            assistantMessage.content += event.token;

            // 只把localStorage保存改为200ms合并执行
            touchActiveSession('scheduled');
          }

          if (event.type === 'tool' && event.tool) {
            mergeTool(assistantMessage.tools ?? (assistantMessage.tools = []), event.tool);
            touchActiveSession('scheduled');
          }

          if (event.type === 'citations' && event.citations) {
            assistantMessage.citations = event.citations;
            touchActiveSession('scheduled');
          }

          if (event.type === 'error') {
            assistantMessage.status = 'error';
            assistantMessage.content = event.details ? `${event.message || '请求失败'}\n${event.details}` : event.message || '请求失败';
            errorMessage.value = assistantMessage.content;
            touchActiveSession();
          }

          if (event.type === 'done') {
            if (event.citations?.length) {
              assistantMessage.citations = event.citations;
            }
            if (event.tools?.length) {
              assistantMessage.tools = event.tools;
            }
            if (assistantMessage.status !== 'error') {
              assistantMessage.status = 'done';
            }
            touchActiveSession();
          }
        },
        controller.signal
      );

      if (
        !controller.signal.aborted &&
        assistantMessage.status === 'streaming'
      ) {
        assistantMessage.status = 'done';
        touchActiveSession();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      assistantMessage.status = 'error';
      assistantMessage.content = error instanceof Error ? error.message : '请求失败，请稍后重试。';
      errorMessage.value = assistantMessage.content;
      // 异常属于最终状态，立即保存错误信息
      touchActiveSession();
    } finally {
      if (abortController.value === controller) {
        abortController.value = null;
      }

      isResponding.value = false;

      /**
       * finally不再修改会话时间并强制重复保存，
       * 只负责补交可能尚未执行的合并保存。
       *
       * 如果done或error已经保存过，
       * dirty为false，这里不会再次写localStorage。
       */
      flushPendingSessions();
    }
  }

  return {
    activeConversationId,
    activeSession,
    appendInput,
    clearKnowledge,
    clearMessages,
    closeSidebar,
    createNewSession,
    deleteSession,
    documentCount,
    documents,
    errorMessage,
    input,
    isResponding,
    messageCount,
    messages,
    noticeMessage,
    ragEnabled,
    refreshDocuments,
    removeDocument,
    sendMessage,
    sessionList,
    sidebarOpen,
    startFreshConversation,
    stopStreaming,
    switchSession,
    toggleRag,
    toggleSidebar,
    uploadKnowledge
  };
});
