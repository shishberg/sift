<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SearchResult } from '@/types';

const route = useRoute();
const router = useRouter();
const query = ref('');
const results = ref<SearchResult[]>([]);
const recent = ref<SearchResult[]>([]);
const loading = ref(false);
const error = ref('');
const searched = ref(false);

// ── Recent search history (localStorage) ──────────────────────────────────
const HISTORY_KEY = 'sift:history';
const HISTORY_MAX = 10;
const history = ref<string[]>(loadHistory());
const showHistory = ref(false);

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory(term: string): void {
  history.value = [term, ...history.value.filter((t) => t !== term)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value));
  } catch {
    // localStorage unavailable (private mode) — history is best-effort.
  }
}

function clearHistory(): void {
  history.value = [];
  showHistory.value = false;
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
}

// Suggestions shown in the dropdown — filtered by what's typed.
const suggestions = computed((): string[] => {
  const q = query.value.trim().toLowerCase();
  const items = q
    ? history.value.filter((t) => t.toLowerCase().includes(q) && t.toLowerCase() !== q)
    : history.value;
  return items.slice(0, 8);
});

// ── Recent sessions (shown when there's no search query) ──────────────────
async function loadRecent(): Promise<void> {
  loading.value = true;
  error.value = '';

  try {
    const res = await fetch('/api/recent?limit=30');
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      error.value = body.error ?? `Server error: ${res.status}`;
      recent.value = [];
      return;
    }
    recent.value = (await res.json()) as SearchResult[];
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not reach the server.';
    recent.value = [];
  } finally {
    loading.value = false;
  }
}

// ── Search ────────────────────────────────────────────────────────────────
async function runSearch(q: string): Promise<void> {
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

// Submitting puts the term in the URL so back-navigation restores it and the
// open session (if any) stays put. The route watcher below runs the fetch.
function submit(): void {
  const q = query.value.trim();
  if (!q) return;
  showHistory.value = false;
  saveHistory(q);
  if (route.query.q === q) {
    void runSearch(q); // same term — route won't change, re-run directly
  } else {
    void router.push({ query: { ...route.query, q } });
  }
}

function pickSuggestion(term: string): void {
  query.value = term;
  submit();
}

// Clear the search box and drop `q` from the URL → the watcher reloads recent
// sessions. Keeps any open session (and its file/line) in place.
function clearSearch(): void {
  query.value = '';
  showHistory.value = false;
  if (!route.query.q) {
    void loadRecent(); // no q in URL — watcher won't fire, refresh directly
  } else {
    void router.push({ query: { ...route.query, q: undefined } });
  }
}

// React to the URL's q param: covers first load, shared links, the back
// button, and navigating between sessions (q is carried along).
watch(
  () => route.query.q,
  (q) => {
    const term = typeof q === 'string' ? q : '';
    if (!term) {
      // No query — show the most recently touched sessions instead.
      query.value = '';
      results.value = [];
      searched.value = false;
      error.value = '';
      void loadRecent();
      return;
    }
    if (term !== query.value) query.value = term;
    void runSearch(term);
  },
  { immediate: true },
);

// Clicking a result opens the session in the main panel. Carry q along so the
// sidebar keeps its results and back-nav still restores the search.
function sessionTo(result: SearchResult) {
  return {
    name: 'session',
    params: { id: result.sessionId },
    query: { q: route.query.q, file: result.filePath, line: String(result.lineNumber) },
  };
}

function isActive(result: SearchResult): boolean {
  return route.name === 'session' && route.params.id === result.sessionId;
}

function agentBadgeClass(agentType: string): string {
  if (agentType === 'claude') return 'badge badge-claude';
  if (agentType === 'codex') return 'badge badge-codex';
  if (agentType === 'pi') return 'badge badge-pi';
  return 'badge badge-role';
}

// "28 Jun 2026 13:25" — time last so it stays flush right. Drops the day &
// month when it's today and the year when it's this year (today → "13:25",
// this year → "28 Jun 13:25").
function formatResultTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) return time;
  const dayMonth = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`;
  const datePart = d.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${d.getFullYear()}`;
  return `${datePart} ${time}`;
}

const resultCount = computed(() => results.value.length);

