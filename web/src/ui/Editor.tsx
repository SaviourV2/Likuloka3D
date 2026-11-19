'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import * as ops from '@/scene/ops';
import * as projects from '@/scene/projects';
import { importRoomlines, SAMPLE, type RoomlinesPlan } from '@/scene/roomlines';
import { schedule, scheduleCsv } from '@/scene/schedule';
import { applyProduct, BUNDLED, fetchCatalogue, productFor } from '@/scene/catalogue';
import * as store from '@/scene/store';
import { editor, isUnsaved, useEditor } from '@/scene/store';
import type { SceneDoc } from '@/scene/types';
import { world } from '@/ecs/world';
import { endChain, rig } from '@/render/interact';
import Tree from './Tree';
import Inspector from './Inspector';
import { ChecksDialog, CloudDialog, DrawingsDialog, ProjectDialog, ScheduleDialog, VersionsDialog, download } from './Dialogs';
import * as cloud from '@/scene/cloud';
import { drawingSet } from '@/scene/drawings';
import { ifcFile } from '@/scene/ifc';
import { rememberedName } from '@/scene/versions';
import { checks } from '@/scene/checks';
import { compare, versionStore } from '@/scene/versions';

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
  // Each opening is a catalogue product where one fits; the rest are custom sizes.
  const put = (level: string, kind: 'door' | 'window', at: [number, number], extra: Partial<ops.OpeningInput> = {}, code?: string) => {
    const wall = ops.wallAt(doc, level, at);
    if (!wall) return;
    let id: string;
    [doc, id] = ops.addOpeningAt(doc, wall.id, kind, at, extra);
    const product = code ? productFor(BUNDLED, code) : null;
    if (product) doc = applyProduct(doc, id, product);
  };
  levels(house).forEach((level, i) => {
    if (i === 0) put(level, 'door', [6.25, 7.75], { shape: 'arched', finish: 'timber' }, 'D-TIM-ARCH-980');
    else put(level, 'window', [6.25, 7.75], {}, 'W-ALU-980x1180');
    put(level, 'door', [5.5, 2.25], {}, 'D-TIM-826');
    put(level, 'door', [5.5, 6.25], { state: 'open' }, 'D-TIM-826');
    put(level, 'door', [7, 2], {}, 'D-TIM-826');
    put(level, 'door', [7, 6], {}, 'D-TIM-726');
    put(level, 'door', [10.25, 4.25], { width: 0.75 }, 'D-TIM-726');
    put(level, 'window', [2.75, 0], { width: 2.5, state: i === 0 ? 'open' : 'closed' }, 'W-ALU-2480x1180');
    put(level, 'window', [0, 6], { width: 1.5 }, 'W-ALU-1480x1180');
    put(level, 'window', [0, 2.25], { width: 1.5 }, 'W-ALU-1480x1180');
    put(level, 'window', [9, 0], { width: 1.5, shape: 'arched', finish: 'upvc' }, 'W-UPVC-ARCH-1480x1180');
    put(level, 'window', [11, 2], { width: 1.5 }, 'W-ALU-1480x1180');
    put(level, 'window', [11, 6], { width: 1 }, 'W-ALU-980x1180');
    put(level, 'window', [8.25, 7.75], { width: 1, sill: 1.5, height: 0.6, finish: 'upvc' }, 'W-UPVC-980x580');
  });
  for (const level of levels(studio)) {
    put(level, 'door', [5.25, 3.5], { finish: 'steel' }, 'D-STL-980');
    // Left as a custom size, to show one.
    put(level, 'window', [2.25, 3.5], { width: 2 });
    put(level, 'window', [6, 1.75], { width: 1 }, 'W-ALU-980x1180');
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
  const where = useEditor(s => s.project.where);
  const when = savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <button type="button" data-action="save" data-unsaved={unsaved} className={unsaved ? 'save unsaved' : 'save'}
      title={unsaved ? `Save the project ${where === 'cloud' ? 'to the cloud' : 'in this browser'} (Ctrl+S)` : when ? `Saved at ${when}` : 'Saved'}
      onClick={() => { void cloud.save(); }}>
      {unsaved ? 'Save' : 'Saved'}
    </button>
  );
}

