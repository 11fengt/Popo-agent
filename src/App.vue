<template>
  <main class="yuan-agent-page">
    <div v-if="store.sidebarOpen" class="mobile-mask" @click="store.closeSidebar"></div>

    <section
      class="app-layout"
      :class="{ 'sidebar-open': store.sidebarOpen }"
    >
      <aside class="sidebar-shell" :class="{ 'sidebar-open': store.sidebarOpen }">
        <div class="sidebar-topbar mobile-only">
          <button class="nav-icon-button" @click="store.closeSidebar">✕</button>
          <span>菜单</span>
        </div>

        <div class="sidebar-branding">
          <div class="logo-glyph" aria-hidden="true">
            <img class="logo-image" src="/logo.png" alt="Logo" />
          </div>
          <div class="brand-copy">
            <!-- <p class="sidebar-overline">wang-agent workspace</p> -->
            <h2>wang-tf</h2>
            <span class="brand-subline">个人文档问答的agent工作台</span>
          </div>
        </div>

        <nav class="sidebar-nav">
          <button class="nav-entry nav-entry-primary" :disabled="store.isResponding" @click="store.startFreshConversation">
            发起新对话
          </button>
        </nav>

        <SessionPanel
          :active-session-id="store.activeConversationId"
          :disabled="store.isResponding"
          :sessions="store.sessionList"
          @delete-session="store.deleteSession"
          @new-session="store.startFreshConversation"
          @switch-session="store.switchSession"
        />

        <KnowledgePanel
          :documents="store.documents"
          @clear="store.clearKnowledge"
          @remove="store.removeDocument"
          @upload="store.uploadKnowledge"
        />

        <div class="sidebar-footer">
          <button class="nav-entry">设置和帮助</button>
        </div>
      </aside>

      <section class="main-shell">
        <TopBar
          :conversation-id="store.activeConversationId"
          :disabled="store.isResponding"
          :document-count="store.documentCount"
          :is-responding="store.isResponding"
          :message-count="store.messageCount"
          :rag-enabled="store.ragEnabled"
          @menu="store.toggleSidebar"
          @new-session="store.startFreshConversation"
          @stop="store.stopStreaming"
          @toggle-rag="store.toggleRag"
        />

        <AsyncChatPanel :messages="store.messages" />

        <div v-if="store.noticeMessage" class="notice-banner">{{ store.noticeMessage }}</div>
        <div v-if="store.errorMessage" class="error-banner">{{ store.errorMessage }}</div>

        <ComposerPanel
          v-model="store.input"
          :disabled="store.isResponding"
          :document-count="store.documentCount"
          :rag-enabled="store.ragEnabled"
          :voice-error="speech.error.value"
          :voice-status="speech.status.value"
          :voice-supported="speech.supported.value"
          @submit="store.sendMessage()"
          @voice="handleVoice"
        />
      </section>
    </section>
  </main>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onMounted } from 'vue';
import ComposerPanel from '@/components/ComposerPanel.vue';
import KnowledgePanel from '@/components/KnowledgePanel.vue';
import SessionPanel from '@/components/SessionPanel.vue';
import TopBar from '@/components/TopBar.vue';
import { useSpeechRecognition } from '@/composables/useSpeechRecognition';
import { useChatStore } from '@/stores/chat';

const AsyncChatPanel = defineAsyncComponent(() => import('@/components/ChatPanel.vue'));

const store = useChatStore();
const speech = useSpeechRecognition((text) => {
  store.appendInput(text);
});

onMounted(() => {
  store.refreshDocuments();
});

function handleVoice() {
  if (speech.status.value === 'recording') {
    speech.stop();
    return;
  }

  if (speech.status.value === 'idle') {
    speech.start();
  }
}
</script>
