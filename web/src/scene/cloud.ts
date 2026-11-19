/**
 * Cloud projects on Firebase: accounts, projects saved in Firestore, share
 * links with a role, members, versions and approvals, and notice when someone
 * else saves.
 *
 * The site stays static: the browser talks to Firebase directly, and
 * `firebase/firestore.rules` decides who may read and write what. The web
 * config is read at runtime from `cloud.json` beside the page, so cloud can be
 * switched on by adding that file, without rebuilding. Firebase web config is
 * public by design; security comes from the rules. Without `cloud.json` the
 * cloud features say they are not set up and everything else works as before.
 *
 * The Firebase SDK is loaded only once `cloud.json` is found.
 */
import { editor, load, setRole, type CloudUser } from './store';
import { migrate, validate } from './ops';
import { saveProject } from './projects';
import { setCloudVersions, type Approval, type Version, type VersionStore } from './versions';
import type { SceneDoc } from './types';

type FirebaseApp = import('firebase/app').FirebaseApp;
type Auth = import('firebase/auth').Auth;
type Firestore = import('firebase/firestore').Firestore;
type FS = typeof import('firebase/firestore');
type AU = typeof import('firebase/auth');

export interface CloudConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  /** For local development and tests: where the Firebase emulators listen. */
  emulators?: { auth?: string; firestore?: { host: string; port: number } };
}

export type MemberRole = 'owner' | 'designer' | 'client';
export interface CloudProject { id: string; name: string; updatedAt: number | null; role: MemberRole }
export interface Member { uid: string; name: string; role: MemberRole }

let sdk: { app: FirebaseApp; auth: Auth; db: Firestore; fs: FS; au: AU } | null = null;
let unwatch: (() => void) | null = null;

const setCloud = (patch: Partial<ReturnType<typeof editor.getState>['cloud']>) =>
  editor.setState(s => ({ cloud: { ...s.cloud, ...patch } }));

function need() {
  if (!sdk) throw new Error('Cloud saving is not set up on this site.');
  const user = editor.getState().cloud.user;
  if (!user) throw new Error('Sign in to use the cloud.');
  return { ...sdk, user };
}

/** Plain-language messages for Firebase errors. */
export function explain(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const known: Record<string, string> = {
    'permission-denied': 'You do not have permission to do that in this project.',
    'auth/invalid-credential': 'That email and password do not match an account.',
    'auth/wrong-password': 'That email and password do not match an account.',
    'auth/user-not-found': 'There is no account with that email.',
    'auth/email-already-in-use': 'There is already an account with that email. Sign in instead.',
    'auth/weak-password': 'Choose a password of at least 6 characters.',
    'auth/invalid-email': 'That is not a valid email address.',
    'auth/popup-closed-by-user': 'The sign-in window was closed before signing in.',
    'auth/network-request-failed': 'Could not reach the sign-in service. Check the connection.',
    unavailable: 'Could not reach the cloud. Check the connection and try again.',
    'not-found': 'That project no longer exists, or you have no access to it.',
  };
  return known[code] ?? (e instanceof Error ? e.message : String(e));
}

