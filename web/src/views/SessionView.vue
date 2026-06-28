<script setup lang="ts">
import { onMounted, onUnmounted, nextTick, computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { SessionResponse, Chunk } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { sessionHeader, resetSessionHeader } from '@/lib/sessionHeader';

const route = useRoute();

const sessionId = computed(() => route.params.id as string);
const matchFile = computed(() => (route.query.file as string | undefined) ?? '');
const matchLine = computed(() => parseInt((route.query.line as string | undefined) ?? '0', 10));

const session = ref<SessionResponse | null>(null);
const loading = ref(true);
const error = ref('');

async function loadSession(): Promise<void> {
  loading.value = true;
  error.value = '';
  // Light up the global-header controls right away (back + id) so the user can
  // leave even while the transcript is still loading.
  resetSessionHeader();
  sessionHeader.active = true;
  sessionHeader.sessionId = sessionId.value;
  try {
    const res = await fetch('/api/session/' + encodeURIComponent(sessionId.value));
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      error.value = body.error ?? ('Server error ' + res.status);
      loading.value = false;
      return;
    }
    session.value = (await res.json()) as SessionResponse;
    sessionHeader.agentType = session.value.chunks[0]?.agentType ?? null;
    sessionHeader.filePath = session.value.filePath;
    sessionHeader.cwd = session.value.cwd;
    sessionHeader.canToggleTools = true;
    // Must set loading = false BEFORE nextTick so the v-if="!loading && session"
    // block renders the chunks into the DOM before scrollToMatch queries for them.
    loading.value = false;
    await nextTick();
    scrollToMatch();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load session.';
    loading.value = false;
  }
}

function isMatch(chunk: Chunk): boolean {
  return chunk.lineNumber === matchLine.value && chunk.filePath === matchFile.value;
}

function scrollToMatch(): void {
  const el = document.querySelector('[data-matched]') as HTMLElement | null;
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function visibleChunks(chunks: Chunk[]): Chunk[] {
  if (sessionHeader.showTools) return chunks;
  return chunks.filter((c) => c.role !== 'tool');
}

function chunkText(chunk: Chunk): string {
  if (chunk.text) return chunk.text;
  if (chunk.toolCall) return chunk.toolCall.name + '(' + chunk.toolCall.args + ')';
  return '(empty)';
}

function msgClass(chunk: Chunk): string {
  if (chunk.role === 'user') return 'msg msg-user';
  if (chunk.role === 'assistant') return 'msg msg-assistant';
  return '';
}

// User/assistant text is rendered as markdown; tool chunks stay as plain
// monospace (they're name(args) or raw output, not prose).
function renderedHtml(chunk: Chunk): string {
  return renderMarkdown(chunk.text);
}

function isProse(chunk: Chunk): boolean {
  return chunk.role !== 'tool' && Boolean(chunk.text);
}

function roleLabel(chunk: Chunk): string {
  if (chunk.role === 'tool' && chunk.toolCall) {
    return 'tool:' + chunk.toolCall.name;
  }
  return chunk.role;
}

onMounted(() => {
  void loadSession();
});

onUnmounted(() => {
  resetSessionHeader();
});
</script>

<template>
  <div style="max-width: 760px; margin: 0 auto; padding: 28px 24px 48px">
    <!-- The session controls (back / id / filename / hide-tools) live in the
         global header (App.vue) via the shared sessionHeader store. -->

    <!-- Loading -->
    <div
      v-if="loading"
      style="color: var(--muted-fg); font-size: 14px; padding-top: 32px; text-align: center"
    >
      Loading…
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="rounded-md px-4 py-3"
      style="background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; font-size: 13px"
    >
      {{ error }}
    </div>

    <!-- Transcript -->
    <div v-if="!loading && !error && session" class="flex flex-col" style="gap: 20px">
      <template
        v-for="chunk in visibleChunks(session.chunks)"
        :key="chunk.filePath + ':' + chunk.lineNumber"
      >
        <div
          :data-matched="isMatch(chunk) ? '' : undefined"
          :class="[msgClass(chunk), isMatch(chunk) ? 'chunk-matched' : '']"
        >
          <!-- Role rule -->
          <div class="role-rule">
            <span
              class="role-label"
              :style="chunk.role === 'tool' ? 'color: var(--muted-fg)' : ''"
            >{{ roleLabel(chunk) }}</span>
            <div class="rule-line"></div>
            <span
              class="font-mono flex-shrink-0"
              style="font-size: 10px; color: var(--border); letter-spacing: 0.02em"
            >:{{ chunk.lineNumber }}</span>
          </div>

          <!-- Message text: markdown for prose, plain mono for tools -->
          <div v-if="isProse(chunk)" class="md-body" v-html="renderedHtml(chunk)"></div>
          <div
            v-else
            style="
              font-family: 'JetBrains Mono', ui-monospace, monospace;
              font-size: 12px;
              color: var(--muted-fg);
              white-space: pre-wrap;
              word-break: break-word;
            "
          >{{ chunkText(chunk) }}</div>
        </div>
      </template>

      <!-- All tools hidden -->
      <div
        v-if="visibleChunks(session.chunks).length === 0"
        style="color: var(--muted-fg); font-size: 14px"
      >
        This session only has tool calls.
        <button
          style="
            background: none;
            border: none;
            color: var(--violet);
            cursor: pointer;
            padding: 0;
            font-size: 14px;
            text-decoration: underline;
          "
          @click="sessionHeader.showTools = true"
        >Show them</button>.
      </div>
    </div>
  </div>
</template>
