'use client';
/**
 * React mounts one three.js object per scene node and registers it with the
 * ECS world. A component subscribes only to its node's `children` list, so
 * React re-renders when nodes are added or removed and never when a node's
 * data changes: the world's systems update those objects directly.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { furniture } from '@/ecs/furniture';
import { world } from '@/ecs/world';
import { CUT, materials, UNIT_BOX } from '@/ecs/materials';
import { editor, select, useEditor } from '@/scene/store';
import type { Id, NodeType, SceneNode, Vec2 } from '@/scene/types';
import { inset } from '@/scene/furnish';
import { edits, placeOpening, pressUnderlay, rig, shown, startDrag, startPlotDrag } from './interact';

const EMPTY: readonly Id[] = [];

function useEntity<T extends THREE.Object3D>(id: Id, kind: NodeType) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const o = ref.current!;
    world.register(id, kind, o);
    rig.invalidate();
    return () => { world.unregister(id, o); rig.invalidate(); };
  }, [id, kind]);
  return ref;
}

const children = (id: Id) => (s: { doc: { nodes: Record<Id, SceneNode> } }) => {
  const n = s.doc.nodes[id];
  return n && 'children' in n ? n.children : EMPTY;
};

function cursor(c: string) { if (rig.dom) rig.dom.style.cursor = c; }

/** Selects on a click that did not travel; a drag on content still orbits. */
function clickSelect(id: Id) {
  return (e: ThreeEvent<MouseEvent>) => {
    if (!shown(e.object) || e.delta > 4 || editor.getState().tool !== 'select') return;
    e.stopPropagation();
    select(id);
    rig.invalidate();
  };
}

export function SceneRoot() {
  const roots = useEditor(s => s.doc.roots);
  return <>{roots.map(id => <Building key={id} id={id} />)}<Plot /><Traced /></>;
}

const TRACE_LINE = new THREE.LineBasicMaterial({ color: '#9fe0ff', transparent: true, depthWrite: false, toneMapped: false });
const FLAT = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/** Just above the rooms' fills, so the drawing shows over them. */
const TRACE_Y = 0.02;

/**
 * The drawing being traced: a picture or the lines of a CAD file, lying on the
 * ground and see-through so the model shows with it. It takes the pointer
 * only while the trace tool is on.
 */
function Traced() {
  const u = useEditor(s => s.underlay);
  const tracing = useEditor(s => s.tool === 'trace');
  const marks = useEditor(s => (s.interaction.kind === 'scaling-underlay' ? s.interaction : null));
  const url = u?.kind === 'image' ? u.url : null;
  const texture = useMemo(() => {
    if (!url) return null;
    const t = new THREE.TextureLoader().load(url, () => rig.invalidate());
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [url]);
  useLayoutEffect(() => () => texture?.dispose(), [texture]);
  const segments = u?.kind === 'lines' ? u.segments : null;
  const lines = useMemo(() => {
    if (!segments) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segments.flatMap(([a, b]) => [a[0], 0, a[1], b[0], 0, b[1]]), 3));
    return g;
  }, [segments]);
  useLayoutEffect(() => () => lines?.dispose(), [lines]);
  const picture = useMemo(() => (texture ? new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }) : null), [texture]);
  useLayoutEffect(() => () => picture?.dispose(), [picture]);
  if (!u || !u.shown) return null;
  if (picture) picture.opacity = u.opacity;
  TRACE_LINE.opacity = u.opacity;
  const h = u.kind === 'image' ? u.width / u.aspect : 0;
  return (
    <group userData={{ underlay: true }}>
      {u.kind === 'image' && picture && (
        <mesh geometry={FLAT} material={picture} position={[u.at[0] + u.width / 2, TRACE_Y, u.at[1] + h / 2]} scale={[u.width, 1, h]} renderOrder={5}
          {...(tracing ? { onPointerDown: pressUnderlay, onPointerOver: () => cursor(marks ? 'crosshair' : 'move'), onPointerOut: () => cursor('') } : {})} />
      )}
      {u.kind === 'lines' && lines && <lineSegments geometry={lines} material={TRACE_LINE} position={[u.at[0], TRACE_Y, u.at[1]]} renderOrder={5} />}
      {marks?.a && <mesh geometry={SMALL} material={materials.preview} position={[marks.a[0], TRACE_Y + 0.05, marks.a[1]]} renderOrder={11} />}
      {marks?.b && <mesh geometry={SMALL} material={materials.preview} position={[marks.b[0], TRACE_Y + 0.05, marks.b[1]]} renderOrder={11} />}
    </group>
  );
}

