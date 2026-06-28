<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { Progress } from '@/components/ui/progress';
import CopyButton from '@/components/CopyButton.vue';
import { sessionHeader } from '@/lib/sessionHeader';
import type { StatusResponse } from './types';

const router = useRouter();
const status = ref<StatusResponse>({ total: 0, embedded: 0, pending: 0 });
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      status.value = (await res.json()) as StatusResponse;
    }
  } catch {
    // Server not reachable — keep last value.
  }
}

const progressValue = computed((): number => {
  const { total, embedded } = status.value;
  if (total === 0) return 100; // Nothing to embed → show as complete.
  return Math.round((embedded / total) * 100);
});

const isIndexing = computed((): boolean => status.value.pending > 0);

function agentBadgeClass(agentType: string | null): string {
  if (agentType === 'claude') return 'badge badge-claude';
  if (agentType === 'codex') return 'badge badge-codex';
  if (agentType === 'pi') return 'badge badge-pi';
  return 'badge badge-role';
}

function goBack(): void {
  // Back rather than push so the search term in the URL is restored.
  router.back();
}

onMounted(() => {
  void fetchStatus();
  pollTimer = setInterval(() => void fetchStatus(), 1500);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background-color: var(--bg); color: var(--fg)">
    <!-- Header -->
    <header
      class="sticky top-0 z-10 flex items-center gap-4 px-6 h-12 border-b"
      style="
        background: var(--white);
        border-color: var(--border);
        min-height: 48px;
      "
    >
      <!-- Left: logo + (on a session page) session controls -->
      <div class="flex items-center gap-3 min-w-0" style="flex: 1">
        <RouterLink
          to="/"
          class="flex items-center gap-2 no-underline flex-shrink-0"
          style="color: var(--fg); text-decoration: none"
        >
          <span
            class="font-mono"
            style="font-size: 15px; font-weight: 500; letter-spacing: -0.01em"
          >
            <span style="color: var(--violet)">◈</span> agent-search
          </span>
        </RouterLink>

        <template v-if="sessionHeader.active">
          <span style="color: var(--border)" class="flex-shrink-0">/</span>
          <button
            class="flex-shrink-0"
            style="
              background: none;
              border: 1px solid var(--border);
              border-radius: 4px;
              padding: 3px 9px;
              font-size: 12px;
              cursor: pointer;
              color: var(--muted-fg);
              white-space: nowrap;
            "
            @click="goBack"
          >
            ← Search
          </button>
          <span
            v-if="sessionHeader.agentType"
            :class="agentBadgeClass(sessionHeader.agentType)"
            class="flex-shrink-0"
          >{{ sessionHeader.agentType }}</span>

          <!-- Session ID + copy -->
          <span
            class="font-mono flex-shrink-0"
            style="font-size: 12px; font-weight: 500"
            :title="sessionHeader.sessionId"
          >{{ sessionHeader.sessionId.length > 20 ? sessionHeader.sessionId.slice(0, 20) + '…' : sessionHeader.sessionId }}</span>
          <CopyButton :text="sessionHeader.sessionId" title="Copy session ID" />

          <!-- Working directory (relative to home) + copy of the session log path -->
          <template v-if="sessionHeader.cwd">
            <span style="color: var(--border)" class="flex-shrink-0">·</span>
            <span
              class="font-mono"
              style="
                font-size: 12px;
                color: var(--muted-fg);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                min-width: 0;
              "
              :title="sessionHeader.filePath"
            >{{ sessionHeader.cwd }}</span>
            <CopyButton :text="sessionHeader.filePath" title="Copy session log path" />
          </template>
        </template>
      </div>

      <!-- Right: embedding progress -->
      <div class="flex items-center gap-3 flex-shrink-0">
        <div class="flex items-center gap-3" style="min-width: 220px">
          <div class="flex flex-col gap-1" style="flex: 1">
            <Progress :model-value="progressValue" class="h-1.5" />
          </div>
          <span
            class="font-mono whitespace-nowrap"
            style="font-size: 11px; color: var(--muted-fg); letter-spacing: 0.02em"
          >
            <span v-if="isIndexing" style="color: var(--violet)">●</span>
            <span v-else>○</span>
            {{ status.embedded }}/{{ status.total }}
            <span v-if="isIndexing"> · {{ status.pending }} pending</span>
          </span>
        </div>
      </div>
    </header>

    <!-- Page content -->
    <main class="flex-1">
      <RouterView />
    </main>
  </div>
</template>
