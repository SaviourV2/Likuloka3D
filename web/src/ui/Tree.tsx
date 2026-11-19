'use client';
/**
 * The hierarchy: building → level → slab, zones and walls. Each row reads
 * only its own node's name and whether it is selected, so editing one node
 * re-renders one row.
 */
import { addLevelAbove } from '@/scene/ops';
import { commit, select, setView, useEditor } from '@/scene/store';
import type { Id, LevelMode, SceneNode } from '@/scene/types';
import { rig } from '@/render/interact';

const EMPTY: readonly Id[] = [];
const kids = (id: Id) => (s: { doc: { nodes: Record<Id, SceneNode> } }) => {
  const n = s.doc.nodes[id];
  return n && 'children' in n ? n.children : EMPTY;
};

function Row({ id, depth, extra }: { id: Id; depth: number; extra?: React.ReactNode }) {
  const name = useEditor(s => s.doc.nodes[id]?.name ?? '');
  const type = useEditor(s => s.doc.nodes[id]?.type);
  const selected = useEditor(s => s.selection === id);
  return (
    <div className="row" data-depth={depth} aria-selected={selected} data-type={type}>
      <button type="button" className="row-name" data-id={id} onClick={() => { select(id); rig.invalidate(); }}>
        <span className={`dot dot-${type}`} aria-hidden="true" />
        {name}
      </button>
      {extra}
    </div>
  );
}

function Group({ label, ids, depth }: { label: string; ids: readonly Id[]; depth: number }) {
  if (!ids.length) return null;
  return (
    <details className="group" data-depth={depth}>
      <summary>{label} <span className="count">{ids.length}</span></summary>
      {ids.map(id => <WallRows key={id} id={id} depth={depth + 1} />)}
    </details>
  );
}

/** A row, and for a wall the rows of its doors and windows under it. */
function WallRows({ id, depth }: { id: Id; depth: number }) {
  const openings = useEditor(kids(id));
  return (
    <>
      <Row id={id} depth={depth} />
      {openings.map(o => <Row key={o} id={o} depth={depth + 1} />)}
    </>
  );
}

function Level({ id, building }: { id: Id; building: Id }) {
  const children = useEditor(kids(id));
  const typeKey = useEditor(s => children.map(c => s.doc.nodes[c]?.type).join());
  const types = typeKey.split(',');
  const of = (t: string) => children.filter((_, i) => types[i] === t);
  const mode = useEditor(s => s.views[building]?.mode);
  const solo = useEditor(s => s.views[building]?.solo === id);
  return (
    <div className="level">
      <Row id={id} depth={1} extra={mode === 'solo' && (
        <button type="button" className="mini" aria-pressed={solo} onClick={() => setView(building, { solo: id })}>
          {solo ? 'Shown' : 'Show'}
        </button>
      )} />
      {of('slab').map(s => <Row key={s} id={s} depth={2} />)}
      <Group label="Zones" ids={of('zone')} depth={2} />
      <Group label="Walls" ids={of('wall')} depth={2} />
    </div>
  );
}

const MODES: [LevelMode, string][] = [['stack', 'Stack'], ['explode', 'Explode'], ['solo', 'Solo']];

function Building({ id }: { id: Id }) {
  const levels = useEditor(kids(id));
  const elevKey = useEditor(s => levels.map(l => { const n = s.doc.nodes[l]; return n?.type === 'level' ? n.elevation : 0; }).join());
  const elev = elevKey.split(',').map(Number);
  // Top floor first, as in a section.
  const order = levels.map((l, i) => [l, elev[i]] as const).sort((p, q) => q[1] - p[1]).map(p => p[0]);
  const mode = useEditor(s => s.views[id]?.mode ?? 'stack');
  return (
    <section className="building" aria-label="Building">
      <Row id={id} depth={0} />
      <div className="segmented" role="radiogroup" aria-label="Levels">
        {MODES.map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} data-mode={m}
            onClick={() => setView(id, { mode: m })}>{label}</button>
        ))}
      </div>
      {order.map(l => <Level key={l} id={l} building={id} />)}
      <button type="button" className="add" onClick={() => commit(doc => addLevelAbove(doc, id)[0], 'Add level')}>+ Level on top</button>
    </section>
  );
}

export default function Tree() {
  const roots = useEditor(s => s.doc.roots);
  return (
    <nav className="tree" aria-label="Scene">
      <h2>Scene</h2>
      {roots.map(id => <Building key={id} id={id} />)}
    </nav>
  );
}
