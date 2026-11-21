/**
 * The server-side check on what a client may save.
 *
 * Clients cannot write a project's scene to Firestore directly: the rules
 * refuse it. They save through `saveScene`, which runs the same check as the
 * editor (`clientRefusal`, bundled from the web app's `src/scene/access.ts`)
 * against the scene as it is saved now, and writes the new scene only if it
 * passes. A changed or scripted editor gets the same answer as the real one.
 *
 * Designers and owners may call it too, without the client limits; the editor
 * lets them write directly instead.
 */
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { clientRefusal } from '../../src/scene/access';
import { migrate, validate } from '../../src/scene/ops';
import type { SceneDoc } from '../../src/scene/types';

initializeApp();

/** The largest scene stored, to stay inside Firestore's 1 MiB document limit. */
const MAX_SCENE = 900_000;

/** `name` is the saver's display name, as they want others to see it. */
interface SaveRequest { projectId: string; scene: string; baseVersion: number; name?: string }

function parse(text: unknown, what: string): SceneDoc {
  if (typeof text !== 'string' || text.length >= MAX_SCENE) throw new HttpsError('invalid-argument', `The ${what} is missing or too large.`);
  try {
    return validate(migrate(JSON.parse(text)));
  } catch (e) {
    throw new HttpsError('invalid-argument', `The ${what} is not a valid scene: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const saveScene = onCall<SaveRequest>({ maxInstances: 10 }, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to save.');
  const { projectId, scene, baseVersion, name: given } = request.data ?? ({} as SaveRequest);
  if (typeof projectId !== 'string' || !projectId || !Number.isInteger(baseVersion)) {
    throw new HttpsError('invalid-argument', 'A save needs the project and the version it is based on.');
  }
  const next = parse(scene, 'new scene');
  const tokenName = (request.auth?.token.name as string | undefined) || (request.auth?.token.email as string | undefined)?.split('@')[0] || 'Someone';

  const db = getFirestore();
  const ref = db.doc(`projects/${projectId}`);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.data();
    // Same answer whether the project is missing or not shared with this person.
    const role = data?.members?.[uid] as string | undefined;
    if (!data || !role) throw new HttpsError('not-found', 'That project no longer exists, or you have no access to it.');
    if (data.sceneVersion !== baseVersion) {
      const who = data.memberNames?.[data.updatedBy] ?? 'Someone';
      throw new HttpsError('failed-precondition', `${who} saved this project after you opened it.`, { savedBy: who, sceneVersion: data.sceneVersion });
    }
    if (role === 'client') {
      const refusal = clientRefusal(parse(data.scene, 'saved scene'), next);
      if (refusal) throw new HttpsError('permission-denied', refusal);
    }
    const sceneVersion = baseVersion + 1;
    // Their own display name; a fresh account's token may not carry it yet, so the editor sends it.
    const name = typeof given === 'string' && given.trim().length >= 2 ? given.trim().slice(0, 80) : data.memberNames?.[uid] ?? tokenName;
    tx.update(ref, {
      scene, name: next.name, sceneVersion,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid, [`memberNames.${uid}`]: name,
    });
    return { sceneVersion };
  });
});
