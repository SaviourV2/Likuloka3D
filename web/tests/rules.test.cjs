/*
 * Tests for firebase/firestore.rules, against the Firestore emulator.
 *   npm run test:rules
 */
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp, deleteField } = require('firebase/firestore');

let passed = 0, failed = 0;
async function check(name, promise) {
  try { await promise; passed++; console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, String(e && e.message || e).split('\n')[0]); }
}

const scene = JSON.stringify({ name: 'Test', settings: { tolerance: 0.01 }, nodes: {}, roots: [] });
const base = (owner) => ({
  name: 'Beach house', ownerUid: owner, members: { [owner]: 'owner' }, memberUids: [owner], memberNames: { [owner]: 'Olive' },
  scene, sceneVersion: 1, updatedAt: serverTimestamp(), updatedBy: owner,
});

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-likuloka',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firebase', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const as = uid => env.authenticatedContext(uid).firestore();
  const anon = env.unauthenticatedContext().firestore();
  const owner = as('olive'), designer = as('dan'), client = as('cara'), stranger = as('sam');
  const P = db => doc(db, 'projects', 'p1');

  await check('the owner creates a project', assertSucceeds(setDoc(P(owner), base('olive'))));
  await check('nobody can create a project in someone else’s name', assertFails(setDoc(doc(stranger, 'projects', 'p2'), base('olive'))));
  await check('a stranger cannot read the project', assertFails(getDoc(P(stranger))));
  await check('signed-out visitors cannot read it', assertFails(getDoc(P(anon))));
  await check('a stranger cannot list it', assertFails(getDocs(query(collection(stranger, 'projects'), where('memberUids', 'array-contains', 'olive')))));
  await check('the owner lists their own projects', assertSucceeds(getDocs(query(collection(owner, 'projects'), where('memberUids', 'array-contains', 'olive')))));

  // Invites.
  await check('the owner invites a designer', assertSucceeds(setDoc(doc(owner, 'invites', 'designer-token-0123456789'), { projectId: 'p1', role: 'designer', createdBy: 'olive', createdAt: serverTimestamp(), projectName: 'Beach house' })));
  await check('the owner invites a client', assertSucceeds(setDoc(doc(owner, 'invites', 'client-token-0123456789ab'), { projectId: 'p1', role: 'client', createdBy: 'olive', createdAt: serverTimestamp(), projectName: 'Beach house' })));
  await check('an invite cannot give ownership', assertFails(setDoc(doc(owner, 'invites', 'owner-token-0123456789abc'), { projectId: 'p1', role: 'owner', createdBy: 'olive', createdAt: serverTimestamp() })));
  await check('a stranger cannot make invites to a project', assertFails(setDoc(doc(stranger, 'invites', 'sneaky-token-0123456789ab'), { projectId: 'p1', role: 'designer', createdBy: 'sam', createdAt: serverTimestamp() })));
  await check('invites cannot be listed', assertFails(getDocs(collection(stranger, 'invites'))));
  const join = (db, uid, role, token, name) => updateDoc(P(db), { [`members.${uid}`]: role, memberUids: role ? [...joined, uid] : joined, [`memberNames.${uid}`]: name, joinedWith: token });
  let joined = ['olive'];
  await check('a client cannot join with the designer’s role', assertFails(join(client, 'cara', 'designer', 'client-token-0123456789ab', 'Cara')));
  await check('nobody joins without an invite', assertFails(join(stranger, 'sam', 'client', 'no-such-token-0123456789', 'Sam')));
  await check('a client joins with their invite', assertSucceeds(join(client, 'cara', 'client', 'client-token-0123456789ab', 'Cara')));
  joined = ['olive', 'cara'];
  await check('a designer joins with theirs', assertSucceeds(join(designer, 'dan', 'designer', 'designer-token-0123456789', 'Dan')));
  joined = ['olive', 'cara', 'dan'];
  await check('the client now reads the project', assertSucceeds(getDoc(P(client))));

  // Saving.
  const save = (db, uid, v, extra = {}) => updateDoc(P(db), { scene, sceneVersion: v, updatedAt: serverTimestamp(), updatedBy: uid, ...extra });
  await check('a designer saves the next version of the scene', assertSucceeds(save(designer, 'dan', 2)));
  await check('a save that skips a version is refused', assertFails(save(designer, 'dan', 4)));
  await check('a save that would overwrite someone else’s is refused', assertFails(save(owner, 'olive', 2)));
  await check('a save signed as someone else is refused', assertFails(save(designer, 'olive', 3)));
  await check('a client cannot write the scene directly; saves go through the function', assertFails(save(client, 'cara', 3)));
  await check('the next save is still in turn', assertSucceeds(save(designer, 'dan', 3)));
  await check('a client cannot change members', assertFails(updateDoc(P(client), { 'members.cara': 'designer' })));
  await check('a client cannot change ownership', assertFails(save(client, 'cara', 4, { ownerUid: 'cara' })));
  await check('a designer cannot change ownership', assertFails(save(designer, 'dan', 4, { ownerUid: 'dan' })));
  await check('a designer cannot remove members', assertFails(updateDoc(P(designer), { 'members.cara': deleteField(), memberUids: ['olive', 'dan'], 'memberNames.cara': deleteField() })));
  await check('a designer cannot delete the project', assertFails(deleteDoc(P(designer))));

  // Versions.
  const V = (db, id) => doc(db, 'projects', 'p1', 'versions', id);
  const version = (uid, extra = {}) => ({ number: 1, createdAt: serverTimestamp(), author: 'Cara', authorUid: uid, note: 'First look', scene, approval: null, ...extra });
  await check('a client saves a version of the project as saved', assertSucceeds(setDoc(V(client, 'v1'), version('cara'))));
  await check('a client cannot save a different scene as a version', assertFails(setDoc(V(client, 'v1b'), version('cara', { scene: scene.replace('Test', 'Tampered') }))));
  await check('a designer can save a version of a design not yet saved', assertSucceeds(setDoc(V(designer, 'v1c'), version('dan', { author: 'Dan', scene: scene.replace('Test', 'Draft') }))));
  await check('a version cannot be saved already approved', assertFails(setDoc(V(client, 'v2'), version('cara', { approval: { by: 'Cara', uid: 'cara' } }))));
  await check('a version cannot be saved in someone else’s name', assertFails(setDoc(V(designer, 'v3'), version('cara'))));
  await check('a stranger cannot read versions', assertFails(getDoc(V(stranger, 'v1'))));
  await check('a version’s content cannot be changed', assertFails(updateDoc(V(designer, 'v1'), { scene: '{}' })));
  await check('approving in someone else’s name is refused', assertFails(updateDoc(V(designer, 'v1'), { approval: { by: 'Cara Client', uid: 'cara', at: serverTimestamp(), note: '' } })));
  await check('the client approves the version', assertSucceeds(updateDoc(V(client, 'v1'), { approval: { by: 'Cara Client', uid: 'cara', at: serverTimestamp(), note: 'Go ahead' } })));
  await check('an approval cannot be changed', assertFails(updateDoc(V(owner, 'v1'), { approval: { by: 'Olive', uid: 'olive', at: serverTimestamp(), note: '' } })));
  await check('an approved version cannot be deleted', assertFails(deleteDoc(V(owner, 'v1'))));
  await check('a designer deletes an unapproved version', (async () => {
    await assertSucceeds(setDoc(V(designer, 'v4'), version('dan', { number: 2, author: 'Dan' })));
    await assertSucceeds(deleteDoc(V(designer, 'v4')));
  })());
  await check('a client cannot delete versions', (async () => {
    await assertSucceeds(setDoc(V(client, 'v5'), version('cara', { number: 3 })));
    await assertFails(deleteDoc(V(client, 'v5')));
  })());

  // Membership and deletion.
  await check('the owner removes a member', assertSucceeds(updateDoc(P(owner), { 'members.cara': deleteField(), memberUids: ['olive', 'dan'], 'memberNames.cara': deleteField() })));
  await check('a removed member can no longer read', assertFails(getDoc(P(client))));
  await check('members and memberUids must agree', assertFails(updateDoc(P(owner), { memberUids: ['olive'] })));
  await check('the owner deletes the project', assertSucceeds(deleteDoc(P(owner))));

  await env.cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