/** The Project menu: everything about the project as a whole, in one place. */
function Menu({ items }: { items: [action: string, label: string, run: () => void][] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Closes when the pointer goes down anywhere outside it.
    const away = (e: PointerEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary data-action="menu">Project</summary>
      <div className="menu-items" role="menu">
        {items.map(([action, label, run]) => (
          <button key={action} type="button" role="menuitem" data-action={action} onClick={() => { if (ref.current) ref.current.open = false; run(); }}>{label}</button>
        ))}
      </div>
    </details>
  );
}

function Toolbar({ menu }: { menu: [string, string, () => void][] }) {
  const tool = useEditor(s => s.tool);
  const undoLabel = useEditor(s => s.past.at(-1)?.label);
  const redoLabel = useEditor(s => s.future[0]?.label);
  const drawing = useEditor(s => s.interaction.kind === 'drawing-wall' && !!s.interaction.from);
  const cut = useEditor(s => s.cut);
  const measure = useEditor(s => s.measure);
  const client = useEditor(store.isClient);
  return (
    <header className="bar glass" data-role={client ? 'client' : 'designer'}>
      <span className="brand"><b>Likuloka</b> 3D</span>
      <ProjectName />
      <SaveButton />
      {client && <span className="badge" title="You can choose doors, windows, finishes and room uses">Client view</span>}
      {!client && <div className="segmented" role="radiogroup" aria-label="Tool">
        <button type="button" role="radio" aria-checked={tool === 'select'} data-tool="select" title="Select (V)" onClick={() => store.setTool('select')}>Select</button>
        <button type="button" role="radio" aria-checked={tool === 'wall'} data-tool="wall" title="Draw walls (W)" onClick={() => store.setTool('wall')}>Walls</button>
        <button type="button" role="radio" aria-checked={tool === 'door'} data-tool="door" title="Add doors (D)" onClick={() => store.setTool('door')}>Door</button>
        <button type="button" role="radio" aria-checked={tool === 'window'} data-tool="window" title="Add windows (N)" onClick={() => store.setTool('window')}>Window</button>
      </div>}
      {tool === 'wall' && <span className="hint">{drawing ? 'Click to add the next wall. Esc ends the run.' : 'Click to start a wall.'}</span>}
      {(tool === 'door' || tool === 'window') && <span className="hint">Click a wall to add a {tool}. Esc to stop.</span>}
      <span className="spacer" />
      <button type="button" aria-pressed={cut} data-action="cut" title="Cut walls at 1.2 m so rooms can be seen into" onClick={() => store.setCut(!cut)}>Cut</button>
      <button type="button" aria-pressed={measure} data-action="measure" title="Show the size of every door and window (M)" onClick={() => store.setMeasure(!measure)}>Measure</button>
      <button type="button" className="icon" data-action="undo" aria-label="Undo" disabled={!undoLabel} title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} onClick={() => store.undo()}>↶</button>
      <button type="button" className="icon" data-action="redo" aria-label="Redo" disabled={!redoLabel} title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'} onClick={() => store.redo()}>↷</button>
      <Menu items={menu} />
    </header>
  );
}

function CheckCount({ onOpen }: { onOpen: () => void }) {
  const doc = useEditor(s => s.doc);
  const catalogue = useEditor(s => s.catalogue);
  const issues = checks(doc, catalogue);
  const warnings = issues.filter(i => i.severity === 'warning').length;
  return (
    <button type="button" className="checks" data-action="checks-count" data-warnings={warnings} onClick={onOpen}>
      {warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'No warnings'}{issues.length > warnings ? `, ${issues.length - warnings} note${issues.length - warnings === 1 ? '' : 's'}` : ''}
    </button>
  );
}

/** Tells the person when someone else saved the open cloud project. */
function CloudNotice() {
  const notice = useEditor(s => s.cloud.notice);
  if (!notice || notice.kind !== 'remote') return null;
  return (
    <span className="notice" role="status" data-notice="remote">
      {notice.text} <button type="button" data-action="reload" onClick={() => {
        if (isUnsaved(editor.getState()) && !window.confirm('Reloading discards your unsaved changes. Reload?')) return;
        void cloud.reload();
      }}>Reload</button>
    </span>
  );
}

