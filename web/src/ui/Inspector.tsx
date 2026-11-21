'use client';
/** Properties of the selected node. Each field commits one undo step when it changes. */
import { useEffect, useState } from 'react';
import { addZone, area, centreOnPlot, plotAround, removePlotCorner, rename, setPlot, updateSettings, setWallLength, updateLevel, updateOpening, updateSlab, updateWall, updateZone } from '@/scene/ops';
import { commit, isClient, patchUnderlay, removeSelected, scaleUnderlay, setInteraction, setUnderlay, useEditor } from '@/scene/store';
import { fromDxf, importDxf, parseDxf, PLOT_LAYER, ROOM_LAYER, type DxfChoice, type DxfDrawing, type DxfUnit } from '@/scene/dxfin';
import { FLOOR_FINISHES, FLOOR_KEYS, ZONE_OPTIONS, type ZoneOption, type FloorFinish, FINISH_LABELS, frameSize, OPENING_FINISHES, ROOM_TYPES, type OpeningFinish, type OpeningNode, type RoomType, type SceneDoc, type SceneNode, type Vec2, type WallNode } from '@/scene/types';
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
  const plotTool = useEditor(s => s.tool === 'plot');
  const traceTool = useEditor(s => s.tool === 'trace');
  if (!node && plotTool) return <PlotPanel error={error} />;
  if (!node && traceTool) return <TracePanel error={error} />;
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
          <button type="button" className="add" data-action="add-pool" title="A swimming pool, 8 × 4 m, beside the building. Drag it into place and reshape it by its corners." onClick={() => edit(d => addZone(d, id, { name: 'Pool', use: 'pool', points: poolBeside(d, id) })[0], 'Add pool')}>+ Pool</button>
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
          {ZONE_OPTIONS[node.use] && (
            <label className="field wide">
              <span>{ZONE_OPTIONS[node.use]!.label}</span>
              <select value={node.option} aria-label="Furnishing option" onChange={e => edit(d => updateZone(d, id, { option: e.target.value as ZoneOption }), 'Change furnishing')}>
                {ZONE_OPTIONS[node.use]!.choices.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <i aria-hidden="true" />
            </label>
          )}
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
/** Reads a picture and makes it small enough to keep in memory: at most 2400 px on its long side. */
function readPicture(file: File): Promise<{ url: string; aspect: number }> {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * k)); canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = canvas.getContext('2d');
      URL.revokeObjectURL(src);
      if (!g) { reject(new Error('This browser cannot read the picture.')); return; }
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); // a see-through drawing gets a white sheet
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ url: canvas.toDataURL('image/jpeg', 0.85), aspect: canvas.width / canvas.height });
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('That file is not a picture this browser can open. Use PNG or JPG; for a PDF, save the page as a picture first.')); };
    img.src = src;
  });
}

/**
 * The trace tool's panel. A picture is laid on the ground to draw over, and
 * given its true size from one known length. A DXF file is read as it is: its
 * plot and room outlines come in at their real sizes.
 */
