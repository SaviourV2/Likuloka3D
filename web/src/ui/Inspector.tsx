'use client';
/** Properties of the selected node. Each field commits one undo step when it changes. */
import { useEffect, useState } from 'react';
import { addZone, area, rename, setOrigin, updateLevel, updateOpening, updateSlab, updateWall, updateZone } from '@/scene/ops';
import { commit, removeSelected, useEditor } from '@/scene/store';
import { FINISH_LABELS, OPENING_FINISHES, ROOM_TYPES, type OpeningFinish, type RoomType, type SceneDoc, type Vec2 } from '@/scene/types';
import { FINISH_SWATCH, USE_COLOURS } from '@/ecs/materials';

/** A row of mutually exclusive choices that each commit one undo step. */
function Choice<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="field wide">
      <span>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} data-value={v} onClick={() => { if (v !== value) onPick(v); }}>{text}</button>
        ))}
      </div>
    </div>
  );
}

const mm = (m: number) => Math.round(m * 1000).toLocaleString('en-GB');
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
          <li><kbd>D</kbd> Door, <kbd>N</kbd> Window: click a wall to add one. Drag one to slide it.</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> Redo</li>
          <li><kbd>M</kbd> Measure doors and windows, <kbd>Ctrl</kbd>+<kbd>S</kbd> Save</li>
          <li><kbd>F</kbd> Frame the selection or the scene, <kbd>Esc</kbd> Cancel</li>
        </ul>
        {error && <p className="error" role="alert">{error}</p>}
      </aside>
    );
  }
  const id = node.id;
  return (
    <aside className="inspector" aria-label="Inspector" data-type={node.type}>
      <h2><span className={`dot dot-${node.type}`} aria-hidden="true" />{node.type === 'opening' ? (node.kind === 'door' ? 'Door' : 'Window') : node.type[0].toUpperCase() + node.type.slice(1)}</h2>
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
      {node.type === 'opening' && (
        <div className="fields">
          <Choice label="Type" value={node.kind} options={[['door', 'Door'], ['window', 'Window']]}
            onPick={k => edit(d => updateOpening(d, id, { kind: k }), k === 'door' ? 'Make a door' : 'Make a window')} />
          <Choice label="Head" value={node.shape} options={[['square', 'Square'], ['arched', 'Rounded']]}
            onPick={v => edit(d => updateOpening(d, id, { shape: v }), v === 'arched' ? 'Round the head' : 'Square the head')} />
          <label className="field wide">
            <span>Frame</span>
            <select value={node.finish} aria-label="Frame" onChange={e => edit(d => updateOpening(d, id, { finish: e.target.value as OpeningFinish }), 'Change frame')}>
              {OPENING_FINISHES.map(f => <option key={f} value={f}>{FINISH_LABELS[f]}</option>)}
            </select>
            <i className="swatch" style={{ background: FINISH_SWATCH[node.finish] }} aria-hidden="true" />
          </label>
          <Choice label="Drawn" value={node.state} options={[['closed', 'Closed'], ['open', 'Open']]}
            onPick={v => edit(d => updateOpening(d, id, { state: v }), v === 'open' ? `Open the ${node.kind}` : `Close the ${node.kind}`)} />
          <Num label="Width" value={node.width} onCommit={v => edit(d => updateOpening(d, id, { width: v }), 'Change opening width')} />
          <Num label="Height" value={node.height} step={0.05} onCommit={v => edit(d => updateOpening(d, id, { height: v }), 'Change opening height')} />
          <Num label="Sill" value={node.sill} step={0.05} onCommit={v => edit(d => updateOpening(d, id, { sill: v }), 'Change sill height')} />
          <Num label="Along wall" value={node.offset} step={0.125} onCommit={v => edit(d => updateOpening(d, id, { offset: v }), 'Move opening')} />
          <dl className="measures" aria-label="Measurements">
            <dt>Size</dt><dd data-measure="size">{mm(node.width)} × {mm(node.height)} mm</dd>
            <dt>Head height</dt><dd>{mm(node.sill + node.height)} mm</dd>
            {node.kind === 'window' && <><dt>Sill height</dt><dd>{mm(node.sill)} mm</dd></>}
            {node.shape === 'arched' && <><dt>Arch radius</dt><dd>{mm(node.width / 2)} mm</dd></>}
            <WallDepth wall={node.parent} />
          </dl>
          <p className="figure">Drag it in the view to slide it along its wall.</p>
        </div>
      )}
      {node.type === 'slab' && (
        <div className="fields">
          <Num label="Thickness" value={node.thickness} step={0.05} onCommit={v => edit(d => updateSlab(d, id, { thickness: v }), 'Change slab thickness')} />
          <p className="figure">Area <b>{fmt(Math.abs(area(node.points)))} m²</b> · {node.points.length} corners</p>
        </div>
      )}
      <button type="button" className="danger" onClick={() => { removeSelected(); rig.invalidate(); }}>Delete {node.type === 'opening' ? node.kind : node.type}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}

/** The thickness of an opening's wall, which its frame must span. */
function WallDepth({ wall }: { wall: string }) {
  const t = useEditor(s => { const w = s.doc.nodes[wall]; return w?.type === 'wall' ? w.thickness : 0; });
  return <><dt>Wall depth</dt><dd>{mm(t)} mm</dd></>;
}
