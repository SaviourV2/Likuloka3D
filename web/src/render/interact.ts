/**
 * Pointer gestures in the 3D view. A gesture projects the pointer onto the
 * floor plane of the level being edited, as that level is drawn right now
 * (so it works with exploded levels), converts it to plan metres and hands
 * the start and current points to an edit. The edit always runs against the
 * document from before the gesture, through the store's `preview`.
 */
import * as THREE from 'three/webgpu';
import type { ThreeEvent } from '@react-three/fiber';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { world } from '@/ecs/world';
import { ancestor, addOpeningAt, addWall, insertPoint, movePoint, moveWallEnd, offsetWall, setOrigin, slideOpening, snapPoint, translate } from '@/scene/ops';
import { begin, cancel, commit, editor, end, preview, select, setInteraction, setTool, type Interaction } from '@/scene/store';
import type { Id, SceneDoc, Vec2 } from '@/scene/types';

interface Rig {
  camera: THREE.Camera;
  dom: HTMLElement;
  controls: OrbitControls | null;
  invalidate: () => void;
}

export const rig: Rig = { camera: new THREE.PerspectiveCamera(), dom: null as unknown as HTMLElement, controls: null, invalidate: () => {} };

const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

/** The plan point under a screen position on a level's floor, or null if the ray misses it. */
export function planAt(doc: SceneDoc, levelId: Id, clientX: number, clientY: number): Vec2 | null {
  const r = rig.dom.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, rig.camera);
  plane.constant = -world.levelY(levelId);
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  return world.toPlan(doc, levelId, hit);
}

