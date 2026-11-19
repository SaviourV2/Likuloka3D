/**
 * Projects: named scenes saved in the browser, plus files to download and open.
 *
 * The editor is a static site with no server, so a project is stored in the
 * browser's local storage, and any project can be downloaded as a
 * `.likuloka.json` file and opened again on another computer.
 *
 * - `Save` writes the current scene under the current project's id.
 * - The working copy is also written as a draft on every change, so a reload
 *   never loses work; the draft is not a save.
 * - The project is unsaved when the scene is not the one last saved. Because
 *   documents are immutable, that is an identity check, and undoing back to
 *   the saved state makes the project clean again.
 */
import { emptyDoc, migrate, SceneError, validate, addBuilding, addLevel } from './ops';
import { editor, load } from './store';
import type { SceneDoc } from './types';

const INDEX = 'likuloka3d.projects';
const PREFIX = 'likuloka3d.project:';
const DRAFT = 'likuloka3d.draft';
/** Where scenes were kept before projects. */
const LEGACY = 'likuloka3d.scene';
export const FILE_FORMAT = 'likuloka3d';

export const projectId = () => `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface ProjectEntry { id: string; name: string; updatedAt: number; openings: number }

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function listProjects(): ProjectEntry[] {
  const list = read<ProjectEntry[]>(INDEX);
  return Array.isArray(list) ? [...list].sort((p, q) => q.updatedAt - p.updatedAt) : [];
}

function checked(raw: unknown): SceneDoc {
  return validate(migrate(raw));
}

/** Saves the current scene as the current project. Returns false if the browser refused to store it. */
export function saveProject(): boolean {
  const s = editor.getState();
  const now = Date.now();
  if (!write(PREFIX + s.project.id, s.doc)) {
    editor.setState({ error: 'The browser would not store the project. Download it as a file instead.' });
    return false;
  }
  const entry: ProjectEntry = {
    id: s.project.id, name: s.doc.name, updatedAt: now,
    openings: Object.values(s.doc.nodes).filter(n => n.type === 'opening').length,
  };
  write(INDEX, [entry, ...listProjects().filter(p => p.id !== entry.id)]);
  editor.setState({ project: { id: s.project.id, saved: s.doc, savedAt: now }, error: null });
  writeDraft();
  return true;
}

export function openProject(id: string): boolean {
  let doc: SceneDoc;
  try {
    doc = checked(read(PREFIX + id));
  } catch (e) {
    editor.setState({ error: e instanceof SceneError ? `That project could not be opened: ${e.message}` : 'That project could not be opened' });
    return false;
  }
  if (!load(doc)) return false;
  const entry = listProjects().find(p => p.id === id);
  // `load` may hand back a migrated copy, so the saved state is the document it loaded.
  editor.setState({ project: { id, saved: editor.getState().doc, savedAt: entry?.updatedAt ?? null } });
  writeDraft();
  return true;
}

export function deleteProject(id: string) {
  try { localStorage.removeItem(PREFIX + id); } catch { /* storage may be off */ }
  write(INDEX, listProjects().filter(p => p.id !== id));
  // Deleting the open project leaves its scene open, as a new, unsaved project.
  const s = editor.getState();
  if (s.project.id === id) editor.setState({ project: { id: projectId(), saved: null, savedAt: null } });
}

/** A blank project: one building with a ground floor, ready to draw on. */
export function blankScene(name = 'Untitled project'): SceneDoc {
  let [doc, b] = addBuilding(emptyDoc(name), { name: 'Building 1' });
  [doc] = addLevel(doc, b, { name: 'Ground floor' });
  return doc;
}

/** Starts a new, unsaved project from a scene. */
export function newProject(doc: SceneDoc): boolean {
  if (!load(doc)) return false;
  editor.setState({ project: { id: projectId(), saved: null, savedAt: null } });
  writeDraft();
  return true;
}

export function fileName(doc: SceneDoc) {
  const slug = doc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `${slug}.likuloka.json`;
}

/** The project as a file's text. */
export function projectFile(doc: SceneDoc): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, savedAt: new Date().toISOString(), doc }, null, 2);
}

/** Opens a downloaded project file as a new, unsaved project. */
export function openProjectFile(text: string): boolean {
  let doc: SceneDoc;
  try {
    const parsed = JSON.parse(text) as { format?: string; doc?: unknown };
    doc = checked(parsed?.format === FILE_FORMAT ? parsed.doc : parsed);
  } catch (e) {
    editor.setState({ error: e instanceof SceneError ? `That file is not a Likuloka project: ${e.message}` : 'That file is not a Likuloka project' });
    return false;
  }
  return newProject(doc);
}

/** Writes the working copy, so a reload restores it. */
export function writeDraft() {
  const s = editor.getState();
  write(DRAFT, { projectId: s.project.id, doc: s.doc, saved: s.project.saved === s.doc });
}

/** Restores the working copy from the last visit. Returns false if there is none. */
export function restore(): boolean {
  const draft = read<{ projectId: string; doc: unknown; saved: boolean }>(DRAFT);
  if (draft?.doc) {
    try {
      const doc = checked(draft.doc);
      if (!load(doc)) return false;
      const entry = listProjects().find(p => p.id === draft.projectId);
      editor.setState({ project: { id: draft.projectId, saved: draft.saved && entry ? editor.getState().doc : null, savedAt: entry?.updatedAt ?? null } });
      return true;
    } catch { /* a broken draft is dropped */ }
  }
  const legacy = read(LEGACY);
  if (legacy) {
    try {
      return newProject(checked(legacy));
    } catch { /* ignore */ }
  }
  return false;
}
