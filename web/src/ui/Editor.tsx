'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import * as ops from '@/scene/ops';
import * as projects from '@/scene/projects';
import { importRoomlines, SAMPLE, type RoomlinesPlan } from '@/scene/roomlines';
import { schedule, scheduleCsv } from '@/scene/schedule';
import * as store from '@/scene/store';
import { editor, isUnsaved, useEditor } from '@/scene/store';
import type { SceneDoc } from '@/scene/types';
import { world } from '@/ecs/world';
import { endChain, rig } from '@/render/interact';
import Tree from './Tree';
import Inspector from './Inspector';
import { ProjectDialog, ScheduleDialog, download } from './Dialogs';

// three.js and WebGPU need the browser, so the viewport is never rendered on the server.
const Viewport = dynamic(() => import('@/render/Viewport'), { ssr: false, loading: () => <div className="viewport loading">Starting the 3D view…</div> });

export function sampleScene(): SceneDoc {
  let [doc] = importRoomlines(ops.emptyDoc('Sample house'), SAMPLE, { levels: 2 });
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
    if (i === 0) put(level, 'door', [6.25, 7.75], { shape: 'arched', finish: 'timber' });
    else put(level, 'window', [6.25, 7.75]);
    put(level, 'door', [5.5, 2.25]);
    put(level, 'door', [5.5, 6.25], { state: 'open' });
    put(level, 'door', [7, 2]);
    put(level, 'door', [7, 6]);
    put(level, 'door', [10.25, 4.25], { width: 0.75 });
    put(level, 'window', [2.75, 0], { width: 2.5, state: i === 0 ? 'open' : 'closed' });
    put(level, 'window', [0, 6], { width: 1.5 });
    put(level, 'window', [0, 2.25], { width: 1.5 });
    put(level, 'window', [9, 0], { width: 1.5, shape: 'arched', finish: 'upvc' });
    put(level, 'window', [11, 2], { width: 1.5 });
    put(level, 'window', [11, 6], { width: 1 });
    put(level, 'window', [8.25, 7.75], { width: 1, sill: 1.5, height: 0.6, finish: 'upvc' });
  });
  for (const level of levels(studio)) {
    put(level, 'door', [5.25, 3.5], { finish: 'steel' });
    put(level, 'window', [2.25, 3.5], { width: 2 });
    put(level, 'window', [6, 1.75], { width: 1 });
  }
  return doc;
}

/** Asks before throwing away unsaved work. */
export function okToDiscard(): boolean {
  const s = editor.getState();
  return !isUnsaved(s) || window.confirm(`“${s.doc.name}” has unsaved changes. Discard them?`);
}

function ProjectName() {
  const name = useEditor(s => s.doc.name);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const done = () => {
    if (text.trim() && text.trim() !== name) store.commit(d => ops.renameProject(d, text), 'Rename project');
    else setText(name);
  };
  return (
    <input className="project-name" aria-label="Project name" value={text} maxLength={80} spellCheck={false}
      onChange={e => setText(e.target.value)} onBlur={done}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(name); (e.target as HTMLInputElement).blur(); } }} />
  );
}

function SaveButton() {
  const unsaved = useEditor(isUnsaved);
  const savedAt = useEditor(s => s.project.savedAt);
  const when = savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <button type="button" data-action="save" data-unsaved={unsaved} className={unsaved ? 'save unsaved' : 'save'}
      title={unsaved ? 'Save the project in this browser (Ctrl+S)' : when ? `Saved at ${when}` : 'Saved'}
      onClick={() => projects.saveProject()}>
      {unsaved ? 'Save' : 'Saved'}
    </button>
  );
}

function Toolbar({ onProject, onSchedule }: { onProject: () => void; onSchedule: () => void }) {
  const tool = useEditor(s => s.tool);
  const undoLabel = useEditor(s => s.past.at(-1)?.label);
  const redoLabel = useEditor(s => s.future[0]?.label);
  const drawing = useEditor(s => s.interaction.kind === 'drawing-wall' && !!s.interaction.from);
  const cut = useEditor(s => s.cut);
  const measure = useEditor(s => s.measure);
  return (
    <header className="bar glass">
      <span className="brand"><b>Likuloka</b> 3D</span>
      <ProjectName />
      <SaveButton />
      <div className="segmented" role="radiogroup" aria-label="Tool">
        <button type="button" role="radio" aria-checked={tool === 'select'} data-tool="select" title="Select (V)" onClick={() => store.setTool('select')}>Select</button>
        <button type="button" role="radio" aria-checked={tool === 'wall'} data-tool="wall" title="Draw walls (W)" onClick={() => store.setTool('wall')}>Walls</button>
        <button type="button" role="radio" aria-checked={tool === 'door'} data-tool="door" title="Add doors (D)" onClick={() => store.setTool('door')}>Door</button>
        <button type="button" role="radio" aria-checked={tool === 'window'} data-tool="window" title="Add windows (N)" onClick={() => store.setTool('window')}>Window</button>
      </div>
      {tool === 'wall' && <span className="hint">{drawing ? 'Click to add the next wall. Esc ends the run.' : 'Click to start a wall.'}</span>}
      {(tool === 'door' || tool === 'window') && <span className="hint">Click a wall to add a {tool}. Esc to stop.</span>}
      <span className="spacer" />
      <button type="button" aria-pressed={cut} data-action="cut" title="Cut walls at 1.2 m so rooms can be seen into" onClick={() => store.setCut(!cut)}>Cut</button>
      <button type="button" aria-pressed={measure} data-action="measure" title="Show the size of every door and window (M)" onClick={() => store.setMeasure(!measure)}>Measure</button>
      <button type="button" className="icon" data-action="undo" aria-label="Undo" disabled={!undoLabel} title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} onClick={() => store.undo()}>↶</button>
      <button type="button" className="icon" data-action="redo" aria-label="Redo" disabled={!redoLabel} title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'} onClick={() => store.redo()}>↷</button>
      <button type="button" data-action="schedule" onClick={onSchedule}>Schedule</button>
      <button type="button" data-action="project" onClick={onProject}>Project</button>
    </header>
  );
}

