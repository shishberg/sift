<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SessionResponse, Chunk } from '@/types';

const route = useRoute();
const router = useRouter();

const sessionId = computed(() => route.params.id as string);
const matchFile = computed(() => (route.query.file as string | undefined) ?? '');
const matchLine = computed(() => parseInt((route.query.line as string | undefined) ?? '0', 10));

const session = ref<SessionResponse | null>(null);
const loading = ref(true);
const error = ref('');
const showTools = ref(false);

async function loadSession(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/session/' + encodeURIComponent(sessionId.value));
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      error.value = body.error ?? ('Server error ' + res.status);
      loading.value = false;
      return;
    }
    session.value = (await res.json()) as SessionResponse;
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
  if (showTools.value) return chunks;
  return chunks.filter((c) => c.role !== 'tool');
}

function chunkText(chunk: Chunk): string {
  if (chunk.text) return chunk.text;
  if (chunk.toolCall) return chunk.toolCall.name + '(' + chunk.toolCall.args + ')';
  return '(empty)';
}

function chunkStyle(chunk: Chunk): Record<string, string> {
  if (chunk.role !== 'tool') return {};
  return {
    color: 'var(--muted-fg)',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '12px',
  };
}

function roleLabel(chunk: Chunk): string {
  if (chunk.role === 'tool' && chunk.toolCall) {
    return 'tool:' + chunk.toolCall.name;
  }
  return chunk.role;
}

function agentBadgeClass(agentType: string): string {
  if (agentType === 'claude') return 'badge badge-claude';
  if (agentType === 'codex') return 'badge badge-codex';
  if (agentType === 'pi') return 'badge badge-pi';
  return 'badge badge-role';
}

function goBack(): void {
  void router.push({ name: 'search' });
}

onMounted(() => {
  void loadSession();
});
</script>

<template>
  <div style="max-width: 760px; margin: 0 auto; padding: 0 24px 48px">
    <!-- Back + session header -->
    <div
      class="flex items-start gap-4 py-5 border-b mb-6"
      style="border-color: var(--border)"
    >
      <button
        class="flex-shrink-0 mt-0.5"
        style="
          background: none;
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 4px 10px;
          font-size: 12px;
          cursor: pointer;
          color: var(--muted-fg);
          white-space: nowrap;
        "
        @click="goBack"
      >
        ← Search
      </button>

      <div class="flex flex-col gap-1 min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span
            v-if="session && session.chunks[0]"
            :class="agentBadgeClass(session.chunks[0].agentType)"
          >{{ session.chunks[0].agentType }}</span>
          <span
            class="font-mono"
            style="font-size: 13px; font-weight: 500; word-break: break-all"
          >{{ sessionId }}</span>
        </div>
        <span
          v-if="session && session.filePath"
          class="font-mono"
          style="font-size: 11px; color: var(--muted-fg); word-break: break-all"
        >{{ session.filePath }}</span>
      </div>

      <!-- Toggle tools -->
      <button
        v-if="!loading && !error"
        class="flex-shrink-0 ml-auto mt-0.5"
        style="
          background: none;
          border-radius: 4px;
          padding: 4px 10px;
          font-size: 12px;
          cursor: pointer;
          white-space: nowrap;
          border: 1px solid var(--border);
          color: var(--muted-fg);
        "
        @click="showTools = !showTools"
      >
        {{ showTools ? 'hide tools' : 'show tools' }}
      </button>
    </div>

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
          :class="isMatch(chunk) ? 'chunk-matched' : ''"
          style="padding: 0 0 0 16px"
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

          <!-- Message text -->
          <div
            style="
              padding-left: 2px;
              font-size: 14px;
              line-height: 1.65;
              color: var(--fg);
              white-space: pre-wrap;
              word-break: break-word;
            "
            :style="chunkStyle(chunk)"
          >
            {{ chunkText(chunk) }}
          </div>
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
          @click="showTools = true"
        >Show them</button>.
      </div>
    </div>
  </div>
</template>
