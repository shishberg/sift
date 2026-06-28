<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { RouterView } from 'vue-router';
import { Progress } from '@/components/ui/progress';
import CopyButton from '@/components/CopyButton.vue';
import SearchSidebar from '@/components/SearchSidebar.vue';
import { sessionHeader } from '@/lib/sessionHeader';
import type { StatusResponse } from './types';

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

// ── Resizable sidebar ──────────────────────────────────────────────────────
const SIDEBAR_KEY = 'agent-search:sidebar-width';
const MIN_WIDTH = 260;
const sidebarWidth = ref<number>(loadWidth());
let dragging = false;

function loadWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_KEY));
  if (raw && raw >= MIN_WIDTH) return raw;
  return Math.round(window.innerWidth * 0.3); // default ~30%
}

function maxWidth(): number {
  return Math.min(window.innerWidth * 0.6, 760);
}

function startResize(e: MouseEvent): void {
  dragging = true;
  e.preventDefault();
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
  window.addEventListener('mousemove', onResize);
  window.addEventListener('mouseup', stopResize);
}

function onResize(e: MouseEvent): void {
  if (!dragging) return;
  sidebarWidth.value = Math.max(MIN_WIDTH, Math.min(maxWidth(), e.clientX));
}

function stopResize(): void {
  if (!dragging) return;
  dragging = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  try {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth.value));
  } catch {
    // best-effort
  }
  window.removeEventListener('mousemove', onResize);
  window.removeEventListener('mouseup', stopResize);
}

onMounted(() => {
  void fetchStatus();
  pollTimer = setInterval(() => void fetchStatus(), 1500);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
  window.removeEventListener('mousemove', onResize);
  window.removeEventListener('mouseup', stopResize);
});
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden" style="background-color: var(--bg); color: var(--fg)">
    <!-- Pinned top bar -->
    <header
      class="flex items-center gap-4 px-6 h-12 border-b flex-shrink-0"
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

    <!-- Body: search sidebar | main session panel -->
    <div class="flex flex-1" style="min-height: 0">
      <aside
        class="flex-shrink-0 overflow-hidden"
        :style="{ width: sidebarWidth + 'px', background: 'var(--white)' }"
      >
        <SearchSidebar />
      </aside>

      <!-- Drag handle -->
      <div class="resizer" @mousedown="startResize" title="Drag to resize">
        <div class="resizer-grip"></div>
      </div>

      <main class="flex-1 overflow-y-auto" style="min-width: 0">
        <RouterView />
      </main>
    </div>
  </div>
</template>
