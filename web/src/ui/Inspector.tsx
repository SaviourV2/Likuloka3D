'use client';
/** Properties of the selected node. Each field commits one undo step when it changes. */
import { useEffect, useState } from 'react';
import { addZone, area, rename, setWallLength, updateLevel, updateOpening, updateSlab, updateWall, updateZone } from '@/scene/ops';
import { commit, isClient, removeSelected, useEditor } from '@/scene/store';
import { FLOOR_FINISHES, FLOOR_KEYS, type FloorFinish, FINISH_LABELS, frameSize, OPENING_FINISHES, ROOM_TYPES, type OpeningFinish, type OpeningNode, type RoomType, type SceneDoc, type SceneNode, type Vec2, type WallNode } from '@/scene/types';
import { applyProduct, applyWallType, formatPrice, productFor, wallTypeFor } from '@/scene/catalogue';
import { checks } from '@/scene/checks';
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

/**
 * A length, typed and shown in whole millimetres, as builders work. The model
 * is in metres; this converts both ways.
 */
function Mm({ label, value, step = 10, onCommit, hint }: { label: string; value: number; step?: number; hint?: string; onCommit: (metres: number) => void }) {
  const shown = String(Math.round(value * 1000));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const done = () => {
    const v = Number(text.replace(/[\s,]/g, ''));
    if (text.trim() === '' || !Number.isFinite(v)) { setText(shown); return; }
    if (String(Math.round(v)) !== shown) onCommit(Math.round(v) / 1000);
    else setText(shown);
  };
  return (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input inputMode="numeric" type="number" step={step} value={text} aria-label={label}
        onChange={e => setText(e.target.value)} onBlur={done}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <em>mm</em>
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

/** A room's width and depth when it is a rectangle; null for other shapes. */
function rectangle(points: readonly Vec2[]): [number, number] | null {
  if (points.length !== 4) return null;
  const xs = [...new Set(points.map(p => p[0]))], ys = [...new Set(points.map(p => p[1]))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  return [Math.abs(xs[1] - xs[0]), Math.abs(ys[1] - ys[0])];
}
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
  return <Selected node={node} error={error} />;
}

function Selected({ node, error }: { node: SceneNode; error: string | null }) {
  const client = useEditor(isClient);
  // In the client view only doors, windows and rooms can be changed; the rest is shown, disabled.
  const locked = client && node.type !== 'opening' && node.type !== 'zone';
  const id = node.id;
  return (
    <aside className="inspector" aria-label="Inspector" data-type={node.type} data-locked={locked}>
      <h2><span className={`dot dot-${node.type}`} aria-hidden="true" />{node.type === 'opening' ? (node.kind === 'door' ? 'Door' : 'Window') : node.type[0].toUpperCase() + node.type.slice(1)}</h2>
      {locked && <p className="hint">Drawn by your designer. You can change doors, windows and rooms.</p>}
      <fieldset className="plain" disabled={locked}>
      <Text label="Name" value={node.name} onCommit={v => edit(d => rename(d, id, v), 'Rename')} />
      {node.type === 'building' && (
        <div className="fields">
          <p className="figure">{node.children.length} level{node.children.length === 1 ? '' : 's'}</p>
        </div>
      )}
      {node.type === 'level' && (
        <div className="fields">
          <Mm label="Floor height" hint="Height of this floor above the ground" value={node.elevation} step={50} onCommit={v => edit(d => updateLevel(d, id, { elevation: v }), 'Change floor height')} />
          <Mm label="Storey height" hint="From this floor to the next" value={node.height} step={50} onCommit={v => edit(d => updateLevel(d, id, { height: v }), 'Change storey height')} />
          <button type="button" className="add" onClick={() => edit(d => addZone(d, id, { name: 'New zone', points: [[0, 0], [3, 0], [3, 3], [0, 3]] })[0], 'Add zone')}>+ Zone</button>
        </div>
      )}
      {node.type === 'wall' && (
        <div className="fields">
          <Mm label="Length" hint="Lengths snap to the 250 mm grid; walls joined at the far end follow" value={len(node.a, node.b)} step={250} onCommit={v => edit(d => setWallLength(d, id, v), 'Change wall length')} />
          <BuildUp wall={node} />
          <Mm label="Thickness" value={node.thickness} step={5} onCommit={v => edit(d => updateWall(d, id, { thickness: v }), 'Change wall thickness')} />
          <Mm label="Height" value={node.height} step={50} onCommit={v => edit(d => updateWall(d, id, { height: v }), 'Change wall height')} />
          <p className="figure">Drag the wall in the view to move it; drag a ball to move an end.</p>
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
          <label className="field wide">
            <span>Floor</span>
            <select value={node.floor} aria-label="Floor finish" onChange={e => edit(d => updateZone(d, id, { floor: e.target.value as FloorFinish }), 'Change floor finish')}>
              {FLOOR_KEYS.map(k => <option key={k} value={k}>{k === 'none' ? 'Colour of the use' : FLOOR_FINISHES[k].label}</option>)}
            </select>
            <i className="swatch" style={{ background: node.floor === 'none' ? USE_COLOURS[node.use] : FLOOR_FINISHES[node.floor].base }} aria-hidden="true" />
          </label>
          <RoomSize points={node.points} />
        </div>
      )}
      {node.type === 'opening' && (
        <div className="fields">
          <ProductPicker opening={node} />
          <fieldset className="plain" disabled={client}>
          <Choice label="Type" value={node.kind} options={[['door', 'Door'], ['window', 'Window']]}
            onPick={k => edit(d => updateOpening(d, id, { kind: k }), k === 'door' ? 'Make a door' : 'Make a window')} />
          </fieldset>
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
          <fieldset className="plain" disabled={client}>
          <Mm label="Width" value={node.width} step={5} onCommit={v => edit(d => updateOpening(d, id, { width: v }), 'Change opening width')} />
          <Mm label="Height" value={node.height} step={5} onCommit={v => edit(d => updateOpening(d, id, { height: v }), 'Change opening height')} />
          {node.kind === 'window' && <Mm label="Sill height" hint="From the floor to the bottom of the opening" value={node.sill} step={50} onCommit={v => edit(d => updateOpening(d, id, { sill: v }), 'Change sill height')} />}
          <Placement opening={node} />
          </fieldset>
          <dl className="measures" aria-label="Measurements">
            <dt>Opening</dt><dd data-measure="size">{mm(node.width)} × {mm(node.height)} mm</dd>
            <FrameSize opening={node} />
            <dt>Head height</dt><dd>{mm(node.sill + node.height)} mm</dd>
            {node.kind === 'window' && <><dt>Sill height</dt><dd>{mm(node.sill)} mm</dd></>}
            {node.shape === 'arched' && <><dt>Arch radius</dt><dd>{mm(node.width / 2)} mm</dd></>}
            <WallDepth wall={node.parent} />
          </dl>
          {!client && <p className="figure">Drag it in the view to slide it along its wall.</p>}
        </div>
      )}
      {node.type === 'slab' && (
        <div className="fields">
          <Mm label="Thickness" value={node.thickness} step={25} onCommit={v => edit(d => updateSlab(d, id, { thickness: v }), 'Change slab thickness')} />
          <RoomSize points={node.points} />
        </div>
      )}
      </fieldset>
      <Issues id={id} />
      {!client && <button type="button" className="danger" onClick={() => { removeSelected(); rig.invalidate(); }}>Delete {node.type === 'opening' ? node.kind : node.type}</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}

/** The thickness of an opening's wall, which its frame must span. */
function WallDepth({ wall }: { wall: string }) {
  const t = useEditor(s => { const w = s.doc.nodes[wall]; return w?.type === 'wall' ? w.thickness : 0; });
  return <><dt>Wall depth</dt><dd>{mm(t)} mm</dd></>;
}

/** The frame that fits the opening, after the project's fitting gap. */
function FrameSize({ opening }: { opening: OpeningNode }) {
  const tolerance = useEditor(s => s.doc.settings.tolerance);
  const f = frameSize(opening, tolerance);
  return <><dt>Frame</dt><dd data-measure="frame">{mm(f.width)} × {mm(f.height)} mm</dd></>;
}

/** Picks the opening's catalogue product, which sets its type, head, frame and size. */
function ProductPicker({ opening }: { opening: OpeningNode }) {
  const catalogue = useEditor(s => s.catalogue);
  const product = productFor(catalogue, opening.product);
  const group = (kind: 'door' | 'window') => catalogue.products.filter(p => p.kind === kind);
  return (
    <>
      <label className="field wide">
        <span>Product</span>
        <select aria-label="Product" value={opening.product ?? ''} onChange={e => {
          const p = productFor(catalogue, e.target.value);
          if (p) edit(d => applyProduct(d, opening.id, p), `Choose ${p.code}`);
          else edit(d => updateOpening(d, opening.id, { product: null }), 'Make it a custom size');
        }}>
          <option value="">Custom size</option>
          {opening.product && !product && <option value={opening.product}>{opening.product} (not in the catalogue)</option>}
          <optgroup label="Doors">{group('door').map(p => <option key={p.code} value={p.code}>{p.name}</option>)}</optgroup>
          <optgroup label="Windows">{group('window').map(p => <option key={p.code} value={p.code}>{p.name}</option>)}</optgroup>
        </select>
      </label>
      {product && (
        <p className="figure product">
          <b>{product.code}</b> · frame {product.width} × {product.height} mm{product.price !== undefined && <> · {formatPrice(catalogue, product.price)}</>}
        </p>
      )}
    </>
  );
}

/** The wall's build-up: a catalogue wall type, or plain. */
function BuildUp({ wall }: { wall: WallNode }) {
  const catalogue = useEditor(s => s.catalogue);
  const type = wallTypeFor(catalogue, wall.wallType);
  return (
    <>
      <label className="field wide">
        <span>Build-up</span>
        <select aria-label="Build-up" value={wall.wallType ?? ''} onChange={e => {
          const w = wallTypeFor(catalogue, e.target.value);
          if (w) edit(d => applyWallType(d, wall.id, w), `Build-up ${w.name}`);
          else edit(d => updateWall(d, wall.id, { layers: [], wallType: null }), 'Plain wall');
        }}>
          <option value="">{wall.layers.length && !type ? 'Custom build-up' : 'Plain wall'}</option>
          {catalogue.wallTypes.map(w => <option key={w.code} value={w.code}>{w.name}</option>)}
        </select>
      </label>
      {wall.layers.length > 0 && (
        <ol className="layers" aria-label="Layers">
          {wall.layers.map((l, i) => (
            <li key={i} data-kind={l.kind}><i aria-hidden="true" />{l.name}<b>{(l.thickness * 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} mm</b></li>
          ))}
        </ol>
      )}
    </>
  );
}

/** The checks' findings for the selected node. */
function Issues({ id }: { id: string }) {
  const doc = useEditor(s => s.doc);
  const catalogue = useEditor(s => s.catalogue);
  const mine = checks(doc, catalogue).filter(i => i.node === id);
  if (!mine.length) return null;
  return (
    <ul className="issues compact" aria-label="Checks">
      {mine.map(i => <li key={i.key} data-severity={i.severity} data-rule={i.rule}><span className="sev">{i.severity === 'warning' ? 'Warning' : 'Note'}</span><span>{i.message}</span></li>)}
    </ul>
  );
}

/** A room's or slab's size: width by depth when it is a rectangle, and its area. */
function RoomSize({ points }: { points: readonly Vec2[] }) {
  const r = rectangle(points);
  return (
    <dl className="measures" aria-label="Measurements">
      {r && <><dt>Size</dt><dd data-measure="room">{mm(r[0])} × {mm(r[1])} mm</dd></>}
      <dt>Area</dt><dd data-measure="area">{fmt(Math.abs(area(points)))} m²</dd>
      {!r && <><dt>Corners</dt><dd>{points.length}</dd></>}
    </dl>
  );
}

/**
 * Where an opening sits, as a builder sets it out: the distance from the
 * wall's start to the opening's near edge, and what is left to the far end.
 */
function Placement({ opening }: { opening: OpeningNode }) {
  const wallLength = useEditor(s => { const w = s.doc.nodes[opening.parent]; return w?.type === 'wall' ? len(w.a, w.b) : 0; });
  const fromStart = opening.offset - opening.width / 2;
  const toEnd = wallLength - opening.offset - opening.width / 2;
  return (
    <>
      <Mm label="From wall start" hint="From the start of the wall to the near edge of the opening" value={fromStart} step={25}
        onCommit={v => edit(d => updateOpening(d, opening.id, { offset: v + opening.width / 2 }), 'Move opening')} />
      <p className="figure">To the wall end <b data-measure="to-end">{mm(toEnd)} mm</b></p>
    </>
  );
}