const PLOT_LINE = new THREE.MeshBasicNodeMaterial({ color: '#ffd166', toneMapped: false });
const SETBACK_LINE = new THREE.MeshBasicNodeMaterial({ color: '#ffd166', toneMapped: false, transparent: true, opacity: 0.4, depthWrite: false });

/** A closed line on the ground, drawn as one flat box per side so it has a width a line would not. */
function GroundLine({ points, width, material, y }: { points: readonly Vec2[]; width: number; material: THREE.Material; y: number }) {
  return (
    <>
      {points.map((p, i) => {
        const q = points[(i + 1) % points.length], dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz);
        return len < 1e-6 ? null : <mesh key={i} geometry={UNIT_BOX} material={material} position={[(p[0] + q[0]) / 2, y, (p[1] + q[1]) / 2]}
          rotation={[0, -Math.atan2(dz, dx), 0]} scale={[len + width, 0.02, width]} />;
      })}
    </>
  );
}

/**
 * The plot: the land's boundary, and inside it the line the project keeps
 * buildings behind. It is not a node, and it is redrawn only when the plot or
 * the distance changes. With the plot tool its corners can be dragged.
 */
function Plot() {
  const plot = useEditor(s => s.doc.plot);
  const setback = useEditor(s => s.doc.settings.setback);
  const editing = useEditor(s => s.tool === 'plot' && s.role.kind !== 'client');
  const inner = useMemo(() => (plot && setback > 0 ? inset(plot.map(p => [p[0], p[1]] as [number, number]), plot.map(() => setback)) : null), [plot, setback]);
  if (!plot) return null;
  return (
    <group userData={{ plot: true }}>
      <GroundLine points={plot} width={0.12} material={PLOT_LINE} y={-0.24} />
      {inner && <GroundLine points={inner} width={0.05} material={SETBACK_LINE} y={-0.245} />}
      {editing && plot.map((p, i) => <Handle key={`p${i}`} at={p} lift={0} onDown={e => startPlotDrag(e, i, false)} />)}
      {editing && plot.map((p, i) => {
        const q = plot[(i + 1) % plot.length];
        return <Handle key={`m${i}`} small at={[(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]} lift={0} onDown={e => startPlotDrag(e, i, true)} />;
      })}
    </group>
  );
}

function Building({ id }: { id: Id }) {
  const ref = useEntity<THREE.Group>(id, 'building');
  const levels = useEditor(children(id));
  return <group ref={ref}>{levels.map(l => <Level key={l} id={l} />)}<MoveRing building={id} /></group>;
}

const RING = new THREE.TorusGeometry(0.55, 0.07, 12, 48);
const DOT = new THREE.CircleGeometry(0.22, 32);

/**
 * The handle that moves a whole building: a ring on the ground at the middle
 * of its lowest floor. It shows when the building, one of its levels or a
 * floor slab is selected.
 */
function MoveRing({ building }: { building: Id }) {
  const show = useEditor(s => {
    if (s.tool !== 'select' || s.role.kind === 'client' || !s.selection) return false;
    let n = s.doc.nodes[s.selection];
    if (n?.type === 'slab') n = s.doc.nodes[n.parent];
    if (n?.type === 'level') n = s.doc.nodes[n.parent];
    return n?.id === building;
  });
  // Middle of the lowest floor's walls, as text so the ring re-renders only when it moves.
  const at = useEditor(s => {
    const b = s.doc.nodes[building];
    if (b?.type !== 'building') return '';
    const lowest = b.children.map(c => s.doc.nodes[c]).filter(l => l?.type === 'level').sort((p, q) => (p as { elevation: number }).elevation - (q as { elevation: number }).elevation)[0];
    if (lowest?.type !== 'level') return '';
    const pts = lowest.children.map(c => s.doc.nodes[c]).flatMap(n => (n?.type === 'wall' ? [n.a, n.b] : n?.type === 'slab' ? n.points : []));
    if (!pts.length) return '0,0';
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return `${(Math.min(...xs) + Math.max(...xs)) / 2},${(Math.min(...ys) + Math.max(...ys)) / 2}`;
  });
  if (!show || !at) return null;
  const [x, z] = at.split(',').map(Number);
  return (
    <group position={[x, 0.08, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh geometry={RING} material={materials.handleRing} renderOrder={10} userData={{ handle: true }}
        onPointerDown={e => startDrag(e, building, 'building', 'Move building', edits.building(building))}
        onPointerOver={e => { if (shown(e.object)) { e.stopPropagation(); cursor('move'); } }}
        onPointerOut={() => cursor('')} />
      <mesh geometry={DOT} material={materials.insert} renderOrder={10} userData={{ handle: true }}
        onPointerDown={e => startDrag(e, building, 'building', 'Move building', edits.building(building))}
        onPointerOver={e => { if (shown(e.object)) { e.stopPropagation(); cursor('move'); } }}
        onPointerOut={() => cursor('')} />
    </group>
  );
}

/** The level's furniture: an empty group the furniture system fills. */
function Furnishings({ level }: { level: Id }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const g = ref.current!;
    furniture.attach(level, g);
    rig.invalidate();
    return () => { furniture.detach(level, g); };
  }, [level]);
  return <group ref={ref} />;
}

function Level({ id }: { id: Id }) {
  const ref = useEntity<THREE.Group>(id, 'level');
  const kids = useEditor(children(id));
  const types = useEditor(s => kids.map(k => s.doc.nodes[k]?.type).join());
  const list = types.split(',');
  return (
    <group ref={ref}>
      {kids.map((k, i) => list[i] === 'wall' ? <Wall key={k} id={k} />
        : list[i] === 'zone' ? <Zone key={k} id={k} />
        : list[i] === 'slab' ? <Slab key={k} id={k} /> : null)}
      <Furnishings level={id} />
      <Handles level={id} />
      <WallPreview level={id} />
    </group>
  );
}

/** The pieces of a wall are built by the walls system; React only owns the group and its openings. */
function Wall({ id }: { id: Id }) {
  const ref = useEntity<THREE.Group>(id, 'wall');
  const openings = useEditor(children(id));
  return (
    <group
      ref={ref}
      matrixAutoUpdate={false}
      onPointerDown={e => startDrag(e, id, 'wall', 'Move wall', edits.wall(id))}
      onClick={e => {
        if (!shown(e.object) || e.delta > 4) return;
        if (editor.getState().interaction.kind === 'placing') { e.stopPropagation(); placeOpening(id, e.point); return; }
        // A click on a wall stops at the wall, so it never selects what is behind it.
        clickSelect(id)(e);
      }}
      onPointerOver={e => {
        if (!shown(e.object)) return;
        const tool = editor.getState().tool;
        if (tool === 'select' || tool === 'door' || tool === 'window') { e.stopPropagation(); cursor(tool === 'select' ? 'grab' : 'copy'); }
      }}
      onPointerOut={() => cursor('')}
    >
      {openings.map(o => <Opening key={o} id={o} />)}
    </group>
  );
}

/** A door or window. A drag slides it along its wall; a click selects it. */
function Opening({ id }: { id: Id }) {
  const ref = useEntity<THREE.Group>(id, 'opening');
  return (
    <group
      ref={ref}
      matrixAutoUpdate={false}
      onPointerDown={e => {
        const o = editor.getState().doc.nodes[id];
        startDrag(e, id, 'opening', o?.type === 'opening' && o.kind === 'door' ? 'Move door' : 'Move window', edits.opening(id));
      }}
      onClick={clickSelect(id)}
      onPointerOver={e => { if (shown(e.object) && editor.getState().tool === 'select') { e.stopPropagation(); cursor('ew-resize'); } }}
      onPointerOut={() => cursor('')}
    />
  );
}

function Slab({ id }: { id: Id }) {
  const ref = useEntity<THREE.Mesh>(id, 'slab');
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  return <mesh ref={ref} geometry={geometry} material={materials.slab} receiveShadow onClick={clickSelect(id)} />;
}

function Zone({ id }: { id: Id }) {
  const ref = useEntity<THREE.Mesh>(id, 'zone');
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  return (
    <mesh
      ref={ref}
      geometry={geometry}
      renderOrder={2}
      onClick={clickSelect(id)}
      // A selected zone moves with a drag; an unselected one lets the drag orbit.
      onPointerDown={e => { if (editor.getState().selection === id) startDrag(e, id, 'zone', 'Move zone', edits.translate(id)); }}
    />
  );
}

// ---- handles ----------------------------------------------------------------------

const BALL = new THREE.SphereGeometry(0.16, 20, 12);
const SMALL = new THREE.SphereGeometry(0.1, 16, 10);

function Handle({ at, lift, small, onDown }: { at: Vec2; lift: number; small?: boolean; onDown: (e: ThreeEvent<PointerEvent>) => void }) {
  return (
    <mesh
      geometry={small ? SMALL : BALL}
      material={small ? materials.insert : materials.handleRing}
      position={[at[0], lift, at[1]]}
      renderOrder={10}
      userData={{ handle: true }}
      onPointerDown={onDown}
      onPointerOver={e => { if (shown(e.object)) { e.stopPropagation(); cursor('move'); } }}
      onPointerOut={() => cursor('')}
    />
  );
}

/** Handles for the selected node, if it is on this level. Re-renders only when that node changes. */
function Handles({ level }: { level: Id }) {
  const node = useEditor(s => {
    const n = s.selection ? s.doc.nodes[s.selection] : undefined;
    return n && n.parent === level ? n : null;
  });
  const tool = useEditor(s => s.tool);
  const cut = useEditor(s => s.cut);
  const client = useEditor(s => s.role.kind === 'client');
  if (!node || tool !== 'select' || client) return null;
  if (node.type === 'wall') {
    const top = cut ? Math.min(node.height, CUT) : node.height;
    return (
      <>
        {(['a', 'b'] as const).map(end => (
          <Handle key={end} at={node[end]} lift={top + 0.2}
            onDown={e => startDrag(e, node.id, 'wall-end', 'Move wall end', edits.wallEnd(node.id, end))} />
        ))}
      </>
    );
  }
  if (node.type !== 'zone' && node.type !== 'slab') return null;
  const label = node.type === 'slab' ? 'Reshape slab' : 'Reshape zone';
  const lift = node.type === 'slab' ? 0.06 : 0.08;
  return (
    <>
      {node.points.map((p, i) => (
        <Handle key={`p${i}`} at={p} lift={lift} onDown={e => startDrag(e, node.id, 'point', label, edits.point(node.id, i))} />
      ))}
      {node.points.map((p, i) => {
        const q = node.points[(i + 1) % node.points.length];
        return <Handle key={`m${i}`} small at={[(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]} lift={lift}
          onDown={e => startDrag(e, node.id, 'insert', label, edits.insert(node.id, i))} />;
      })}
    </>
  );
}

/** The wall being drawn, from the last point to the pointer. */
function WallPreview({ level }: { level: Id }) {
  const i = useEditor(s => s.interaction);
  const height = useEditor(s => { const l = s.doc.nodes[level]; return l?.type === 'level' ? l.height : 3; });
  if (i.kind !== 'drawing-wall' || i.level !== level || !i.to) return null;
  const dot = <mesh geometry={SMALL} material={materials.preview} position={[i.to[0], 0.05, i.to[1]]} renderOrder={10} />;
  if (!i.from) return dot;
  const dx = i.to[0] - i.from[0], dz = i.to[1] - i.from[1];
  const len = Math.hypot(dx, dz);
  return (
    <>
      {dot}
      {len > 0 && (
        <mesh geometry={UNIT_BOX} material={materials.preview} userData={{ y0: 0 }}
          position={[(i.from[0] + i.to[0]) / 2, height / 2, (i.from[1] + i.to[1]) / 2]}
          rotation={[0, -Math.atan2(dz, dx), 0]}
          scale={[len + 0.2, height, 0.2]} />
      )}
    </>
  );
}