// When there's no active search we show recent sessions; both use the same row.
const displayList = computed(() => (searched.value ? results.value : recent.value));
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Search input (pinned to the top of the sidebar) -->
    <div
      class="px-4 pt-4 pb-3 flex-shrink-0"
      style="border-bottom: 1px solid var(--border)"
    >
      <form @submit.prevent="submit" class="flex gap-2">
        <div style="position: relative; flex: 1">
          <input
            v-model="query"
            type="text"
            placeholder="Search sessions…"
            autofocus
            autocomplete="off"
            class="w-full rounded-md border px-3 py-2 outline-none transition-shadow"
            style="
              font-size: 14px;
              padding-right: 30px;
              background: var(--white);
              border-color: var(--border);
              color: var(--fg);
              font-family: 'Inter', system-ui, sans-serif;
            "
            :style="{
              boxShadow: query ? '0 0 0 2px var(--violet-subtle)' : 'none',
              borderColor: query ? 'var(--violet-border)' : 'var(--border)',
            }"
            @focus="showHistory = true"
            @blur="showHistory = false"
            @keydown.escape="showHistory = false"
          />

          <!-- Clear button — shows when there's a query; clears it and shows recent. -->
          <button
            v-if="query"
            type="button"
            aria-label="Clear search"
            @mousedown.prevent
            @click="clearSearch"
            style="
              position: absolute;
              right: 8px;
              top: 50%;
              transform: translateY(-50%);
              display: flex;
              align-items: center;
              justify-content: center;
              width: 20px;
              height: 20px;
              padding: 0;
              border: none;
              border-radius: 4px;
              background: transparent;
              color: var(--muted-fg);
              font-size: 18px;
              line-height: 1;
              cursor: pointer;
            "
          >×</button>

          <!-- Recent searches -->
          <ul v-if="showHistory && suggestions.length" class="history-dropdown">
            <li
              v-for="term in suggestions"
              :key="term"
              class="history-item"
              @mousedown.prevent="pickSuggestion(term)"
            >
              <span style="color: var(--muted-fg); font-size: 12px">↩</span>
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ term }}</span>
            </li>
            <button type="button" class="history-clear" @mousedown.prevent="clearHistory">
              Clear recent searches
            </button>
          </ul>
        </div>

        <button
          type="submit"
          :disabled="loading || !query.trim()"
          style="
            background: var(--violet);
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 0 14px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.15s;
            white-space: nowrap;
          "
          :style="{ opacity: loading || !query.trim() ? '0.5' : '1' }"
        >
          {{ loading ? '…' : 'Search' }}
        </button>
      </form>
    </div>

    <!-- Results (scrolls independently) -->
    <div class="flex-1 overflow-y-auto px-3 py-3" style="min-height: 0">
      <!-- Error -->
      <div
        v-if="error"
        class="rounded-md px-3 py-2 mb-3"
        style="background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; font-size: 13px"
      >
        {{ error }}
      </div>

      <template v-if="!error">
        <!-- Header: result count when searching, else a recent-sessions label. -->
        <div
          v-if="!loading"
          class="mb-2 px-1"
          style="font-size: 11px; color: var(--muted-fg); letter-spacing: 0.02em"
        >
          <template v-if="searched">
            {{ resultCount === 0 ? 'No results' : `${resultCount} result${resultCount === 1 ? '' : 's'}` }}
          </template>
          <template v-else>Recent sessions</template>
        </div>

        <!-- Empty state: no search results -->
        <div
          v-if="!loading && searched && resultCount === 0"
          class="px-1"
          style="color: var(--muted-fg); font-size: 13px"
        >
          Try different keywords, or run
          <code class="font-mono" style="font-size: 12px; background: var(--surface); padding: 1px 4px; border-radius: 3px">
            sift index
          </code>
          to index your sessions first.
        </div>

        <!-- Empty state: nothing indexed yet -->
        <div
          v-else-if="!loading && !searched && displayList.length === 0"
          class="px-1"
          style="color: var(--muted-fg); font-size: 13px"
        >
          No sessions indexed yet. Run
          <code class="font-mono" style="font-size: 12px; background: var(--surface); padding: 1px 4px; border-radius: 3px">
            sift index
          </code>
          to index your sessions.
        </div>

        <!-- List: search results or recent sessions (same row shape). -->
        <ul v-if="!loading && displayList.length > 0" class="flex flex-col" style="gap: 2px; list-style: none; padding: 0; margin: 0">
          <li
            v-for="result in displayList"
            :key="`${result.sessionId}:${result.lineNumber}`"
          >
            <RouterLink
              :to="sessionTo(result)"
              class="result-link block rounded-md px-3 py-2.5"
              :class="{ 'result-active': isActive(result) }"
            >
              <!-- Meta row -->
              <div class="flex items-center gap-2 flex-wrap mb-1.5" style="font-size: 12px">
                <span
                  :class="agentBadgeClass(result.agentType)"
                  style="font-size: 10px; padding: 1px 5px"
                >{{ result.agentType }}</span>
                <span
                  class="badge badge-role"
                  style="font-size: 10px; padding: 1px 5px"
                >{{ result.role }}</span>
                <!-- Right-aligned: working dir (ellipsised) then the date. -->
                <span
                  class="flex items-center gap-2"
                  style="
                    margin-left: auto;
                    min-width: 0;
                    font-size: 11px;
                    color: var(--muted-fg);
                    font-family: 'JetBrains Mono', ui-monospace, monospace;
                  "
                >
                  <span
                    v-if="result.cwd"
                    :title="result.cwd"
                    style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0"
                  >{{ result.cwd }}</span>
                  <span style="white-space: nowrap; flex-shrink: 0">{{ formatResultTime(result.timestamp) }}</span>
                </span>
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
            </RouterLink>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
