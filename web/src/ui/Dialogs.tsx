'use client';
/** The Project, Import and Schedule dialogs. */
import { useRef, useState } from 'react';
import * as ops from '@/scene/ops';
import * as projects from '@/scene/projects';
import { importRoomlines, type RoomlinesPlan } from '@/scene/roomlines';
import { schedule, scheduleCsv, types } from '@/scene/schedule';
import * as store from '@/scene/store';
import { editor, isUnsaved, useEditor } from '@/scene/store';
import type { SceneDoc } from '@/scene/types';
import { rig } from '@/render/interact';

type DialogRef = React.RefObject<HTMLDialogElement | null>;

/** Hands the browser a file to save. */
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const frameAll = () => import('@/render/Viewport').then(m => m.frame(editor.getState().doc));
const when = (t: number) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The project dialog. Its body reads the browser's saved projects, so it
 * renders only while the dialog is open: never in the static HTML.
 */
export function ProjectDialog({ dialog, open, onClose, sample, okToDiscard }: { dialog: DialogRef; open: boolean; onClose: () => void; sample: () => SceneDoc; okToDiscard: () => boolean }) {
  const importDialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <dialog ref={dialog} className="dialog wide" aria-labelledby="project-title" onClose={onClose}>
        {open && <ProjectBody dialog={dialog} importDialog={importDialog} sample={sample} okToDiscard={okToDiscard} />}
      </dialog>
      <ImportDialog dialog={importDialog} />
    </>
  );
}

function ProjectBody({ dialog, importDialog, sample, okToDiscard }: { dialog: DialogRef; importDialog: DialogRef; sample: () => SceneDoc; okToDiscard: () => boolean }) {
  const project = useEditor(s => s.project);
  const name = useEditor(s => s.doc.name);
  const unsaved = useEditor(isUnsaved);
  const error = useEditor(s => s.error);
  const [, refresh] = useState(0);
  const list = projects.listProjects();
  const close = () => dialog.current?.close();
  const after = (ok: boolean) => { if (ok) { close(); frameAll(); rig.invalidate(); } };

  return (
    <>
      <h2 id="project-title">{name}</h2>
      <p>{unsaved ? 'This project has unsaved changes.' : project.savedAt ? `Saved in this browser, ${when(project.savedAt)}.` : 'Saved.'} Projects are kept in this browser. Download a project to keep a copy or to open it on another computer.</p>
      <div className="actions start">
        <button type="button" className="primary" data-action="save-project" onClick={() => { projects.saveProject(); refresh(n => n + 1); }}>Save</button>
        <button type="button" data-action="download-project" onClick={() => { const doc = editor.getState().doc; download(projects.fileName(doc), projects.projectFile(doc), 'application/json'); }}>Download file</button>
      </div>

      <h3>Saved in this browser</h3>
      {list.length === 0 ? <p className="hint">No saved projects yet.</p> : (
        <ul className="projects">
          {list.map(p => (
            <li key={p.id} data-project={p.id} aria-current={p.id === project.id}>
              <span className="name">{p.name}</span>
              <span className="meta">{when(p.updatedAt)} · {p.openings} doors and windows</span>
              {p.id === project.id ? <em>Open now</em> : (
                <button type="button" onClick={() => { if (okToDiscard()) after(projects.openProject(p.id)); }}>Open</button>
              )}
              <button type="button" className="danger" aria-label={`Delete ${p.name}`}
                onClick={() => { if (window.confirm(`Delete “${p.name}” from this browser? This cannot be undone.`)) { projects.deleteProject(p.id); refresh(n => n + 1); } }}>Delete</button>
            </li>
          ))}
        </ul>
      )}

      <h3>Open or start</h3>
      <div className="actions start">
        <label className="file-button">
          Open a file…
          <input type="file" accept=".json,application/json" onChange={async e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f && okToDiscard()) after(projects.openProjectFile(await f.text()));
          }} />
        </label>
        <button type="button" data-action="new-blank" onClick={() => { if (okToDiscard()) after(projects.newProject(projects.blankScene())); }}>New blank project</button>
        <button type="button" data-action="new-sample" onClick={() => { if (okToDiscard()) after(projects.newProject(sample())); }}>New from the sample</button>
        <button type="button" data-action="import" onClick={() => { close(); importDialog.current?.showModal(); }}>Import a Roomlines plan…</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" onClick={close}>Close</button>
      </div>
    </>
  );
}