function TracePanel({ error }: { error: string | null }) {
  const u = useEditor(s => s.underlay);
  const marks = useEditor(s => (s.interaction.kind === 'scaling-underlay' ? s.interaction : null));
  const [drawing, setDrawing] = useState<DxfDrawing | null>(null);
  const [choice, setChoice] = useState<DxfChoice>({ unit: 'mm', plot: null, rooms: null });
  const [lines, setLines] = useState(true);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const open = async (file: File | undefined) => {
    if (!file) return;
    setSaid(null);
    try {
      if (/\.dxf$/i.test(file.name)) {
        const d = parseDxf(await file.text());
        const closed = d.layers.filter(l => l.closed.length);
        setDrawing(d);
        setChoice({ unit: d.unit, plot: closed.find(l => PLOT_LAYER.test(l.name))?.name ?? null, rooms: closed.find(l => ROOM_LAYER.test(l.name) && !PLOT_LAYER.test(l.name))?.name ?? null });
      } else {
        const p = await readPicture(file);
        setDrawing(null);
        setUnderlay({ kind: 'image', ...p, at: [0, 0], width: 20, opacity: 0.45, shown: true });
        rig.invalidate();
        setSaid({ text: 'The picture is on the ground, 20 m wide for now. Give it its true size from a length you know, then drag it into place.' });
      }
    } catch (e) { setSaid({ text: e instanceof Error ? e.message : 'That file could not be read.', bad: true }); }
  };
  const bring = () => {
    if (!drawing) return;
    let got: { plot: boolean; rooms: number; pools: number; at: Vec2; replaced: boolean } = { plot: false, rooms: 0, pools: 0, at: [0, 0], replaced: false };
    const done = commit(d => { const [next, g] = importDxf(d, drawing, choice); got = g; return next; }, 'Import drawing');
    if (!done) return;
    if (lines) setUnderlay({ kind: 'lines', segments: fromDxf(drawing, choice, got.at).segments, at: [0, 0], opacity: 0.7, shown: true });
    setDrawing(null);
    rig.invalidate();
    const parts = [got.plot && 'the plot', got.rooms && `${got.rooms} room${got.rooms === 1 ? '' : 's'}`, got.pools && `${got.pools} pool${got.pools === 1 ? '' : 's'}`].filter(Boolean);
    setSaid({ text: parts.length ? `Brought in ${parts.join(', ')}${got.at[0] || got.at[1] ? ', beside what was already drawn' : ''}.${got.replaced ? ' It replaced the plot the project had.' : ''} One undo takes it back.` : lines ? 'Its lines are on the ground to draw over. Nothing was added to the project.' : 'Nothing was chosen to bring in.' });
  };
  const closed = drawing ? drawing.layers.filter(l => l.closed.length) : [];
  const k = { mm: 0.001, cm: 0.01, m: 1 }[choice.unit];
  return (
    <aside className="inspector" aria-label="Inspector" data-type="trace">
      <h2>Trace a drawing</h2>
      <p className="hint">A picture (PNG or JPG) is laid on the ground to draw over. A DXF file from AutoCAD is read exactly: its plot and room outlines come in at their real sizes.</p>
      <label className="file-button">Choose a picture or DXF file…<input type="file" accept="image/png,image/jpeg,image/webp,.dxf" data-action="trace-file" onChange={e => { void open(e.target.files?.[0]); e.target.value = ''; }} /></label>
      {said && <p className={said.bad ? 'error' : 'notice'} role="status" data-trace-said>{said.text}</p>}
      {drawing && (
        <div className="fields" data-trace="dxf">
          <dl className="measures"><dt>Size</dt><dd data-measure="dxf-size">{fmt(drawing.size[0] * k)} × {fmt(drawing.size[1] * k)} m</dd></dl>
          <label className="field wide"><span>Drawn in</span>
            <select value={choice.unit} aria-label="Drawing unit" onChange={e => setChoice({ ...choice, unit: e.target.value as DxfUnit })}>
              <option value="mm">millimetres</option><option value="cm">centimetres</option><option value="m">metres</option>
            </select><i aria-hidden="true" /></label>
          <p className="hint">{drawing.stated ? 'The file states its unit.' : 'The file does not state its unit; this one is a guess from its size. Check the size above.'}</p>
          <label className="field wide"><span>Plot</span>
            <select value={choice.plot ?? ''} aria-label="Plot layer" onChange={e => setChoice({ ...choice, plot: e.target.value || null })}>
              <option value="">None</option>{closed.map(l => <option key={l.name} value={l.name}>{l.name} ({l.closed.length})</option>)}
            </select><i aria-hidden="true" /></label>
          <label className="field wide"><span>Rooms</span>
            <select value={choice.rooms ?? ''} aria-label="Rooms layer" onChange={e => setChoice({ ...choice, rooms: e.target.value || null })}>
              <option value="">None</option>{closed.map(l => <option key={l.name} value={l.name}>{l.name} ({l.closed.length})</option>)}
            </select><i aria-hidden="true" /></label>
          <p className="hint">Each closed polyline on the rooms layer becomes a room, named by the text inside it; its corners move to the nearest 250 mm, so rooms drawn to the inside of their walls still share one wall. The largest on the plot layer becomes the plot.{closed.length ? '' : ' This file has no closed polylines, so only its lines can be shown.'}</p>
          <label className="check"><input type="checkbox" checked={lines} onChange={e => setLines(e.target.checked)} /> Show its lines on the ground to draw over</label>
          <button type="button" className="add" data-action="dxf-import" onClick={bring}>Bring it in</button>
        </div>
      )}
      {u && (
        <div className="fields" data-trace={u.kind}>
          <label className="check"><input type="checkbox" checked={u.shown} data-action="trace-shown" onChange={e => { patchUnderlay({ shown: e.target.checked }); rig.invalidate(); }} /> Show the drawing</label>
          <label className="field wide"><span>Strength</span>
            <input type="range" min={10} max={100} step={5} value={Math.round(u.opacity * 100)} aria-label="Strength of the drawing" onChange={e => { patchUnderlay({ opacity: Number(e.target.value) / 100 }); rig.invalidate(); }} /><i aria-hidden="true" /></label>
          {u.kind === 'image' && <>
            <Mm label="Width" hint="The true width of what the whole picture shows" value={u.width} step={250} onCommit={v => { patchUnderlay({ width: v }); rig.invalidate(); }} />
            {!marks && <button type="button" className="add" data-action="trace-scale" onClick={() => { setInteraction({ kind: 'scaling-underlay', a: null, b: null }); rig.invalidate(); }}>Set its size from a known length</button>}
            {marks && !marks.b && <p className="notice" role="status">Click the {marks.a ? 'other end' : 'first end'} of a length you know on the picture, such as a dimensioned wall.</p>}
            {marks?.a && marks.b && <Mm label="That length is" value={0} step={50} onCommit={v => { if (!scaleUnderlay(marks.a!, marks.b!, v)) setSaid({ text: 'That length would make the picture smaller than 0.5 m or larger than 2 km.', bad: true }); rig.invalidate(); }} />}
            <p className="hint">Drag the picture to move it. It stays in this browser tab only: it is not saved with the project.</p>
          </>}
          <p><button type="button" className="danger" data-action="trace-remove" onClick={() => { setUnderlay(null); rig.invalidate(); }}>Remove the drawing</button></p>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}

/** The plot: shown while the plot tool is on. Corners are set by dragging; this panel gives the figures. */
function PlotPanel({ error }: { error: string | null }) {
  const plot = useEditor(s => s.doc.plot);
  const setback = useEditor(s => s.doc.settings.setback);
  if (!plot) {
    return (
      <aside className="inspector" aria-label="Inspector" data-type="plot">
        <h2>Plot</h2>
        <p className="hint">The plot is the boundary of the land. Add one, then drag its corners to the land&rsquo;s real shape.</p>
        <button type="button" className="add" data-action="plot-add" onClick={() => edit(d => plotAround(d), 'Add plot')}>+ Plot around the buildings</button>
        {error && <p className="error" role="alert">{error}</p>}
      </aside>
    );
  }
  return (
    <aside className="inspector" aria-label="Inspector" data-type="plot">
      <h2>Plot</h2>
      <p className="hint">Drag a ball to move a corner, or a small ball to add one. Corners move in steps of 50 mm.</p>
      <dl className="measures" aria-label="Measurements">
        <dt>Area</dt><dd data-measure="plot-area">{fmt(Math.abs(area(plot)))} m²</dd>
        <dt>Corners</dt><dd>{plot.length}</dd>
      </dl>
      <ol className="sides" aria-label="Sides">
        {plot.map((p, i) => (
          <li key={i}>
            <span>Side {i + 1}</span><b>{mm(len(p, plot[(i + 1) % plot.length]))} mm</b>
            <button type="button" className="mini" disabled={plot.length <= 3} title="Remove the corner this side starts at" aria-label={`Remove corner ${i + 1}`} onClick={() => edit(d => removePlotCorner(d, i), 'Remove plot corner')}>×</button>
          </li>
        ))}
      </ol>
      <div className="fields">
        <Mm label="Keep clear" hint="How far buildings keep from the boundary. Checks warn when one comes closer." value={setback} step={250} onCommit={v => edit(d => updateSettings(d, { setback: v }), 'Change distance from boundary')} />
      </div>
      <button type="button" className="add" data-action="plot-centre" onClick={() => edit(d => centreOnPlot(d), 'Centre on plot')}>Centre the buildings on the plot</button>
      <p><button type="button" className="danger" data-action="plot-remove" onClick={() => edit(d => setPlot(d, null), 'Remove plot')}>Remove plot</button></p>
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}

/** Where a new pool goes: 8 × 4 m, two metres to the right of everything on the level. */
function poolBeside(doc: SceneDoc, levelId: string): Vec2[] {
  const level = doc.nodes[levelId];
  const pts = level?.type === 'level' ? level.children.flatMap(c => { const n = doc.nodes[c]; return n?.type === 'wall' ? [n.a, n.b] : n?.type === 'zone' || n?.type === 'slab' ? [...n.points] : []; }) : [];
  const x = pts.length ? Math.max(...pts.map(p => p[0])) + 2 : 0, y = pts.length ? Math.min(...pts.map(p => p[1])) : 0;
  return [[x, y], [x + 8, y], [x + 8, y + 4], [x, y + 4]];
}

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
      <Mm label="To wall end" hint="From the far edge of the opening to the end of the wall. Changing it slides the opening." value={toEnd} step={25}
        onCommit={v => edit(d => updateOpening(d, opening.id, { offset: wallLength - v - opening.width / 2 }), 'Move opening')} />
      <p className="figure" hidden>To the wall end <b data-measure="to-end">{mm(toEnd)} mm</b></p>
    </>
  );
}