function Status({ onChecks }: { onChecks: () => void }) {
  const backend = useBackend();
  const where = useEditor(s => s.project.where);
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
      <span>{unsaved ? 'Unsaved changes' : where === 'cloud' ? 'Saved in the cloud' : 'Saved'}</span>
      <CloudNotice />
      <CheckCount onOpen={onChecks} />
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
  const cloudDialog = useRef<HTMLDialogElement>(null);
  const [cloudOpen, setCloudOpen] = useState(false);
  const drawingsDialog = useRef<HTMLDialogElement>(null);
  const [drawingsOpen, setDrawingsOpen] = useState(false);
  const versionsDialog = useRef<HTMLDialogElement>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const checksDialog = useRef<HTMLDialogElement>(null);
  const [checksOpen, setChecksOpen] = useState(false);

  useEffect(() => {
    if (!projects.restore()) projects.newProject(sampleScene());
    setReady(true);
    fetchCatalogue().then(store.setCatalogue);
    // Cloud, if this site has it; then a share link in the address, if there is one.
    cloud.startCloud().then(on => {
      const params = new URLSearchParams(window.location.search);
      const project = params.get('project'), invite = params.get('invite');
      if (!on || !project || !invite) return;
      const join = () => cloud.acceptInvite(project, invite).then(ok => {
        if (ok) { history.replaceState(null, '', window.location.pathname); import('@/render/Viewport').then(m => m.frame(editor.getState().doc)); }
      });
      if (editor.getState().cloud.user) { void join(); return; }
      // Sign in first, then join.
      setCloudOpen(true);
      cloudDialog.current?.showModal();
      const unsub = editor.subscribe(st => { if (st.cloud.user) { unsub(); cloudDialog.current?.close(); void join(); } });
    });
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
      if (mod && k === 's') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur?.(); void cloud.save(); return; }
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
      setRole: store.setRole,
      role: () => editor.getState().role,
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
      cloud: {
        state: () => editor.getState().cloud,
        signIn: cloud.signInWithEmail,
        createAccount: cloud.createAccount,
        signOut: cloud.signOut,
        save: cloud.saveToCloud,
        open: cloud.openCloudProject,
        list: cloud.listCloudProjects,
        invite: cloud.createInvite,
        accept: cloud.acceptInvite,
        members: cloud.members,
        removeMember: cloud.removeMember,
        sendSceneUnchecked: cloud.sendSceneUnchecked,
      },
      save: cloud.save,
      projects: {
        list: projects.listProjects,
        save: projects.saveProject,
        open: projects.openProject,
        remove: projects.deleteProject,
        blank: () => projects.newProject(projects.blankScene()),
        file: () => projects.projectFile(editor.getState().doc),
        openFile: projects.openProjectFile,
      },
      schedule: () => schedule(editor.getState().doc, editor.getState().catalogue),
      scheduleCsv: () => scheduleCsv(editor.getState().doc, editor.getState().catalogue),
      catalogue: () => editor.getState().catalogue,
      setCatalogue: store.setCatalogue,
      ifc: () => { const s = editor.getState(); return ifcFile(s.doc, { projectId: s.project.id, catalogue: s.catalogue }); },
      drawings: () => drawingSet(editor.getState().doc, editor.getState().catalogue),
      checks: () => checks(editor.getState().doc, editor.getState().catalogue),
      versions: {
        list: () => versionStore(editor.getState().project.where).list(editor.getState().project.id),
        compare: (id: string) => versionStore(editor.getState().project.where).list(editor.getState().project.id)
          .then(l => { const v = l.find(x => x.id === id); return v ? compare(v.doc, editor.getState().doc, editor.getState().catalogue) : null; }),
      },
      download: (what: 'project' | 'schedule') => {
        const doc = editor.getState().doc;
        if (what === 'project') download(projects.fileName(doc), projects.projectFile(doc), 'application/json');
        else download(projects.fileName(doc).replace('.likuloka.json', '-schedule.csv'), scheduleCsv(doc, editor.getState().catalogue), 'text/csv');
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
      <Toolbar menu={[
        ['cloud', 'Cloud and sharing…', () => { setCloudOpen(true); cloudDialog.current?.showModal(); }],
        ['project', 'Projects and files…', () => { setProjectOpen(true); projectDialog.current?.showModal(); }],
        ['versions', 'Versions and sign-off…', () => { setVersionsOpen(true); versionsDialog.current?.showModal(); }],
        ['schedule', 'Door and window schedule…', () => { setScheduleOpen(true); scheduleDialog.current?.showModal(); }],
        ['drawings', 'Drawings: plans and elevations…', () => { setDrawingsOpen(true); drawingsDialog.current?.showModal(); }],
        ['ifc', 'Export IFC for BIM', () => {
          const s = editor.getState();
          const name = projects.fileName(s.doc).replace('.likuloka.json', '.ifc');
          download(name, ifcFile(s.doc, { projectId: s.project.id, catalogue: s.catalogue, fileName: name, author: rememberedName() }), 'application/x-step');
        }],
        ['checks', 'Checks…', () => { setChecksOpen(true); checksDialog.current?.showModal(); }],
      ]} />
      <Tree />
      <main className="stage">
        {ready && <Viewport />}
      </main>
      <Inspector />
      <Status onChecks={() => { setChecksOpen(true); checksDialog.current?.showModal(); }} />
      <ProjectDialog dialog={projectDialog} open={projectOpen} onClose={() => setProjectOpen(false)} sample={sampleScene} okToDiscard={okToDiscard} />
      <ScheduleDialog dialog={scheduleDialog} open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      <CloudDialog dialog={cloudDialog} open={cloudOpen} onClose={() => setCloudOpen(false)} />
      <DrawingsDialog dialog={drawingsDialog} open={drawingsOpen} onClose={() => setDrawingsOpen(false)} />
      <VersionsDialog dialog={versionsDialog} open={versionsOpen} onClose={() => setVersionsOpen(false)} />
      <ChecksDialog dialog={checksDialog} open={checksOpen} onClose={() => setChecksOpen(false)} />
    </div>
  );
}
