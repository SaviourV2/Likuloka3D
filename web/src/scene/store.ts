/**
 * Editor state in one zustand store.
 *
 * `doc` is the scene document. Every change to it goes through `commit`
 * (one step) or a gesture (`begin`, any number of `preview`s, then `end`),
 * so a whole drag is one undo step. The history keeps whole documents; they
 * share every untouched node, so a step costs only the nodes it changed.
 *
 * Selection, tools and level modes are view state: they are not undone.
 */
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { ancestor, emptyDoc, migrate, remove, validate, SceneError } from './ops';
import type { Id, LevelMode, OpeningKind, SceneDoc, Vec2 } from './types';
import { BUNDLED, type Catalogue } from './catalogue';
import { clientRefusal, type Role } from './access';

export const HISTORY_LIMIT = 200;

export interface Step { doc: SceneDoc; label: string }

/** What the pointer is doing. One value instead of a flag per mode. */
export type Interaction =
  | { kind: 'idle' }
  | { kind: 'dragging'; target: Id; what: 'wall' | 'wall-end' | 'point' | 'insert' | 'zone' | 'opening' | 'building' }
  | { kind: 'drawing-wall'; level: Id; from: Vec2 | null; to: Vec2 | null }
  /** A click on a wall puts a door or window there. */
  | { kind: 'placing'; what: OpeningKind }
  /** A corner of the plot follows the pointer. */
  | { kind: 'dragging-plot' };

/** `plot` shows the plot's corners so they can be dragged; nothing else is selected while it is on. */
export type Tool = 'select' | 'wall' | 'door' | 'window' | 'plot';

export interface BuildingView { mode: LevelMode; solo: Id | null }

export interface CloudUser { uid: string; name: string; email: string | null }
export interface CloudState {
  status: 'off' | 'starting' | 'signed-out' | 'signed-in' | 'error';
  user: CloudUser | null;
  /** Something to tell the person: an error, or that someone else saved the project. */
  notice: { kind: 'error' | 'remote'; text: string } | null;
}

export interface EditorState {
  doc: SceneDoc;
  past: Step[];
  future: Step[];
  /** The document a gesture started from, while one runs. */
  gesture: Step | null;
  selection: Id | null;
  activeLevel: Id | null;
  views: Record<Id, BuildingView>;
  tool: Tool;
  interaction: Interaction;
  /** Walls cut at a section height, so rooms can be seen into. A plain setting. */
  cut: boolean;
  /** Sizes shown on every door and window in the view, not only the selected one. A plain setting. */
  measure: boolean;
  /** Furniture drawn in every room, worked out from the rooms. A plain setting. */
  furniture: boolean;
  /**
   * The open project: its id in browser storage, and the document as it was
   * last saved. The project has unsaved changes when `doc !== saved`.
   */
  project: {
    id: string; saved: SceneDoc | null; savedAt: number | null; where: 'local' | 'cloud';
    /** For a cloud project: the save this copy is based on, which the next save must follow. */
    cloudVersion?: number;
  };
  /** Cloud accounts and sharing (`cloud.ts`). `off` when this site has no cloud set up. */
  cloud: CloudState;
  /** Products, wall types and check thresholds, from `catalogue.json`. Not part of the document. */
  catalogue: Catalogue;
  /** Who is editing. A client's edits are limited to choices (`access.ts`); `fixed` when it came from a share link. */
  role: Role;
  error: string | null;
}

const initial: EditorState = {
  doc: emptyDoc(),
  past: [],
  future: [],
  gesture: null,
  selection: null,
  activeLevel: null,
  views: {},
  tool: 'select',
  interaction: { kind: 'idle' },
  cut: true,
  measure: false,
  furniture: true,
  project: { id: 'project-new', saved: null, savedAt: null, where: 'local' },
  catalogue: BUNDLED,
  role: { kind: 'designer' },
  cloud: { status: 'off', user: null, notice: null },
  error: null,
};

export const editor = createStore<EditorState>(() => initial);
export const useEditor = <T>(selector: (s: EditorState) => T) => useStore(editor, selector);

const set = editor.setState;
const state = editor.getState;

/** Keeps view state pointing at nodes that exist. */
function tidy(doc: SceneDoc, s: EditorState): Partial<EditorState> {
  const selection = s.selection && doc.nodes[s.selection] ? s.selection : null;
  let activeLevel = s.activeLevel && doc.nodes[s.activeLevel] ? s.activeLevel : null;
  if (!activeLevel) {
    const firstBuilding = doc.nodes[doc.roots[0]];
    activeLevel = firstBuilding?.type === 'building' ? firstBuilding.children[0] ?? null : null;
  }
  const views: Record<Id, BuildingView> = {};
  for (const b of doc.roots) {
    const v = s.views[b] ?? { mode: 'stack', solo: null };
    const building = doc.nodes[b];
    const solo = v.solo && doc.nodes[v.solo] ? v.solo : (building?.type === 'building' ? building.children[0] ?? null : null);
    views[b] = { mode: v.mode, solo };
  }
  return { selection, activeLevel, views };
}

function fail(e: unknown): false {
  const message = e instanceof SceneError ? e.message : e instanceof Error ? e.message : String(e);
  set({ error: message });
  return false;
}

/** The role's limits on an edit: null when it may be made. */
function guard(prev: SceneDoc, next: SceneDoc): string | null {
  return state().role.kind === 'client' ? clientRefusal(prev, next) : null;
}

