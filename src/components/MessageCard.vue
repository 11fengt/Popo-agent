<template>
  <article class="message-row" :class="[`message-${message.role}`]">
    <div class="avatar-dot">
      <img class="message-avatar-image" :src="avatarSrc" :alt="avatarAlt" />
    </div>
    <div class="message-main">
      <div class="message-meta">
        <strong>{{ roleLabel }}</strong>
        <span>{{ timeLabel }}</span>
        <span v-if="message.status === 'streaming'" class="streaming-indicator">流式输出中</span>
      </div>

      <div class="message-content" v-html="html"></div>

      <section v-if="message.tools?.length" class="tool-panel">
        <div class="source-header">
          <strong>工具调用</strong>
          <span>{{ message.tools.length }} 次</span>
        </div>
        <article v-for="tool in message.tools" :key="tool.id" class="tool-card">
          <div class="tool-topline">
            <strong>{{ tool.name }}</strong>
            <span :class="['tool-status', `tool-${tool.status}`]">{{ tool.status }}</span>
          </div>
          <pre>{{ JSON.stringify(tool.args, null, 2) }}</pre>
          <p v-if="tool.result">{{ tool.result }}</p>
        </article>
      </section>

      <section v-if="message.citations?.length" class="source-panel">
        <div class="source-header">
          <strong>参考来源</strong>
          <span>{{ message.citations.length }} 条命中</span>
        </div>
        <article v-for="citation in message.citations" :key="citation.id" class="source-card">
          <div class="source-title-line">
            <strong>{{ citation.title }}</strong>
            <span v-if="citation.score">相关度 {{ citation.score }}</span>
          </div>
          <p>{{ citation.snippet }}</p>
          <small>{{ citation.source }}</small>
        </article>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '@/services/markdown';
import type { ChatMessage } from '@/types/chat';

const props = defineProps<{
  message: ChatMessage;
}>();

const html = computed(() => renderMarkdown(props.message.content || (props.message.status === 'streaming' ? '正在思考中…' : '')));
const roleLabel = computed(() => (props.message.role === 'assistant' ? 'Popo-agent知识库工作台' : '你'));
const avatarSrc = computed(() => (props.message.role === 'assistant' ? '/aipicture.png' : '/logo.png'));
const avatarAlt = computed(() => (props.message.role === 'assistant' ? 'AI 头像' : '用户头像'));
const timeLabel = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(props.message.createdAt)
);
</script>
