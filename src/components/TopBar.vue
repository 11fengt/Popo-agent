<template>
  <header class="topbar-shell">
    <div class="topbar-left">
      <div class="topbar-title-group">
        <h1>工作台</h1>
        <p>{{ titleText }}</p>
      </div>
    </div>

    <div class="topbar-right">
      <button
        type="button"
        class="topbar-icon"
        aria-label="切换侧边菜单"
        title="切换侧边菜单"
        @click="$emit('menu')"
      >
        ☰
      </button>
      <!-- <button class="topbar-chip" @click="$emit('toggle-rag')">
        {{ ragEnabled ? 'RAG On' : 'RAG Off' }}
      </button> -->
      <button class="topbar-chip" :disabled="disabled" @click="$emit('new-session')">新对话</button>
      <button class="topbar-chip stop-chip" :disabled="!isResponding" @click="$emit('stop')">停止输出</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  ragEnabled: boolean;
  documentCount: number;
  conversationId: string;
  messageCount: number;
  isResponding: boolean;
  disabled: boolean;
}>();

defineEmits<{
  menu: [];
  stop: [];
  'new-session': [];
  'toggle-rag': [];
}>();

const titleText = computed(
  () => `会话 ${props.conversationId.slice(0, 7)} · ${props.messageCount} 条消息 · ${props.documentCount} 份知识文档`
);
</script>