/** Reads `cloud.json` and starts Firebase. Resolves once the signed-in user (or none) is known. */
export async function startCloud(): Promise<boolean> {
  let config: CloudConfig;
  try {
    const res = await fetch('cloud.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error();
    config = await res.json();
    if (!config?.projectId || !config?.apiKey) throw new Error();
  } catch {
    setCloud({ status: 'off', user: null });
    return false;
  }
  setCloud({ status: 'starting' });
  try {
    const [{ initializeApp, getApps }, au, fs] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
    const app = getApps()[0] ?? initializeApp(config);
    const auth = au.getAuth(app);
    const db = fs.getFirestore(app);
    if (config.emulators?.auth) au.connectAuthEmulator(auth, config.emulators.auth, { disableWarnings: true });
    if (config.emulators?.firestore) fs.connectFirestoreEmulator(db, config.emulators.firestore.host, config.emulators.firestore.port);
    sdk = { app, auth, db, fs, au };
    setCloudVersions(cloudVersions);
    await new Promise<void>(resolve => {
      au.onAuthStateChanged(auth, u => {
        const user: CloudUser | null = u ? { uid: u.uid, name: u.displayName || u.email?.split('@')[0] || 'Someone', email: u.email } : null;
        setCloud({ status: user ? 'signed-in' : 'signed-out', user });
        const p = editor.getState().project;
        if (user && p.where === 'cloud') watch(p.id);
        resolve();
      });
    });
    return true;
  } catch (e) {
    setCloud({ status: 'error', notice: { kind: 'error', text: `The cloud could not start: ${explain(e)}` } });
    return false;
  }
}

export async function signInWithGoogle() {
  if (!sdk) throw new Error('Cloud saving is not set up on this site.');
  await sdk.au.signInWithPopup(sdk.auth, new sdk.au.GoogleAuthProvider());
}

export async function signInWithEmail(email: string, password: string) {
  if (!sdk) throw new Error('Cloud saving is not set up on this site.');
  await sdk.au.signInWithEmailAndPassword(sdk.auth, email.trim(), password);
}

export async function createAccount(name: string, email: string, password: string) {
  if (!sdk) throw new Error('Cloud saving is not set up on this site.');
  if (name.trim().length < 2) throw new Error('Type your name, as clients and designers will see it.');
  const cred = await sdk.au.createUserWithEmailAndPassword(sdk.auth, email.trim(), password);
  await sdk.au.updateProfile(cred.user, { displayName: name.trim() });
  setCloud({ user: { uid: cred.user.uid, name: name.trim(), email: cred.user.email } });
}

export async function signOut() {
  unwatch?.();
  unwatch = null;
  if (sdk) await sdk.au.signOut(sdk.auth);
}

const sceneText = (doc: SceneDoc) => JSON.stringify(doc);
const parseScene = (text: string) => validate(migrate(JSON.parse(text)));
const millis = (t: unknown) => (t && typeof (t as { toMillis?: () => number }).toMillis === 'function' ? (t as { toMillis: () => number }).toMillis() : null);

/**
 * Saves the open project to the cloud. A browser project is copied up and
 * becomes a cloud project owned by the person saving. Each save must follow
 * the save it was based on, so two people never overwrite each other unseen.
 */
export async function saveToCloud(): Promise<boolean> {
  const { fs, db, user } = need();
  const s = editor.getState();
  try {
    if (s.project.where !== 'cloud') {
      const ref = fs.doc(fs.collection(db, 'projects'));
      await fs.setDoc(ref, {
        name: s.doc.name, ownerUid: user.uid, members: { [user.uid]: 'owner' }, memberUids: [user.uid],
        memberNames: { [user.uid]: user.name }, scene: sceneText(s.doc), sceneVersion: 1,
        updatedAt: fs.serverTimestamp(), updatedBy: user.uid,
      });
      editor.setState({ project: { id: ref.id, where: 'cloud', saved: s.doc, savedAt: Date.now(), cloudVersion: 1 }, error: null });
      setCloud({ notice: null });
      watch(ref.id);
      return true;
    }
    const v = (s.project.cloudVersion ?? 1) + 1;
    await fs.updateDoc(fs.doc(db, 'projects', s.project.id), {
      name: s.doc.name, scene: sceneText(s.doc), sceneVersion: v,
      updatedAt: fs.serverTimestamp(), updatedBy: user.uid, [`memberNames.${user.uid}`]: user.name,
    });
    editor.setState(st => ({ project: { ...st.project, saved: s.doc, savedAt: Date.now(), cloudVersion: v }, error: null }));
    setCloud({ notice: null });
    return true;
  } catch (e) {
    // A refused save is most often someone else having saved first.
    let text = explain(e);
    try {
      const snap = await fs.getDoc(fs.doc(db, 'projects', s.project.id));
      const data = snap.data();
      if (data && data.sceneVersion !== s.project.cloudVersion) {
        text = `${data.memberNames?.[data.updatedBy] ?? 'Someone'} saved this project after you opened it. Download your copy (Project, then Download file), reopen the project, and make your changes again.`;
      }
    } catch { /* keep the first message */ }
    editor.setState({ error: text });
    return false;
  }
}

/** Saves where the project lives: the cloud for a cloud project, this browser otherwise. */
export async function save(): Promise<boolean> {
  return editor.getState().project.where === 'cloud' ? saveToCloud() : saveProject();
}

/** Opens a cloud project; a member who is a client gets the client view and cannot leave it. */
export async function openCloudProject(id: string): Promise<boolean> {
  const { fs, db, user } = need();
  try {
    const snap = await fs.getDoc(fs.doc(db, 'projects', id));
    if (!snap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
    const data = snap.data();
    const doc = parseScene(data.scene);
    // The role comes from the project, not from what was open before.
    editor.setState({ role: { kind: 'designer' } });
    if (!load(doc)) return false;
    editor.setState({ project: { id, where: 'cloud', saved: editor.getState().doc, savedAt: millis(data.updatedAt), cloudVersion: data.sceneVersion }, error: null });
    const role = data.members?.[user.uid] as MemberRole | undefined;
    if (role === 'client') setRole({ kind: 'client', fixed: true });
    setCloud({ notice: null });
    watch(id);
    return true;
  } catch (e) {
    editor.setState({ error: explain(e) });
    return false;
  }
}

/** Tells the person when someone else saves the open project. */
function watch(id: string) {
  if (!sdk) return;
  unwatch?.();
  const { fs, db } = sdk;
  unwatch = fs.onSnapshot(fs.doc(db, 'projects', id), snap => {
    const data = snap.data();
    const s = editor.getState();
    if (!data || s.project.id !== id) return;
    if (data.sceneVersion > (s.project.cloudVersion ?? 0) && data.updatedBy !== s.cloud.user?.uid) {
      setCloud({ notice: { kind: 'remote', text: `${data.memberNames?.[data.updatedBy] ?? 'Someone'} saved a newer version of this project.` } });
    }
  }, () => { /* access ended, e.g. removed from the project */ });
}

export async function listCloudProjects(): Promise<CloudProject[]> {
  const { fs, db, user } = need();
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'projects'), fs.where('memberUids', 'array-contains', user.uid)));
  return snap.docs
    .map(d => ({ id: d.id, name: d.data().name as string, updatedAt: millis(d.data().updatedAt), role: d.data().members?.[user.uid] as MemberRole }))
    .sort((p, q) => (q.updatedAt ?? 0) - (p.updatedAt ?? 0));
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...bytes].map(b => abc[b % abc.length]).join('');
}

