'use client';
/** Properties of the selected node. Each field commits one undo step when it changes. */
import { useEffect, useState } from 'react';
import { addZone, area, rename, setOrigin, updateLevel, updateSlab, updateWall, updateZone } from '@/scene/ops';
import { commit, removeSelected, useEditor } from '@/scene/store';
import { ROOM_TYPES, type RoomType, type SceneDoc, type Vec2 } from '@/scene/types';
import { USE_COLOURS } from '@/ecs/materials';
import { rig } from '@/render/interact';

function Num({ label, value, step = 0.25, onCommit, min }: { label: string; value: number; step?: number; min?: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) { setText(String(value)); return; }
    if (v !== value) onCommit(v);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input inputMode="decimal" type="number" step={step} min={min} value={text}
        onChange={e => setText(e.target.value)} onBlur={done}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <em>m</em>
    </label>
  );
}

function Text({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field wide">
      <span>{label}</span>
      <input value={text} maxLength={60} onChange={e => setText(e.target.value)}
        onBlur={() => { if (text.trim() && text !== value) onCommit(text); else setText(value); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

const fmt = (n: number) => n.toFixed(2);
const len = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const edit = (fn: (d: SceneDoc) => SceneDoc, label: string) => { commit(fn, label); rig.invalidate(); };

export default function Inspector() {
  const node = useEditor(s => (s.selection ? s.doc.nodes[s.selection] : null) ?? null);
  const error = useEditor(s => s.error);
  if (!node) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="hint">Select a building, level, wall, zone or slab in the scene or the list.</p>
        <ul className="keys">
          <li><kbd>V</kbd> Select, <kbd>W</kbd> Draw walls</li>
          <li>Drag a wall to slide it. Drag a ball to move an end or a corner.</li>
          <li>Drag a small ball to add a corner to a slab or zone.</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> Redo</li>
          <li><kbd>F</kbd> Frame the scene, <kbd>Esc</kbd> Cancel</li>
        </ul>
        {error && <p className="error" role="alert">{error}</p>}
      </aside>
    );
  }
  const id = node.id;
  return (
    <aside className="inspector" aria-label="Inspector" data-type={node.type}>
      <h2><span className={`dot dot-${node.type}`} aria-hidden="true" />{node.type[0].toUpperCase() + node.type.slice(1)}</h2>
      <Text label="Name" value={node.name} onCommit={v => edit(d => rename(d, id, v), 'Rename')} />
      {node.type === 'building' && (
        <div className="fields">
          <Num label="Origin x" value={node.origin[0]} onCommit={v => edit(d => setOrigin(d, id, [v, node.origin[1]]), 'Move building')} />
          <Num label="Origin y" value={node.origin[1]} onCommit={v => edit(d => setOrigin(d, id, [node.origin[0], v]), 'Move building')} />
          <p className="figure">{node.children.length} level{node.children.length === 1 ? '' : 's'}</p>
        </div>
      )}
      {node.type === 'level' && (
        <div className="fields">
          <Num label="Elevation" value={node.elevation} step={0.05} onCommit={v => edit(d => updateLevel(d, id, { elevation: v }), 'Change elevation')} />
          <Num label="Height" value={node.height} step={0.05} onCommit={v => edit(d => updateLevel(d, id, { height: v }), 'Change level height')} />
          <button type="button" className="add" onClick={() => edit(d => addZone(d, id, { name: 'New zone', points: [[0, 0], [3, 0], [3, 3], [0, 3]] })[0], 'Add zone')}>+ Zone</button>
        </div>
      )}
      {node.type === 'wall' && (
        <div className="fields">
          <p className="figure">Length <b>{fmt(len(node.a, node.b))} m</b></p>
          <Num label="Start x" value={node.a[0]} onCommit={v => edit(d => updateWall(d, id, { a: [v, node.a[1]] }), 'Move wall end')} />
          <Num label="Start y" value={node.a[1]} onCommit={v => edit(d => updateWall(d, id, { a: [node.a[0], v] }), 'Move wall end')} />
          <Num label="End x" value={node.b[0]} onCommit={v => edit(d => updateWall(d, id, { b: [v, node.b[1]] }), 'Move wall end')} />
          <Num label="End y" value={node.b[1]} onCommit={v => edit(d => updateWall(d, id, { b: [node.b[0], v] }), 'Move wall end')} />
          <Num label="Thickness" value={node.thickness} step={0.05} onCommit={v => edit(d => updateWall(d, id, { thickness: v }), 'Change wall thickness')} />
          <Num label="Height" value={node.height} step={0.05} onCommit={v => edit(d => updateWall(d, id, { height: v }), 'Change wall height')} />
        </div>
      )}
      {node.type === 'zone' && (
        <div className="fields">
          <label className="field wide">
            <span>Use</span>
            <select value={node.use} onChange={e => edit(d => updateZone(d, id, { use: e.target.value as RoomType }), 'Change zone use')}>
              {ROOM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <i className="swatch" style={{ background: USE_COLOURS[node.use] }} aria-hidden="true" />
          </label>
          <p className="figure">Area <b>{fmt(Math.abs(area(node.points)))} m²</b> · {node.points.length} corners</p>
        </div>
      )}
      {node.type === 'slab' && (
        <div className="fields">
          <Num label="Thickness" value={node.thickness} step={0.05} onCommit={v => edit(d => updateSlab(d, id, { thickness: v }), 'Change slab thickness')} />
          <p className="figure">Area <b>{fmt(Math.abs(area(node.points)))} m²</b> · {node.points.length} corners</p>
        </div>
      )}
      <button type="button" className="danger" onClick={() => { removeSelected(); rig.invalidate(); }}>Delete {node.type}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}
