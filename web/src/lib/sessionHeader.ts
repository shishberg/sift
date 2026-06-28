import { reactive } from 'vue';

// Shared state so the global header (App.vue) can show the current session's
// controls — back, id, filename, hide-tools — while SessionView owns the data
// and the transcript. SessionView fills this on load and resets it on unmount.
export interface SessionHeaderState {
  active: boolean;
  agentType: string | null;
  sessionId: string;
  /** Absolute path of the session log file — copied by the working-dir button. */
  filePath: string;
  /** Working directory relative to $HOME, for display. */
  cwd: string;
  showTools: boolean;
  canToggleTools: boolean;
}

export const sessionHeader = reactive<SessionHeaderState>({
  active: false,
  agentType: null,
  sessionId: '',
  filePath: '',
  cwd: '',
  showTools: false,
  canToggleTools: false,
});

export function resetSessionHeader(): void {
  sessionHeader.active = false;
  sessionHeader.agentType = null;
  sessionHeader.sessionId = '';
  sessionHeader.filePath = '';
  sessionHeader.cwd = '';
  sessionHeader.showTools = false;
  sessionHeader.canToggleTools = false;
}