/** Whether an object and all its parents are shown; hidden (solo) levels must not take clicks. */
export function shown(o: THREE.Object3D | null): boolean {
  for (let n = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

type Edit = (base: SceneDoc, from: Vec2, to: Vec2) => SceneDoc;

/** Starts a drag from a pointer-down on a mesh or handle. */
export function startDrag(e: ThreeEvent<PointerEvent>, target: Id, what: Extract<Interaction, { kind: 'dragging' }>['what'], label: string, edit: Edit) {
  const s = editor.getState();
  // Clients do not move things: a press only selects, through the click handlers.
  if (e.button !== 0 || s.tool !== 'select' || !shown(e.object) || s.role.kind === 'client') return;
  // A building is dragged on its lowest floor's plane.
  const node = s.doc.nodes[target];
  const level = node?.type === 'building'
    ? node.children.map(c => s.doc.nodes[c]).filter(l => l?.type === 'level').sort((p, q) => (p as { elevation: number }).elevation - (q as { elevation: number }).elevation)[0] as { id: Id } | undefined
    : ancestor(s.doc, target, 'level');
  if (!level) return;
  e.stopPropagation();
  const from = planAt(s.doc, level.id, e.clientX, e.clientY);
  if (!from) return;
  select(target);
  begin(label);
  setInteraction({ kind: 'dragging', target, what });
  if (rig.controls) rig.controls.enabled = false;

  const move = (ev: PointerEvent) => {
    const to = planAt(editor.getState().gesture?.doc ?? editor.getState().doc, level.id, ev.clientX, ev.clientY);
    if (to) preview(base => edit(base, from, to));
    rig.invalidate();
  };
  const stop = (commitIt: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', abort);
    window.removeEventListener('keydown', key, true);
    if (commitIt) end(); else cancel();
    if (rig.controls) rig.controls.enabled = true;
    rig.invalidate();
  };
  const up = () => stop(true);
  const abort = () => stop(false);
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); stop(false); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', abort);
  window.addEventListener('keydown', key, true);
}

// ---- the edits each handle drives -------------------------------------------------

const plus = (p: Vec2, from: Vec2, to: Vec2): Vec2 => [p[0] + to[0] - from[0], p[1] + to[1] - from[1]];

/**
 * Every edit moves by the pointer's travel, not to the pointer, so a handle
 * grabbed on top of a wall does not jump to the floor point behind it.
 */
export const edits = {
  /** The wall body slides along its normal. */
  wall: (id: Id): Edit => (base, from, to) => {
    const w = base.nodes[id];
    if (w?.type !== 'wall') return base;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    const len = Math.hypot(dx, dy);
    const offset = ((to[0] - from[0]) * -dy + (to[1] - from[1]) * dx) / len;
    return offsetWall(base, id, offset);
  },
  wallEnd: (id: Id, which: 'a' | 'b'): Edit => (base, from, to) => {
    const w = base.nodes[id];
    return w?.type === 'wall' ? moveWallEnd(base, id, which, plus(w[which], from, to)) : base;
  },
  point: (id: Id, index: number): Edit => (base, from, to) => {
    const n = base.nodes[id];
    return n?.type === 'zone' || n?.type === 'slab' ? movePoint(base, id, index, plus(n.points[index], from, to)) : base;
  },
  /** Drags a new point out of the middle of the edge after `index`. */
  insert: (id: Id, index: number): Edit => (base, from, to) => {
    const n = base.nodes[id];
    if (n?.type !== 'zone' && n?.type !== 'slab') return base;
    const p = n.points[index], q = n.points[(index + 1) % n.points.length];
    if (Math.abs(to[0] - from[0]) < 0.125 && Math.abs(to[1] - from[1]) < 0.125) return base;
    return insertPoint(base, id, index, plus([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], from, to));
  },
  translate: (id: Id): Edit => (base, from, to) => translate(base, id, [to[0] - from[0], to[1] - from[1]]),
  /** A whole building moves with the pointer, snapped to the grid. */
  building: (id: Id): Edit => (base, from, to) => {
    const b = base.nodes[id];
    return b?.type === 'building' ? setOrigin(base, id, [b.origin[0] + to[0] - from[0], b.origin[1] + to[1] - from[1]]) : base;
  },
  /** A door or window slides along its wall by the pointer's travel along the wall. */
  opening: (id: Id): Edit => (base, from, to) => {
    const o = base.nodes[id];
    const w = o?.type === 'opening' ? base.nodes[o.parent] : undefined;
    if (w?.type !== 'wall') return base;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    const along = ((to[0] - from[0]) * dx + (to[1] - from[1]) * dy) / Math.hypot(dx, dy);
    return slideOpening(base, id, along);
  },
};

/** In the door or window tool, a click on a wall puts one there, centred on the click. */
export function placeOpening(wallId: Id, worldPoint: THREE.Vector3): boolean {
  const s = editor.getState();
  if (s.interaction.kind !== 'placing') return false;
  const what = s.interaction.what;
  const level = ancestor(s.doc, wallId, 'level');
  if (!level) return false;
  const at = world.toPlan(s.doc, level.id, worldPoint);
  let made: Id | null = null;
  const ok = commit(doc => { const [next, id] = addOpeningAt(doc, wallId, what, at); made = id; return next; }, what === 'door' ? 'Add door' : 'Add window');
  if (ok && made) select(made);
  rig.invalidate();
  return ok;
}

// ---- the wall tool ------------------------------------------------------------------

/**
 * In the wall tool a click (not a drag, which still orbits) places a point.
 * Each point after the first adds a wall from the previous one, so walls
 * chain; Escape or a right-click ends the chain.
 */
export function attachWallTool(dom: HTMLElement): () => void {
  let down: { x: number; y: number } | null = null;
  const point = (ev: PointerEvent): Vec2 | null => {
    const s = editor.getState();
    if (s.interaction.kind !== 'drawing-wall') return null;
    const p = planAt(s.doc, s.interaction.level, ev.clientX, ev.clientY);
    return p ? snapPoint(p) : null;
  };
  const onDown = (ev: PointerEvent) => {
    if (editor.getState().tool !== 'wall') return;
    if (ev.button === 2) { endChain(); return; }
    if (ev.button === 0) down = { x: ev.clientX, y: ev.clientY };
  };
  const onMove = (ev: PointerEvent) => {
    const s = editor.getState();
    if (s.tool !== 'wall' || s.interaction.kind !== 'drawing-wall') return;
    const to = point(ev);
    const i = s.interaction;
    if (to && (!i.to || to[0] !== i.to[0] || to[1] !== i.to[1])) { setInteraction({ ...i, to }); rig.invalidate(); }
  };
  const onUp = (ev: PointerEvent) => {
    const s = editor.getState();
    if (s.tool !== 'wall' || !down || ev.button !== 0) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    down = null;
    if (moved > 5 || s.interaction.kind !== 'drawing-wall') return;
    const p = point(ev);
    if (!p) return;
    const i = s.interaction;
    if (!i.from) { setInteraction({ ...i, from: p, to: p }); return; }
    if (p[0] === i.from[0] && p[1] === i.from[1]) return;
    if (commit(doc => addWall(doc, i.level, { a: i.from!, b: p })[0], 'Draw wall')) setInteraction({ ...i, from: p, to: p });
    rig.invalidate();
  };
  const onMenu = (ev: Event) => { if (editor.getState().tool === 'wall') ev.preventDefault(); };
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('contextmenu', onMenu);
  return () => {
    dom.removeEventListener('pointerdown', onDown);
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', onUp);
    dom.removeEventListener('contextmenu', onMenu);
  };
}

/** Ends the current wall chain; a second call leaves the wall tool. */
export function endChain() {
  const s = editor.getState();
  if (s.interaction.kind === 'drawing-wall' && s.interaction.from) setInteraction({ ...s.interaction, from: null, to: null });
  else setTool('select');
  rig.invalidate();
}
