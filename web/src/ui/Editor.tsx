'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import * as ops from '@/scene/ops';
import { importRoomlines, SAMPLE, type RoomlinesPlan } from '@/scene/roomlines';
import * as store from '@/scene/store';
import { editor, useEditor } from '@/scene/store';
import type { SceneDoc } from '@/scene/types';
import { world } from '@/ecs/world';
import { endChain, rig } from '@/render/interact';
import Tree from './Tree';
import Inspector from './Inspector';

// three.js and WebGPU need the browser, so the viewport is never rendered on the server.
const Viewport = dynamic(() => import('@/render/Viewport'), { ssr: false, loading: () => <div className="viewport loading">Starting the 3D view…</div> });

const STORAGE_KEY = 'likuloka3d.scene';

export function sampleScene(): SceneDoc {
  let [doc] = importRoomlines(ops.emptyDoc(), SAMPLE, { levels: 2 });
  [doc] = importRoomlines(doc, {
    name: 'Garden studio',
    rooms: [
      { name: 'Studio', type: 'studio', x: 0, y: 0, w: 4.5, h: 3.5 },
      { name: 'Store', type: 'storage', x: 4.5, y: 0, w: 1.5, h: 3.5 },
    ],
  }, { origin: [15, 1] });
  // Doors and windows, by a point on the wall each sits in.
  const [house, studio] = doc.roots.map(r => doc.nodes[r]);
  const levels = (b: typeof house) => (b.type === 'building' ? b.children : []);
  const put = (level: string, kind: 'door' | 'window', at: [number, number], extra: Partial<ops.OpeningInput> = {}) => {
    const wall = ops.wallAt(doc, level, at);
    if (wall) [doc] = ops.addOpeningAt(doc, wall.id, kind, at, extra);
  };
  levels(house).forEach((level, i) => {
    put(level, i === 0 ? 'door' : 'window', [6.25, 7.75]);
    put(level, 'door', [5.5, 2.25]);
    put(level, 'door', [5.5, 6.25]);
    put(level, 'door', [7, 2]);
    put(level, 'door', [7, 6]);
    put(level, 'door', [10.25, 4.25], { width: 0.75 });
    put(level, 'window', [2.75, 0], { width: 2.5 });
    put(level, 'window', [0, 6], { width: 1.5 });
    put(level, 'window', [0, 2.25], { width: 1.5 });
    put(level, 'window', [9, 0], { width: 1.5 });
    put(level, 'window', [11, 2], { width: 1.5 });
    put(level, 'window', [11, 6], { width: 1 });
    put(level, 'window', [8.25, 7.75], { width: 1, sill: 1.5, height: 0.6 });
  });
  for (const level of levels(studio)) {
    put(level, 'door', [5.25, 3.5]);
    put(level, 'window', [2.25, 3.5], { width: 2 });
    put(level, 'window', [6, 1.75], { width: 1 });
  }
  return doc;
}

/** Scenes saved before walls could hold openings have walls without `children`. */
function migrate(raw: unknown): unknown {
  const doc = raw as { nodes?: Record<string, { type?: string; children?: unknown }> };
  if (doc?.nodes) for (const n of Object.values(doc.nodes)) if (n?.type === 'wall' && !n.children) n.children = [];
  return raw;
}

function readSaved(): SceneDoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? ops.validate(migrate(JSON.parse(raw))) : null;
  } catch {
    return null;
  }
}

function Toolbar({ onImport }: { onImport: () => void }) {
  const tool = useEditor(s => s.tool);
  const undoLabel = useEditor(s => s.past.at(-1)?.label);
  const redoLabel = useEditor(s => s.future[0]?.label);
  const drawing = useEditor(s => s.interaction.kind === 'drawing-wall' && !!s.interaction.from);
  const cut = useEditor(s => s.cut);
  return (
    <header className="bar glass">
      <span className="brand"><b>Likuloka</b> 3D</span>
      <div className="segmented" role="radiogroup" aria-label="Tool">
        <button type="button" role="radio" aria-checked={tool === 'select'} data-tool="select" onClick={() => store.setTool('select')}>Select</button>
        <button type="button" role="radio" aria-checked={tool === 'wall'} data-tool="wall" title="Draw walls (W)" onClick={() => store.setTool('wall')}>Draw walls</button>
        <button type="button" role="radio" aria-checked={tool === 'door'} data-tool="door" title="Add doors (D)" onClick={() => store.setTool('door')}>Door</button>
        <button type="button" role="radio" aria-checked={tool === 'window'} data-tool="window" title="Add windows (N)" onClick={() => store.setTool('window')}>Window</button>
      </div>
      {tool === 'wall' && <span className="hint">{drawing ? 'Click to add the next wall. Esc ends the run.' : 'Click to start a wall.'}</span>}
      {(tool === 'door' || tool === 'window') && <span className="hint">Click a wall to add a {tool}. Esc to stop.</span>}
      <span className="spacer" />
      <button type="button" aria-pressed={cut} data-action="cut" title="Cut walls at 1.2 m so rooms can be seen into" onClick={() => store.setCut(!cut)}>Cut walls</button>
      <button type="button" data-action="undo" disabled={!undoLabel} title={undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo'} onClick={() => store.undo()}>Undo</button>
      <button type="button" data-action="redo" disabled={!redoLabel} title={redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo'} onClick={() => store.redo()}>Redo</button>
      <button type="button" onClick={onImport}>Import plan</button>
    </header>
  );
}

function Status() {
  const backend = useBackend();
  const steps = useEditor(s => s.past.length);
  const [last, setLast] = useState('');
  useEffect(() => {
    let seen = -1;
    const t = window.setInterval(() => {
      const { last: l } = world.stats;
      if (l.frame === seen) return;
      seen = l.frame;
      setLast(l.ids.length ? `${l.ids.length} updated in the last change` : '');
    }, 250);
    return () => window.clearInterval(t);
  }, []);
  return (
    <footer className="status">
      <span data-backend={backend}>{backend}</span>
      <span>{steps} undo step{steps === 1 ? '' : 's'}</span>
      {last && <span>{last}</span>}
    </footer>
  );
}

function useBackend() {
  const [b, setB] = useState('starting');
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setB(el.dataset.backend ?? 'starting');
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ['data-backend'] });
    return () => mo.disconnect();
  }, []);
  return b;
}