function Status() {
  const backend = useBackend();
  const steps = useEditor(s => s.past.length);
  const unsaved = useEditor(isUnsaved);
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
      <span>{unsaved ? 'Unsaved changes' : 'Saved'}</span>
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

export default function Editor() {
  const projectDialog = useRef<HTMLDialogElement>(null);
  const scheduleDialog = useRef<HTMLDialogElement>(null);
  const [ready, setReady] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);

  useEffect(() => {
    if (!projects.restore()) projects.newProject(sampleScene());
    setReady(true);
    // The working copy is written as a draft on every change, so a reload restores it.
    let timer = 0;
    const unsub = editor.subscribe((s, prev) => {
      if ((s.doc === prev.doc && s.project === prev.project) || s.gesture) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(projects.writeDraft, 400);
    });

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Saving works from anywhere, even while typing in a field.
      if (mod && k === 's') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur?.(); projects.saveProject(); return; }
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, dialog')) return;
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
      else if (k === 'm') store.setMeasure(!editor.getState().measure);
      else if (k === 'f') {
        const sel = editor.getState().selection;
        import('@/render/Viewport').then(m => (sel ? m.focus(sel) : m.frame(editor.getState().doc)));
      }
      else return;
      rig.invalidate();
    };
    window.addEventListener('keydown', onKey);

    // The scripting API, for tests and automation. It uses the same functions as the buttons.
    const api = {
      getState: () => {
        const s = editor.getState();
        return {
          cut: s.cut, measure: s.measure, tool: s.tool, interaction: s.interaction, selection: s.selection, activeLevel: s.activeLevel,
          views: s.views, undo: s.past.length, redo: s.future.length, error: s.error, gesture: !!s.gesture,
          project: { id: s.project.id, name: s.doc.name, unsaved: isUnsaved(s), savedAt: s.project.savedAt },
        };
      },
      getDoc: () => editor.getState().doc,
      ops,
      commit: store.commit,
      undo: store.undo,
      redo: store.redo,
      select: store.select,
      setView: store.setView,
      setTool: store.setTool,
      setMeasure: store.setMeasure,
      load: store.load,
      importRoomlines: (plan: RoomlinesPlan) => store.commit(d => importRoomlines(d, plan)[0], 'Import plan'),
      reset: () => projects.newProject(sampleScene()),
      projects: {
        list: projects.listProjects,
        save: projects.saveProject,
        open: projects.openProject,
        remove: projects.deleteProject,
        blank: () => projects.newProject(projects.blankScene()),
        file: () => projects.projectFile(editor.getState().doc),
        openFile: projects.openProjectFile,
      },
      schedule: () => schedule(editor.getState().doc),
      scheduleCsv: () => scheduleCsv(editor.getState().doc),
      download: (what: 'project' | 'schedule') => {
        const doc = editor.getState().doc;
        if (what === 'project') download(projects.fileName(doc), projects.projectFile(doc), 'application/json');
        else download(projects.fileName(doc).replace('.likuloka.json', '-schedule.csv'), scheduleCsv(doc), 'text/csv');
      },
      stats: () => JSON.parse(JSON.stringify(world.stats)),
      resetStats: () => world.resetStats(),
      levelY: (id: string) => world.levels.get(id) ?? null,
      /** Points the camera at a node, or at everything. */
      focus: (id?: string) => import('@/render/Viewport').then(m => (id ? m.focus(id) : m.frame(editor.getState().doc))),
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
      <Toolbar onProject={() => { setProjectOpen(true); projectDialog.current?.showModal(); }} onSchedule={() => { setScheduleOpen(true); scheduleDialog.current?.showModal(); }} />
      <Tree />
      <main className="stage">
        {ready && <Viewport />}
      </main>
      <Inspector />
      <Status />
      <ProjectDialog dialog={projectDialog} open={projectOpen} onClose={() => setProjectOpen(false)} sample={sampleScene} okToDiscard={okToDiscard} />
      <ScheduleDialog dialog={scheduleDialog} open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
    </div>
  );
}