/** Makes a share link that lets whoever opens it join the project with this role. */
export async function createInvite(role: 'designer' | 'client'): Promise<string> {
  const { fs, db, user } = need();
  const s = editor.getState();
  if (s.project.where !== 'cloud') throw new Error('Save the project to the cloud before sharing it.');
  const t = token();
  await fs.setDoc(fs.doc(db, 'invites', t), { projectId: s.project.id, role, createdBy: user.uid, createdAt: fs.serverTimestamp(), projectName: s.doc.name });
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('project', s.project.id);
  url.searchParams.set('invite', t);
  return url.toString();
}

/** Joins a project from a share link, then opens it. */
export async function acceptInvite(projectId: string, invite: string): Promise<boolean> {
  const { fs, db, user } = need();
  try {
    const inv = await fs.getDoc(fs.doc(db, 'invites', invite));
    if (!inv.exists() || inv.data().projectId !== projectId) throw new Error('That share link is not valid any more. Ask for a new one.');
    // Joining needs no read access, which only members have.
    await fs.updateDoc(fs.doc(db, 'projects', projectId), {
      [`members.${user.uid}`]: inv.data().role, memberUids: fs.arrayUnion(user.uid),
      [`memberNames.${user.uid}`]: user.name, joinedWith: invite,
    }).catch(async e => {
      // Already a member: the update is refused, but the project opens.
      const mine = await fs.getDoc(fs.doc(db, 'projects', projectId)).catch(() => null);
      if (!mine?.exists()) throw e;
    });
    return openCloudProject(projectId);
  } catch (e) {
    editor.setState({ error: explain(e) });
    return false;
  }
}

