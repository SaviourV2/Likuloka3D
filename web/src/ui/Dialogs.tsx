'use client';
/** The Project, Import and Schedule dialogs. */
import { useEffect, useRef, useState } from 'react';
import * as ops from '@/scene/ops';
import * as projects from '@/scene/projects';
import { importRoomlines, type RoomlinesPlan } from '@/scene/roomlines';
import { schedule, scheduleCsv, totals, types } from '@/scene/schedule';
import { formatPrice } from '@/scene/catalogue';
import { checks } from '@/scene/checks';
import { drawingSet, type Sheet } from '@/scene/drawings';
import { dxfFile } from '@/scene/dxf';
import * as cloud from '@/scene/cloud';
import { approvalFrom, compare, rememberedName, rememberName, versionStore, type Comparison, type Version } from '@/scene/versions';
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
  const client = useEditor(store.isClient);
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

      <h3>Settings</h3>
      <FittingGap />

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
        <RoleSwitch />
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
  const catalogue = useEditor(s => s.catalogue);
  const rows = schedule(doc, catalogue);
  const kinds = types(rows);
  const sum = totals(rows);
  const price = (v: number | null) => (v === null ? '—' : formatPrice(catalogue, v));
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
      <p>Sizes are in millimetres. The opening is the hole in the wall; the frame is smaller by the project&rsquo;s fitting gap of {Math.round(doc.settings.tolerance * 1000)} mm a side. Wall is the depth the frame spans.</p>
      <h3>To order</h3>
      <div className="table-wrap">
        <table className="schedule" data-table="types">
          <thead><tr><th>Qty</th><th>Product</th><th>Type</th><th>Head</th><th>Frame</th><th>Frame W × H</th><th>Wall</th><th>Each</th><th>Total</th><th>Refs</th></tr></thead>
          <tbody>
            {kinds.map(t => (
              <tr key={t.refs[0]}>
                <td className="num">{t.refs.length}</td>
                <td>{t.product ? <><b className="code">{t.product}</b> {t.productName}</> : <span className="muted">Custom size</span>}</td>
                <td>{t.kind}</td><td>{t.shape}</td><td>{t.finish}</td>
                <td className="num">{t.frameWidth} × {t.frameHeight}</td><td className="num">{t.wall}</td>
                <td className="num">{price(t.price)}</td><td className="num">{t.price === null ? '—' : price(t.price * t.refs.length)}</td>
                <td>{t.refs.join(', ')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={8}>Total for priced products{sum.unpriced ? ` (${sum.unpriced} custom size${sum.unpriced === 1 ? '' : 's'} not priced)` : ''}</td><td className="num" data-total>{price(sum.total)}</td><td /></tr>
          </tfoot>
        </table>
      </div>
      <h3>Every opening</h3>
      <div className="table-wrap">
        <table className="schedule" data-table="all">
          <thead><tr><th>Ref</th><th>Product</th><th>Type</th><th>Head</th><th>Frame</th><th>Opening W × H</th><th>Frame W × H</th><th>Sill</th><th>Head height</th><th>Where</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><button type="button" className="ref" onClick={() => { store.select(r.id); rig.invalidate(); close(); }}>{r.ref}</button></td>
                <td>{r.product || <span className="muted">Custom</span>}</td>
                <td>{r.kind}</td><td>{r.shape}</td><td>{r.finish}</td>
                <td className="num">{r.width} × {r.height}</td><td className="num">{r.frameWidth} × {r.frameHeight}</td>
                <td className="num">{r.sill}</td><td className="num">{r.head}</td>
                <td>{r.building}, {r.level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button type="button" onClick={close}>Close</button>
        <button type="button" className="primary" data-action="download-schedule"
          onClick={() => download(projects.fileName(doc).replace('.likuloka.json', '-schedule.csv'), scheduleCsv(doc, catalogue), 'text/csv')}>Download CSV</button>
      </div>
    </>
  );
}

/** Every buildability issue; clicking one selects and frames what it is about. */
export function ChecksDialog({ dialog, open, onClose }: { dialog: DialogRef; open: boolean; onClose: () => void }) {
  return (
    <dialog ref={dialog} className="dialog wide" aria-labelledby="checks-title" onClose={onClose}>
      <h2 id="checks-title">Checks</h2>
      {open && <ChecksBody dialog={dialog} />}
    </dialog>
  );
}

function ChecksBody({ dialog }: { dialog: DialogRef }) {
  const doc = useEditor(s => s.doc);
  const catalogue = useEditor(s => s.catalogue);
  const issues = checks(doc, catalogue);
  const close = () => dialog.current?.close();
  const warnings = issues.filter(i => i.severity === 'warning').length;
  return (
    <>
      <p>{issues.length ? `${warnings} warning${warnings === 1 ? '' : 's'} and ${issues.length - warnings} note${issues.length - warnings === 1 ? '' : 's'}.` : 'Nothing to query.'} Checks never stop an edit. Their limits are in the catalogue&rsquo;s rules: set them to the regulations where you build.</p>
      {catalogue.problems.length > 0 && <p className="error" role="alert">Catalogue: {catalogue.problems.join(' ')}</p>}
      <ul className="issues">
        {issues.map(i => (
          <li key={i.key} data-severity={i.severity} data-rule={i.rule}>
            <button type="button" onClick={() => {
              store.select(i.node);
              close();
              import('@/render/Viewport').then(m => m.focus(i.node));
            }}>
              <span className="sev">{i.severity === 'warning' ? 'Warning' : 'Note'}</span>
              <span>{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="actions"><button type="button" onClick={close}>Close</button></div>
    </>
  );
}

/** Lets a designer see the project as a client will, and come back. A share link's client view is fixed. */
function RoleSwitch() {
  const role = useEditor(s => s.role);
  if (role.kind === 'client' && role.fixed) return null;
  return role.kind === 'designer'
    ? <button type="button" data-action="client-view" onClick={() => store.setRole({ kind: 'client', fixed: false })}>Preview as client</button>
    : <button type="button" data-action="designer-view" onClick={() => store.setRole({ kind: 'designer' })}>Back to designer view</button>;
}

/** Versions of the project: save one, compare it with now, approve it, restore it. */
export function VersionsDialog({ dialog, open, onClose }: { dialog: DialogRef; open: boolean; onClose: () => void }) {
  return (
    <dialog ref={dialog} className="dialog wide" aria-labelledby="versions-title" onClose={onClose}>
      <h2 id="versions-title">Versions and sign-off</h2>
      {open && <VersionsBody dialog={dialog} />}
    </dialog>
  );
}

const day = (t: number) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function VersionsBody({ dialog }: { dialog: DialogRef }) {
  const project = useEditor(s => s.project);
  const doc = useEditor(s => s.doc);
  const client = useEditor(store.isClient);
  const catalogue = useEditor(s => s.catalogue);
  const [list, setList] = useState<Version[] | null>(null);
  const [note, setNote] = useState('');
  const [name, setName] = useState(rememberedName);
  const [error, setError] = useState('');
  const [comparing, setComparing] = useState<Version | null>(null);
  const [approving, setApproving] = useState<Version | null>(null);
  const [agree, setAgree] = useState(false);
  const versions = versionStore(project.where);

  useEffect(() => {
    let live = true;
    versions.list(project.id).then(l => { if (live) setList(l); }, e => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [versions, project.id]);

  const run = async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); setList(await versions.list(project.id)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const close = () => dialog.current?.close();

  return (
    <>
      <p>Save a version whenever the design is ready to show. The client approves a version by typing their name; the approval records who and when, and an approved version cannot be deleted. Compare shows what changed in the doors and windows and in the building before anything is ordered.</p>
      <div className="version-new">
        <label className="field wide"><span>Your name</span><input aria-label="Your name" value={name} onChange={e => setName(e.target.value)} onBlur={() => rememberName(name)} /></label>
        <label className="field wide"><span>Note</span><input aria-label="Version note" value={note} maxLength={200} placeholder="What this version is for" onChange={e => setNote(e.target.value)} /></label>
        <button type="button" className="primary" data-action="save-version" disabled={!name.trim()} onClick={() => run(async () => {
          rememberName(name);
          // A client's version is the project as saved, so unsaved changes are saved first.
          if (client && project.where === 'cloud' && isUnsaved(editor.getState()) && !(await cloud.save())) {
            throw new Error(editor.getState().error ?? 'Save the project before saving a version.');
          }
          await versions.add(project.id, { createdAt: Date.now(), author: name.trim(), note: note.trim() || 'No note', doc: editor.getState().doc, approval: null });
          setNote('');
        })}>Save this as a version</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {list === null ? <p className="hint">Loading versions…</p> : list.length === 0 ? <p className="hint">No versions yet.</p> : (
        <ul className="versions">
          {list.map(v => (
            <li key={v.id} data-version={v.number} data-approved={!!v.approval}>
              <div className="head">
                <b>Version {v.number}</b>
                <span className="meta">{v.note} · {v.author} · {day(v.createdAt)}</span>
                {v.approval && <span className="approved" data-approval>Approved by {v.approval.by}, {day(v.approval.at)}{v.approval.note ? ` — “${v.approval.note}”` : ''}</span>}
              </div>
              <div className="actions start">
                <button type="button" data-action="compare" onClick={() => setComparing(comparing?.id === v.id ? null : v)}>{comparing?.id === v.id ? 'Hide changes' : 'Compare with now'}</button>
                {!v.approval && <button type="button" data-action="approve" onClick={() => { setApproving(v); setAgree(false); }}>Approve…</button>}
                {!client && <button type="button" data-action="restore" onClick={() => {
                  if (window.confirm(`Replace the design with version ${v.number}? You can undo this.`) && store.commit(() => v.doc, `Restore version ${v.number}`)) { close(); frameAll(); }
                }}>Restore</button>}
                {!v.approval && !client && <button type="button" className="danger" data-action="delete-version" onClick={() => run(() => versions.remove(project.id, v.id))}>Delete</button>}
              </div>
              {approving?.id === v.id && (
                <form className="approve" onSubmit={e => {
                  e.preventDefault();
                  run(async () => { const a = approvalFrom(name, note); rememberName(name); await versions.approve(project.id, v.id, a); setApproving(null); setNote(''); });
                }}>
                  <label className="check"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I, <b>{name.trim() || '(type your name above)'}</b>, approve version {v.number} for ordering and building.</label>
                  <div className="actions start">
                    <button type="submit" className="primary" data-action="confirm-approve" disabled={!agree || name.trim().length < 2}>Approve version {v.number}</button>
                    <button type="button" onClick={() => setApproving(null)}>Cancel</button>
                  </div>
                </form>
              )}
              {comparing?.id === v.id && <Changes c={compare(v.doc, doc, catalogue)} />}
            </li>
          ))}
        </ul>
      )}
      <div className="actions"><button type="button" onClick={close}>Close</button></div>
    </>
  );
}

/** What changed between a version and the design now. */
function Changes({ c }: { c: Comparison }) {
  if (c.same) return <p className="hint" data-changes="none">No changes since this version.</p>;
  return (
    <div className="changes" data-changes>
      {c.added.length > 0 && <p><b>Added:</b> {c.added.map(r => `${r.ref} ${r.kind.toLowerCase()} ${r.product || `${r.width} × ${r.height}`}`).join('; ')}</p>}
      {c.removed.length > 0 && <p><b>Removed:</b> {c.removed.map(r => `${r.ref} ${r.kind.toLowerCase()} ${r.product || `${r.width} × ${r.height}`}`).join('; ')}</p>}
      {c.changed.length > 0 && (
        <ul>
          {c.changed.map(ch => (
            <li key={ch.id}><b>{ch.ref}{ch.was !== ch.ref ? ` (was ${ch.was})` : ''}:</b> {ch.fields.map(f => `${f.field} ${f.from} → ${f.to}`).join('; ')}</li>
          ))}
        </ul>
      )}
      {c.structure.length > 0 && (
        <p><b>Building:</b> {c.structure.map(s => [s.added && `${s.added} ${s.kind}${s.added === 1 ? '' : 's'} added`, s.removed && `${s.removed} removed`, s.changed && `${s.changed} ${s.kind}${s.changed === 1 ? '' : 's'} changed`].filter(Boolean).join(', ')).join('; ')}</p>
      )}
    </div>
  );
}

/** Prints sheets, one A3 landscape page each, through the browser's print (and its Save as PDF). */
export function printSheets(sheets: Sheet[]) {
  const root = document.createElement('div');
  root.id = 'print-root';
  root.innerHTML = sheets.map(sh => `<section class="print-sheet">${sh.svg}</section>`).join('');
  document.body.appendChild(root);
  const done = () => { root.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  // Some browsers return from print() before printing; afterprint cleans up then.
  setTimeout(() => { if (!matchMedia('print').matches) done(); }, 1000);
}

/** Plans and wall elevations, to print, save as PDF or download as SVG. */
export function DrawingsDialog({ dialog, open, onClose }: { dialog: DialogRef; open: boolean; onClose: () => void }) {
  return (
    <dialog ref={dialog} className="dialog sheets-dialog" aria-labelledby="drawings-title" onClose={onClose}>
      <h2 id="drawings-title">Drawings</h2>
      {open && <DrawingsBody dialog={dialog} />}
    </dialog>
  );
}

function DrawingsBody({ dialog }: { dialog: DialogRef }) {
  const doc = useEditor(s => s.doc);
  const catalogue = useEditor(s => s.catalogue);
  const sheets = drawingSet(doc, catalogue);
  const close = () => dialog.current?.close();
  return (
    <>
      <p>A plan of each level and elevations of every wall with doors or windows, to scale on A3. Print them, or choose &ldquo;Save as PDF&rdquo; in the print window. Each plan also downloads as DXF, which AutoCAD and other CAD programs open at true size in millimetres (save it as DWG from AutoCAD), and each sheet as SVG.</p>
      <div className="actions start">
        <button type="button" className="primary" data-action="print" onClick={() => printSheets(sheets)}>Print or save as PDF</button>
      </div>
      <ul className="sheets">
        {sheets.map(sh => (
          <li key={sh.id} data-sheet={sh.id}>
            <div className="sheet-preview" dangerouslySetInnerHTML={{ __html: sh.svg }} />
            <div className="sheet-foot">
              <span>{sh.title}</span>
              <span className="sheet-actions">
                {sh.id.startsWith('plan-') && (
                  <button type="button" data-action="download-dxf" title="For AutoCAD and other CAD programs, at 1:1 in millimetres"
                    onClick={() => download(`${projects.fileName(doc).replace('.likuloka.json', '')}-${sh.id}.dxf`, dxfFile(doc, { levels: [sh.id.slice(5)], catalogue }), 'application/dxf')}>DXF</button>
                )}
                <button type="button" data-action="download-svg" onClick={() => download(`${projects.fileName(doc).replace('.likuloka.json', '')}-${sh.id}.svg`, sh.svg, 'image/svg+xml')}>SVG</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="actions"><button type="button" onClick={close}>Close</button></div>
    </>
  );
}

/** Accounts, cloud projects and sharing. */
export function CloudDialog({ dialog, open, onClose }: { dialog: DialogRef; open: boolean; onClose: () => void }) {
  return (
    <dialog ref={dialog} className="dialog wide" aria-labelledby="cloud-title" onClose={onClose}>
      <h2 id="cloud-title">Cloud and sharing</h2>
      {open && <CloudBody dialog={dialog} />}
    </dialog>
  );
}

function CloudBody({ dialog }: { dialog: DialogRef }) {
  const state = useEditor(s => s.cloud);
  const close = () => dialog.current?.close();
  if (state.status === 'off' || state.status === 'error') {
    return (
      <>
        <p>{state.status === 'off'
          ? 'Cloud saving is not set up on this site. Projects are kept in this browser and can be shared as files. To set up accounts, cloud projects and share links, follow “Cloud projects” in web/README.md.'
          : state.notice?.text}</p>
        <div className="actions"><button type="button" onClick={close}>Close</button></div>
      </>
    );
  }
  if (state.status === 'starting') return <p className="hint">Connecting…</p>;
  if (state.status === 'signed-out') return <SignIn close={close} />;
  return <SignedIn close={close} />;
}

function SignIn({ close }: { close: () => void }) {
  const [mode, setMode] = useState<'in' | 'new'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(cloud.explain(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <p>Sign in to save projects in the cloud, share them with clients and designers, and approve versions.</p>
      <div className="actions start"><button type="button" data-action="google" disabled={busy} onClick={() => run(cloud.signInWithGoogle)}>Continue with Google</button></div>
      <form className="sign-in" onSubmit={e => { e.preventDefault(); run(() => (mode === 'in' ? cloud.signInWithEmail(email, password) : cloud.createAccount(name, email, password))); }}>
        {mode === 'new' && <label className="field wide"><span>Your name</span><input aria-label="Your name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label>}
        <label className="field wide"><span>Email</span><input aria-label="Email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="field wide"><span>Password</span><input aria-label="Password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions start">
          <button type="submit" className="primary" data-action={mode === 'in' ? 'sign-in' : 'create-account'} disabled={busy || !email || !password}>{mode === 'in' ? 'Sign in' : 'Create account'}</button>
          <button type="button" onClick={() => setMode(mode === 'in' ? 'new' : 'in')}>{mode === 'in' ? 'I need an account' : 'I have an account'}</button>
        </div>
      </form>
      <div className="actions"><button type="button" onClick={close}>Close</button></div>
    </>
  );
}

function SignedIn({ close }: { close: () => void }) {
  const user = useEditor(s => s.cloud.user)!;
  const project = useEditor(s => s.project);
  const name = useEditor(s => s.doc.name);
  const unsaved = useEditor(isUnsaved);
  const role = useEditor(s => s.role);
  const [list, setList] = useState<cloud.CloudProject[] | null>(null);
  const [people, setPeople] = useState<cloud.Member[] | null>(null);
  const [links, setLinks] = useState<Partial<Record<'client' | 'designer', string>>>({});
  const [error, setError] = useState('');
  const run = async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); } catch (e) { setError(cloud.explain(e)); }
  };
  const inCloud = project.where === 'cloud';
  const mine = people?.find(p => p.uid === user.uid)?.role;

  useEffect(() => {
    run(async () => setList(await cloud.listCloudProjects()));
    if (inCloud) run(async () => setPeople(await cloud.members()));
  }, [inCloud, project.id]);

  return (
    <>
      <p className="who">Signed in as <b>{user.name}</b>{user.email ? ` (${user.email})` : ''}. <button type="button" className="link" data-action="sign-out" onClick={() => run(cloud.signOut)}>Sign out</button></p>

      <h3>This project</h3>
      {inCloud
        ? <p>“{name}” is saved in the cloud{unsaved ? ', with unsaved changes here' : ''}. Save keeps it there.</p>
        : <p>“{name}” is kept in this browser. Saving it to the cloud makes you its owner and lets you share it.</p>}
      <div className="actions start">
        <button type="button" className="primary" data-action="save-cloud" onClick={() => run(async () => { if (await cloud.saveToCloud()) { setList(await cloud.listCloudProjects()); setPeople(await cloud.members()); } })}>
          {inCloud ? 'Save to the cloud' : 'Move this project to the cloud'}
        </button>
      </div>

      {inCloud && role.kind === 'designer' && (mine === 'owner' || mine === 'designer') && (
        <>
          <h3>Share</h3>
          <p>A link lets whoever opens it join this project after signing in. A client can choose doors, windows, finishes and room uses, save versions and approve them. A designer can change everything.</p>
          <div className="actions start">
            <button type="button" data-action="invite-client" onClick={() => run(async () => { const url = await cloud.createInvite('client'); setLinks(l => ({ ...l, client: url })); })}>Make a client link</button>
            <button type="button" data-action="invite-designer" onClick={() => run(async () => { const url = await cloud.createInvite('designer'); setLinks(l => ({ ...l, designer: url })); })}>Make a designer link</button>
          </div>
          {(['client', 'designer'] as const).map(r => links[r] && (
            <div key={r} className="share-link" data-link={r}>
              <span>{r === 'client' ? 'Client' : 'Designer'} link</span>
              <input readOnly value={links[r]} aria-label={`${r} link`} onFocus={e => e.target.select()} />
              <button type="button" onClick={() => navigator.clipboard?.writeText(links[r]!)}>Copy</button>
            </div>
          ))}
        </>
      )}

      {inCloud && people && (
        <>
          <h3>People</h3>
          <ul className="people">
            {people.map(p => (
              <li key={p.uid} data-member={p.role}>
                <span>{p.name}{p.uid === user.uid ? ' (you)' : ''}</span>
                <em>{p.role === 'owner' ? 'Owner' : p.role === 'designer' ? 'Designer' : 'Client'}</em>
                {mine === 'owner' && p.uid !== user.uid && (
                  <button type="button" className="danger" onClick={() => {
                    if (window.confirm(`Remove ${p.name} from this project?`)) run(async () => { await cloud.removeMember(p.uid); setPeople(await cloud.members()); });
                  }}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Your cloud projects</h3>
      {list === null ? <p className="hint">Loading…</p> : list.length === 0 ? <p className="hint">None yet.</p> : (
        <ul className="projects">
          {list.map(p => (
            <li key={p.id} data-cloud-project={p.id} aria-current={p.id === project.id && inCloud}>
              <span className="name">{p.name}</span>
              <span className="meta">{p.role === 'owner' ? 'Owner' : p.role === 'designer' ? 'Designer' : 'Client'}{p.updatedAt ? ` · saved ${when(p.updatedAt)}` : ''}</span>
              {p.id === project.id && inCloud ? <em>Open now</em> : (
                <button type="button" onClick={() => {
                  if (isUnsaved(editor.getState()) && !window.confirm(`“${name}” has unsaved changes. Discard them?`)) return;
                  run(async () => { if (await cloud.openCloudProject(p.id)) { close(); frameAll(); } });
                }}>Open</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions"><button type="button" onClick={close}>Close</button></div>
    </>
  );
}

/** The project's fitting gap: frame sizes are the opening less this, each side. */
function FittingGap() {
  const tolerance = useEditor(s => s.doc.settings.tolerance);
  const client = useEditor(store.isClient);
  const [text, setText] = useState(String(Math.round(tolerance * 1000)));
  useEffect(() => setText(String(Math.round(tolerance * 1000))), [tolerance]);
  const done = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || text.trim() === '') { setText(String(Math.round(tolerance * 1000))); return; }
    if (v / 1000 !== tolerance) store.commit(d => ops.updateSettings(d, { tolerance: v / 1000 }), 'Change fitting gap');
  };
  return (
    <label className="field wide">
      <span>Fitting gap</span>
      <input type="number" aria-label="Fitting gap" min={0} max={50} step={1} value={text} disabled={client}
        onChange={e => setText(e.target.value)} onBlur={done} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <em>mm a side between each frame and its opening</em>
    </label>
  );
}