/** Applies one edit as one undo step. Returns false and sets `error` if it is refused. */
export function commit(edit: (doc: SceneDoc) => SceneDoc, label: string): boolean {
  const s = state();
  if (s.gesture) end();
  let next: SceneDoc;
  try { next = edit(state().doc); } catch (e) { return fail(e); }
  if (next === state().doc) return true;
  const refused = guard(state().doc, next);
  if (refused) return fail(refused);
  const cur = state();
  set({
    doc: next,
    past: [...cur.past, { doc: cur.doc, label }].slice(-HISTORY_LIMIT),
    future: [],
    error: null,
    ...tidy(next, cur),
  });
  return true;
}

/** Starts a gesture: its previews replace each other and `end` records one step. */
export function begin(label: string) {
  const s = state();
  if (s.gesture) end();
  set({ gesture: { doc: state().doc, label }, error: null });
}

/**
 * Shows the gesture's result so far. `edit` always gets the document from
 * before the gesture, so the result does not drift with pointer events.
 * A refused edit keeps the last good preview.
 */
export function preview(edit: (base: SceneDoc) => SceneDoc): boolean {
  const g = state().gesture;
  if (!g) return false;
  try {
    const next = edit(g.doc);
    const refused = guard(g.doc, next);
    if (refused) return fail(refused);
    if (next !== state().doc) set({ doc: next, error: null });
    return true;
  } catch (e) {
    return fail(e);
  }
}

export function end() {
  const s = state();
  if (!s.gesture) return;
  if (s.doc === s.gesture.doc) { set({ gesture: null, interaction: { kind: 'idle' } }); return; }
  set({
    gesture: null,
    interaction: { kind: 'idle' },
    past: [...s.past, s.gesture].slice(-HISTORY_LIMIT),
    future: [],
    ...tidy(s.doc, s),
  });
}

export function cancel() {
  const s = state();
  if (s.gesture) set({ doc: s.gesture.doc, gesture: null, ...tidy(s.gesture.doc, s) });
  set({ interaction: { kind: 'idle' } });
}

export function undo(): boolean {
  const s = state();
  if (s.gesture) cancel();
  const cur = state();
  const step = cur.past.at(-1);
  if (!step) return false;
  set({
    doc: step.doc,
    past: cur.past.slice(0, -1),
    future: [{ doc: cur.doc, label: step.label }, ...cur.future],
    error: null,
    ...tidy(step.doc, cur),
  });
  return true;
}

export function redo(): boolean {
  const s = state();
  if (s.gesture) cancel();
  const cur = state();
  const step = cur.future[0];
  if (!step) return false;
  set({
    doc: step.doc,
    past: [...cur.past, { doc: cur.doc, label: step.label }],
    future: cur.future.slice(1),
    error: null,
    ...tidy(step.doc, cur),
  });
  return true;
}

/** Replaces the whole scene. `undoable` keeps the old scene one undo away. */
export function load(doc: unknown, opts: { undoable?: boolean; label?: string } = {}): boolean {
  let checked: SceneDoc;
  try { checked = validate(migrate(doc)); } catch (e) { return fail(e); }
  if (opts.undoable) return commit(() => checked, opts.label ?? 'Load scene');
  set({ ...tidy(checked, { ...state(), selection: null, activeLevel: null }), doc: checked, past: [], future: [], gesture: null, error: null });
  return true;
}

export function select(id: Id | null) {
  const s = state();
  if (id !== null && !s.doc.nodes[id]) return;
  const level = id ? ancestor(s.doc, id, 'level') : null;
  const activeLevel = level?.id ?? s.activeLevel;
  // The wall tool draws on the active level, so a new level starts a new chain.
  const interaction: Interaction = s.interaction.kind === 'drawing-wall' && activeLevel && activeLevel !== s.interaction.level
    ? { kind: 'drawing-wall', level: activeLevel, from: null, to: null }
    : s.interaction;
  set({ selection: id, activeLevel, interaction });
}

export function removeSelected(): boolean {
  const id = state().selection;
  if (!id) return false;
  const node = state().doc.nodes[id];
  return commit(doc => remove(doc, id), `Delete ${node?.type ?? 'node'}`);
}

export function setView(buildingId: Id, patch: Partial<BuildingView>) {
  const s = state();
  if (!s.doc.nodes[buildingId]) return;
  const v = { ...s.views[buildingId], ...patch } as BuildingView;
  set({ views: { ...s.views, [buildingId]: v } });
}

export function setTool(tool: Tool) {
  const s = state();
  // Clients only select: drawing walls and placing openings are the designer's.
  if (s.role.kind === 'client' && tool !== 'select') return;
  if (s.gesture) cancel();
  const level = s.activeLevel;
  set({
    tool,
    ...(tool === 'plot' ? { selection: null } : {}),
    interaction: tool === 'wall' && level ? { kind: 'drawing-wall', level, from: null, to: null }
      : tool === 'door' || tool === 'window' ? { kind: 'placing', what: tool }
      : { kind: 'idle' },
  });
}

export function setInteraction(interaction: Interaction) {
  set({ interaction });
}

export function clearError() {
  set({ error: null });
}

export function setCut(cut: boolean) {
  set({ cut });
}

export function setFurniture(furniture: boolean) {
  set({ furniture });
}

export function setMeasure(measure: boolean) {
  set({ measure });
}

export const isUnsaved = (s: EditorState) => s.doc !== s.project.saved;

export function setCatalogue(catalogue: Catalogue) {
  set({ catalogue });
}

/** Switches who is editing. A role that came from a share link (`fixed`) cannot be left. */
export function setRole(role: Role): boolean {
  const s = state();
  if (s.role.kind === 'client' && s.role.fixed) return false;
  if (s.gesture) cancel();
  set({ role, ...(role.kind === 'client' ? { tool: 'select' as Tool, interaction: { kind: 'idle' } as Interaction } : {}) });
  return true;
}

export const isClient = (s: EditorState) => s.role.kind === 'client';
