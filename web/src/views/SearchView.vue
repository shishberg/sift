<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { SearchResult } from '@/types';

const router = useRouter();
const query = ref('');
const results = ref<SearchResult[]>([]);
const loading = ref(false);
const error = ref('');
const searched = ref(false);

async function doSearch(): Promise<void> {
  const q = query.value.trim();
  if (!q) return;

  loading.value = true;
  error.value = '';
  searched.value = true;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      error.value = body.error ?? `Server error: ${res.status}`;
      results.value = [];
      return;
    }
    results.value = (await res.json()) as SearchResult[];
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not reach the server.';
    results.value = [];
  } finally {
    loading.value = false;
  }
}

function goToSession(result: SearchResult): void {
  void router.push({
    name: 'session',
    params: { id: result.sessionId },
    query: {
      file: result.filePath,
      line: String(result.lineNumber),
    },
  });
}

function agentBadgeClass(agentType: string): string {
  if (agentType === 'claude') return 'badge badge-claude';
  if (agentType === 'codex') return 'badge badge-codex';
  if (agentType === 'pi') return 'badge badge-pi';
  return 'badge badge-role';
}

const resultCount = computed(() => results.value.length);
</script>

<template>
  <div class="flex flex-col items-center px-4 pt-16 pb-12" style="max-width: 720px; margin: 0 auto">
    <!-- Search input -->
    <div class="w-full" style="max-width: 600px">
      <form @submit.prevent="doSearch" class="flex gap-2">
        <input
          v-model="query"
          type="text"
          placeholder="Search sessions…"
          autofocus
          class="flex-1 rounded-md border px-4 py-2.5 outline-none transition-shadow"
          style="
            font-size: 15px;
            background: var(--white);
            border-color: var(--border);
            color: var(--fg);
            font-family: 'Inter', system-ui, sans-serif;
          "
          :style="{
            boxShadow: query ? '0 0 0 2px var(--violet-subtle)' : 'none',
            borderColor: query ? 'var(--violet-border)' : 'var(--border)',
          }"
        />
        <button
          type="submit"
          :disabled="loading || !query.trim()"
          style="
            background: var(--violet);
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 0 18px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.15s;
            white-space: nowrap;
          "
          :style="{ opacity: loading || !query.trim() ? '0.5' : '1' }"
        >
          {{ loading ? 'Searching…' : 'Search' }}
        </button>
      </form>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="w-full mt-6 rounded-md px-4 py-3"
      style="
        max-width: 600px;
        background: #fef2f2;
        border: 1px solid #fca5a5;
        color: #991b1b;
        font-size: 13px;
      "
    >
      {{ error }}
    </div>

    <!-- Results -->
    <div v-if="!error && searched" class="w-full mt-8" style="max-width: 600px">
      <!-- Count -->
      <div
        v-if="!loading"
        class="mb-4"
        style="font-size: 12px; color: var(--muted-fg); letter-spacing: 0.02em"
      >
        {{ resultCount === 0 ? 'No results' : `${resultCount} result${resultCount === 1 ? '' : 's'}` }}
      </div>

      <!-- Empty state -->
      <div
        v-if="!loading && resultCount === 0"
        style="color: var(--muted-fg); font-size: 14px"
      >
        Try different keywords, or run
        <code class="font-mono" style="font-size: 13px; background: var(--surface); padding: 1px 4px; border-radius: 3px">
          agent-search index
        </code>
        to index your sessions first.
      </div>

      <!-- Result list -->
      <ul v-if="!loading && resultCount > 0" class="flex flex-col" style="gap: 2px; list-style: none; padding: 0; margin: 0">
        <li
          v-for="result in results"
          :key="`${result.sessionId}:${result.lineNumber}`"
          class="rounded-md px-4 py-3 cursor-pointer transition-colors"
          style="
            border: 1px solid transparent;
            background: var(--white);
          "
          :style="{}"
          @click="goToSession(result)"
          @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--surface)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background = 'var(--white)'"
        >
          <!-- Meta row -->
          <div class="flex items-center gap-2 flex-wrap mb-1.5" style="font-size: 12px">
            <span :class="agentBadgeClass(result.agentType)">{{ result.agentType }}</span>
            <span
              class="font-mono"
              style="color: var(--fg); font-size: 12px; font-weight: 500"
              :title="result.sessionId"
            >
              {{ result.sessionId.length > 28 ? result.sessionId.slice(0, 28) + '…' : result.sessionId }}
            </span>
            <span style="color: var(--border)">·</span>
            <span class="font-mono" style="color: var(--muted-fg); font-size: 11px">
              {{ result.filePath.split('/').pop() }}:{{ result.lineNumber }}
            </span>
            <span style="color: var(--border)">·</span>
            <span
              class="badge badge-role"
              style="font-size: 10px; padding: 1px 5px"
            >{{ result.role }}</span>
          </div>

          <!-- Snippet -->
          <p
            class="m-0"
            style="
              font-size: 13px;
              color: var(--fg);
              line-height: 1.5;
              display: -webkit-box;
              -webkit-line-clamp: 2;
              -webkit-box-orient: vertical;
              overflow: hidden;
            "
          >
            {{ result.snippet || '(no text)' }}
          </p>
        </li>
      </ul>
    </div>

    <!-- Initial empty state (before first search) -->
    <div
      v-if="!searched"
      class="mt-16 text-center"
      style="color: var(--muted-fg); font-size: 13px; line-height: 1.8"
    >
      <p class="m-0">Search across Claude, Codex, and pi session logs.</p>
      <p class="m-0">
        Results link to the full transcript, scrolled to the matching line.
      </p>
    </div>
  </div>
</template>