function ImportDialog({ dialog }: { dialog: React.RefObject<HTMLDialogElement | null> }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const run = (plan: RoomlinesPlan) => {
    const doc = editor.getState().doc;
    const right = Object.values(doc.nodes).reduce((m, n) => {
      if (n.type !== 'slab') return m;
      const level = doc.nodes[n.parent];
      const b = level && level.parent ? doc.nodes[level.parent] : undefined;
      const ox = b?.type === 'building' ? b.origin[0] : 0;
      return Math.max(m, ...n.points.map(p => p[0] + ox));
    }, -3);
    let made: string | null = null;
    const ok = store.commit(d => { const [next, id] = importRoomlines(d, plan, { origin: [ops.snap(right + 3), 0] }); made = id; return next; }, 'Import plan');
    if (!ok) { setError(editor.getState().error ?? 'The plan could not be read'); return; }
    if (made) store.select(made);
    setError('');
    setText('');
    dialog.current?.close();
    import('@/render/Viewport').then(m => m.frame(editor.getState().doc));
  };
  const parse = (raw: string) => {
    try { run(JSON.parse(raw)); } catch { setError('That is not valid JSON.'); }
  };
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="import-title">
      <form method="dialog" onSubmit={e => { e.preventDefault(); parse(text); }}>
        <h2 id="import-title">Import a Roomlines plan</h2>
        <p>Paste the JSON from Roomlines&rsquo; &ldquo;Plan data&rdquo; box, or choose a saved <code>.json</code> file. It is added as a new building: rooms become zones, their edges become walls and their outline becomes the slab.</p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={8} spellCheck={false}
          placeholder='{ "name": "Flat", "rooms": [{ "name": "Living room", "x": 0, "y": 0, "w": 5, "h": 4 }] }' />
        <input type="file" accept=".json,application/json" onChange={async e => {
          const f = e.target.files?.[0];
          if (f) parse(await f.text());
          e.target.value = '';
        }} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={!text.trim()}>Import</button>
        </div>
      </form>
    </dialog>
  );
}

export default function Editor() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    store.load(readSaved() ?? sampleScene());
    setReady(true);
    // Autosave, at most twice a second and never mid-gesture.
    let timer = 0;
    const unsub = editor.subscribe((s, prev) => {
      if (s.doc === prev.doc || s.gesture) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(editor.getState().doc)); } catch { /* storage may be off */ }
      }, 500);
    });

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); }
      else if (mod && k === 'y') { e.preventDefault(); store.redo(); }
      else if (mod) return;
      else if (k === 'escape') {
        const tool = editor.getState().tool;
        if (tool === 'wall') endChain();
        else if (tool === 'door' || tool === 'window') store.setTool('select');
        else store.select(null);
      }
      else if (k === 'delete' || k === 'backspace') { if (store.removeSelected()) e.preventDefault(); }
      else if (k === 'v') store.setTool('select');
      else if (k === 'w') store.setTool('wall');
      else if (k === 'd') store.setTool('door');
      else if (k === 'n') store.setTool('window');
      else if (k === 'f') import('@/render/Viewport').then(m => m.frame(editor.getState().doc));
      else return;
      rig.invalidate();
    };
    window.addEventListener('keydown', onKey);

    // The scripting API, for tests and automation. It uses the same functions as the buttons.
    const api = {
      getState: () => {
        const s = editor.getState();
        return { cut: s.cut, tool: s.tool, interaction: s.interaction, selection: s.selection, activeLevel: s.activeLevel, views: s.views, undo: s.past.length, redo: s.future.length, error: s.error, gesture: !!s.gesture };
      },
      getDoc: () => editor.getState().doc,
      ops,
      commit: store.commit,
      undo: store.undo,
      redo: store.redo,
      select: store.select,
      setView: store.setView,
      setTool: store.setTool,
      load: store.load,
      importRoomlines: (plan: RoomlinesPlan) => store.commit(d => importRoomlines(d, plan)[0], 'Import plan'),
      reset: () => store.load(sampleScene()),
      stats: () => JSON.parse(JSON.stringify(world.stats)),
      resetStats: () => world.resetStats(),
      levelY: (id: string) => world.levels.get(id) ?? null,
      /** Screen position of a plan point on a level, as drawn now. */
      project: (levelId: string, x: number, y: number, lift = 0) => {
        const v = world.toWorld(editor.getState().doc, levelId, [x, y], lift).project(rig.camera);
        const r = rig.dom.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
      },
      backend: () => document.documentElement.dataset.backend ?? 'starting',
      /** The ECS world, for debugging. */
      world,
    };
    (window as unknown as { likuloka: typeof api }).likuloka = api;
    return () => { unsub(); window.removeEventListener('keydown', onKey); window.clearTimeout(timer); };
  }, []);

  return (
    <div className="editor">
      <Toolbar onImport={() => dialog.current?.showModal()} />
      <Tree />
      <main className="stage">
        {ready && <Viewport />}
      </main>
      <Inspector />
      <Status />
      <ImportDialog dialog={dialog} />
    </div>
  );
}