function ImportDialog({ dialog }: { dialog: DialogRef }) {
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
    frameAll();
  };
  const parse = (raw: string) => {
    try { run(JSON.parse(raw)); } catch { setError('That is not valid JSON.'); }
  };
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="import-title">
      <form method="dialog" onSubmit={e => { e.preventDefault(); parse(text); }}>
        <h2 id="import-title">Import a Roomlines plan</h2>
        <p>Paste the JSON from Roomlines&rsquo; &ldquo;Plan data&rdquo; box, or choose a saved <code>.json</code> file. It is added to this project as a new building: rooms become zones, their edges become walls and their outline becomes the slab.</p>
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

/**
 * Every door and window with its sizes, and the types to order. The body
 * reads the document only while the dialog is open, so edits and drags do
 * not rebuild a closed schedule.
 */
export function ScheduleDialog({ dialog, open, onClose }: { dialog: DialogRef; open: boolean; onClose: () => void }) {
  return (
    <dialog ref={dialog} className="dialog wide" aria-labelledby="schedule-title" onClose={onClose}>
      <h2 id="schedule-title">Door and window schedule</h2>
      {open && <ScheduleBody dialog={dialog} />}
    </dialog>
  );
}

function ScheduleBody({ dialog }: { dialog: DialogRef }) {
  const doc = useEditor(s => s.doc);
  const rows = schedule(doc);
  const kinds = types(rows);
  const close = () => dialog.current?.close();
  if (!rows.length) {
    return (
      <>
        <p className="hint">There are no doors or windows yet. Use the Door or Window tool to add some.</p>
        <div className="actions"><button type="button" onClick={close}>Close</button></div>
      </>
    );
  }
  return (
    <>
      <p>Sizes are in millimetres: width × height of the opening in the wall, and the wall depth the frame spans. Use it to order and make the frames.</p>
      <h3>To order</h3>
      <div className="table-wrap">
        <table className="schedule" data-table="types">
          <thead><tr><th>Qty</th><th>Type</th><th>Head</th><th>Frame</th><th>W × H</th><th>Wall</th><th>Refs</th></tr></thead>
          <tbody>
            {kinds.map(t => (
              <tr key={t.refs[0]}>
                <td className="num">{t.refs.length}</td><td>{t.kind}</td><td>{t.shape}</td><td>{t.finish}</td>
                <td className="num">{t.width} × {t.height}</td><td className="num">{t.wall}</td><td>{t.refs.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Every opening</h3>
      <div className="table-wrap">
        <table className="schedule" data-table="all">
          <thead><tr><th>Ref</th><th>Type</th><th>Head</th><th>Frame</th><th>W × H</th><th>Sill</th><th>Head height</th><th>Where</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><button type="button" className="ref" onClick={() => { store.select(r.id); rig.invalidate(); close(); }}>{r.ref}</button></td>
                <td>{r.kind}</td><td>{r.shape}</td><td>{r.finish}</td>
                <td className="num">{r.width} × {r.height}</td><td className="num">{r.sill}</td><td className="num">{r.head}</td>
                <td>{r.building}, {r.level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button type="button" onClick={close}>Close</button>
        <button type="button" className="primary" data-action="download-schedule"
          onClick={() => download(projects.fileName(doc).replace('.likuloka.json', '-schedule.csv'), scheduleCsv(doc), 'text/csv')}>Download CSV</button>
      </div>
    </>
  );
}