export async function members(): Promise<Member[]> {
  const { fs, db } = need();
  const s = editor.getState();
  const snap = await fs.getDoc(fs.doc(db, 'projects', s.project.id));
  const data = snap.data();
  if (!data) return [];
  return Object.entries(data.members as Record<string, MemberRole>)
    .map(([uid, role]) => ({ uid, role, name: data.memberNames?.[uid] ?? 'Someone' }))
    .sort((p, q) => ['owner', 'designer', 'client'].indexOf(p.role) - ['owner', 'designer', 'client'].indexOf(q.role));
}

export async function removeMember(uid: string) {
  const { fs, db } = need();
  const s = editor.getState();
  await fs.updateDoc(fs.doc(db, 'projects', s.project.id), {
    [`members.${uid}`]: fs.deleteField(), memberUids: fs.arrayRemove(uid), [`memberNames.${uid}`]: fs.deleteField(),
  });
}

/** Runs a cloud call, turning Firebase's errors into plain language. */
async function plain<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) { throw new Error(explain(e)); }
}

/** Versions in the project's `versions` collection. */
const rawVersions: VersionStore = {
  async list(projectId) {
    const { fs, db } = need();
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'projects', projectId, 'versions'), fs.orderBy('number', 'desc')));
    return snap.docs.map(d => {
      const v = d.data();
      return {
        id: d.id, number: v.number, createdAt: millis(v.createdAt) ?? Date.now(), author: v.author, note: v.note,
        doc: parseScene(v.scene),
        approval: v.approval ? { by: v.approval.by, at: millis(v.approval.at) ?? Date.now(), note: v.approval.note ?? '' } : null,
      } satisfies Version;
    });
  },
  async add(projectId, v) {
    const { fs, db, user } = need();
    const latest = await fs.getDocs(fs.query(fs.collection(db, 'projects', projectId, 'versions'), fs.orderBy('number', 'desc'), fs.limit(1)));
    const number = (latest.docs[0]?.data().number ?? 0) + 1;
    const ref = fs.doc(fs.collection(db, 'projects', projectId, 'versions'));
    await fs.setDoc(ref, { number, createdAt: fs.serverTimestamp(), author: v.author.slice(0, 80), authorUid: user.uid, note: v.note.slice(0, 200), scene: sceneText(v.doc), approval: null });
    return { ...v, id: ref.id, number };
  },
  async approve(projectId, versionId, a: Approval) {
    const { fs, db, user } = need();
    await fs.updateDoc(fs.doc(db, 'projects', projectId, 'versions', versionId), { approval: { by: a.by, note: a.note, uid: user.uid, at: fs.serverTimestamp() } });
    const list = await rawVersions.list(projectId);
    return list.find(v => v.id === versionId)!;
  },
  async remove(projectId, versionId) {
    const { fs, db } = need();
    await fs.deleteDoc(fs.doc(db, 'projects', projectId, 'versions', versionId));
  },
};

const cloudVersions: VersionStore = {
  list: id => plain(() => rawVersions.list(id)),
  add: (id, v) => plain(() => rawVersions.add(id, v)),
  approve: (id, vid, a) => plain(() => rawVersions.approve(id, vid, a)),
  remove: (id, vid) => plain(() => rawVersions.remove(id, vid)),
};

/** Reloads the open cloud project from the cloud, after someone else saved it. */
export async function reload(): Promise<boolean> {
  const p = editor.getState().project;
  return p.where === 'cloud' ? openCloudProject(p.id) : false;
}
