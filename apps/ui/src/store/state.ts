/**
 * The interface's state (plan §7.2). `board` is the daemon's snapshot, replaced whole after every
 * re-read; `activity` is what the event stream shows between snapshots; `ui` and `prefs` are local.
 */
import type { UiSnapshot } from '@friday/protocol';
import type { DrawerRequest, ModalRequest } from '../shell/context.js';
import { ObservableStore } from './store.js';

export type Connection = 'starting' | 'signed-out' | 'connecting' | 'live' | 'reconnecting' | 'stopped';

export interface SystemState {
  connection: Connection;
  /** The last event sequence applied. */
  sequence: number;
  /** Reconnect attempts since the stream was last live. */
  attempts: number;
  lastError: string | null;
  /** True while a snapshot re-read is in flight. */
  refreshing: boolean;
  /** Milliseconds since epoch of the last snapshot. */
  snapshotAt: number;
}

export type ToolKind = 'read' | 'search' | 'write' | 'command' | 'network' | 'mcp' | 'capability' | 'other';

export interface ToolActivity {
  at: number;
  tool: string;
  kind: ToolKind;
  target: string | null;
  decision: 'allow' | 'deny' | 'ask' | 'done' | 'failed';
  taskId: string | null;
}

export interface LogLine {
  at: number;
  sequence: number;
  stream: 'tool' | 'error' | 'progress' | 'info';
  text: string;
}

export interface AgentActivity {
  /** The latest tool the agent's host asked about or finished. */
  current: ToolActivity | null;
  log: LogLine[];
  usage: { cost_usd: number | null; input_tokens: number | null; output_tokens: number | null } | null;
  model: string | null;
}

export interface Pulse {
  id: number;
  agentKey: string;
  taskId: string;
  kind: ToolKind;
  born: number;
}

export interface ActivityState {
  /** Per agent key. */
  agents: Record<string, AgentActivity>;
  /** Per task: files touched recently, newest first (the live ticker). */
  files: Record<string, { path: string; at: number }[]>;
  /** Conduit pulses travelling from an agent to its task. */
  pulses: Pulse[];
  /** The latest moment anything happened (drives the mascot's working and sleeping). */
  lastActivityAt: number;
  /** Short-lived reactions the mascot and the sounds play (consumed by their controllers). */
  reactions: Reaction[];
}

export type ReactionKind =
  | 'approval'
  | 'question'
  | 'plan'
  | 'completed'
  | 'goal-completed'
  | 'failed'
  | 'lost'
  | 'node'
  | 'halt'
  | 'approved'
  | 'denied';

export interface Reaction {
  id: number;
  kind: ReactionKind;
  at: number;
  label?: string;
}

export type { DrawerBack, DrawerKind } from '../shell/context.js';

export type StudioView = 'canvas' | 'settings';

export interface UiState {
  activeView: StudioView;
  settingsTab?: string;
  selectedTaskId: string | null;
  drawer: DrawerRequest | null;
  modal: ModalRequest | null;
  paletteOpen: boolean;
  camera: { x: number; y: number; zoom: number };
  notchPinned: boolean;
  /** The graph reindex the user started is running (the mascot searches). */
  indexing: boolean;
  /** The Notch card was folded with "Later" while an item still waits (plan §7.8). */
  notchFolded: boolean;
  /** Tasks whose `+N −M` is stale after a write (plan §7.2); the canvas re-reads them. */
  staleStats: Record<string, number>;
  /**
   * Approvals this page decided (or is deciding), by id, with when: a snapshot read before the
   * decision committed must not bring them back (review M9i). Cleared once a snapshot no longer
   * lists one, or after two minutes.
   */
  decided: Record<string, number>;
  /** Line counts per task from `tasks/:tid/diff?stat=1`. */
  stats: Record<string, { added: number; removed: number; at: number }>;
}


export interface Prefs {
  muted: boolean;
  volume: number;
  motion: 'system' | 'reduce' | 'full';
  outfit: 'none' | 'headphones' | 'visor' | 'winter' | 'witch' | 'sunglasses';
  showFinished: boolean;
  notchAutoCollapseS: number;
  notchHideS: number;
  /** Browser notifications while the tab is hidden (plan FD-25); asked from a user gesture. */
  notifications: boolean;
  /** Node positions moved by hand, per task or goal id (positions are a preference, not state). */
  positions: Record<string, { x: number; y: number }>;
  /** The getting-started checklist was dismissed. */
  gettingStartedDismissed: boolean;
  /** The terminal drawer's height (300–600 px). */
  terminalHeight: number;
}

export interface RootState {
  system: SystemState;
  board: UiSnapshot | null;
  activity: ActivityState;
  ui: UiState;
  prefs: Prefs;
}

export const DEFAULT_PREFS: Prefs = {
  muted: false,
  volume: 0.18,
  motion: 'system',
  outfit: 'none',
  showFinished: true,
  notchAutoCollapseS: 15,
  notchHideS: 60,
  notifications: false,
  positions: {},
  gettingStartedDismissed: false,
  terminalHeight: 320,
};

export function initialState(prefs: Prefs = DEFAULT_PREFS): RootState {
  return {
    system: { connection: 'starting', sequence: 0, attempts: 0, lastError: null, refreshing: false, snapshotAt: 0 },
    board: null,
    activity: { agents: {}, files: {}, pulses: [], lastActivityAt: 0, reactions: [] },
    ui: {
      activeView: 'canvas',
      settingsTab: undefined,
      selectedTaskId: null,
      drawer: null,
      modal: null,
      paletteOpen: false,
      camera: { x: 0, y: 0, zoom: 1 },
      notchPinned: false,
      indexing: false,
      notchFolded: false,
      staleStats: {},
      decided: {},
      stats: {},
    },
    prefs,

  };
}

export type FridayStore = ObservableStore<RootState>;

export function createStore(prefs?: Prefs): FridayStore {
  return new ObservableStore<RootState>(initialState(prefs));
}
