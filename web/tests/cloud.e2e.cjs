/*
 * Cloud projects end to end, against the Firebase Auth and Firestore
 * emulators, with two browsers: a designer and a client.
 *
 *   npm run test:cloud     # starts the emulators and runs this against out/
 *
 * The page reads cloud.json at runtime; here it is answered with the
 * emulators' address, so the same build is tested as is deployed.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'out');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };
const CONFIG = {
  apiKey: 'demo-key', authDomain: 'demo-likuloka.firebaseapp.com', projectId: 'demo-likuloka', appId: 'demo-app',
  emulators: { auth: 'http://127.0.0.1:9099', firestore: { host: '127.0.0.1', port: 8080 }, functions: { host: '127.0.0.1', port: 5001 } },
};
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function person(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('**/cloud.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(CONFIG) }));
  await page.goto(url);
  await page.waitForFunction(() => window.likuloka && document.documentElement.dataset.backend && ['signed-out', 'signed-in'].includes(likuloka.cloud.state().status), null, { timeout: 60000 });
  return { page, context, errors };
}

const state = page => page.evaluate(() => likuloka.getState());
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });

async function menu(page, action) {
  await page.locator('[data-action="menu"]').click();
  await page.locator(`.menu-items [data-action="${action}"]`).click();
}

async function createAccount(page, name, email) {
  const dlg = page.locator('dialog[aria-labelledby="cloud-title"]');
  await dlg.getByRole('button', { name: 'I need an account' }).click();
  await dlg.getByLabel('Your name').fill(name);
  await dlg.getByLabel('Email').fill(email);
  await dlg.getByLabel('Password').fill('correct horse battery');
  await dlg.locator('[data-action="create-account"]').click();
}

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const stamp = Date.now().toString(36);
  try {
    // ---- the designer -----------------------------------------------------------------------
    const dana = await person(browser, url);
    const d = dana.page;
    await d.evaluate(() => { localStorage.clear(); likuloka.reset(); });
    ok('cloud starts signed out when the site has cloud.json', (await d.evaluate(() => likuloka.cloud.state().status)) === 'signed-out');
    await menu(d, 'cloud');
    await createAccount(d, 'Dana Designer', `dana-${stamp}@example.com`);
    await until(d, () => likuloka.cloud.state().user?.name === 'Dana Designer');
    ok('a designer creates an account and is signed in', (await d.evaluate(() => likuloka.cloud.state().user.name)) === 'Dana Designer');

    await d.locator('[data-action="save-cloud"]').click();
    await until(d, () => likuloka.getState().project.unsaved === false && likuloka.getState().project.id.length === 20);
    const projectId = (await state(d)).project.id;
    ok('a browser project moves to the cloud', await d.evaluate(() => likuloka.cloud.state().status === 'signed-in') && !!projectId);
    await until(d, () => document.querySelectorAll('.people li').length === 1);
    ok('its owner is listed', (await d.locator('.people li').first().textContent()).includes('Dana Designer'));
    await d.locator('[data-action="invite-client"]').click();
    await until(d, () => !!document.querySelector('[data-link="client"] input')?.value);
    const link = await d.locator('[data-link="client"] input').inputValue();
    ok('the owner makes a client share link', link.includes(`project=${projectId}`) && /invite=\w{24}/.test(link), link);
    await d.locator('dialog[aria-labelledby="cloud-title"]').getByRole('button', { name: 'Close' }).click();

    // ---- the client ---------------------------------------------------------------------------
    const carl = await person(browser, link);
    const c = carl.page;
    await until(c, () => document.querySelector('dialog[aria-labelledby="cloud-title"]')?.open);
    ok('a share link asks the client to sign in first', true);
    await createAccount(c, 'Carl Client', `carl-${stamp}@example.com`);
    await until(c, id => likuloka.getState().project.id === id, projectId);
    let cs = await state(c);
    ok('after signing in, the client joins and the project opens', cs.project.id === projectId && cs.project.name === 'Sample house' && !cs.project.unsaved, cs.project);
    ok('the client gets the client view, and cannot leave it', (await c.evaluate(() => likuloka.role())).kind === 'client' && (await c.evaluate(() => likuloka.role())).fixed && !(await c.evaluate(() => likuloka.setRole({ kind: 'designer' }))));
    ok('the share link leaves the address bar once used', !c.url().includes('invite='), c.url());
    const wallId = await c.evaluate(() => Object.values(likuloka.getDoc().nodes).find(n => n.type === 'wall').id);
    const moved = await c.evaluate(i => likuloka.commit(d => likuloka.ops.offsetWall(d, i, 1), 'Move'), wallId);
    ok('the client cannot move walls', !moved && /client view/.test((await state(c)).error), (await state(c)).error);
    const door = await c.evaluate(() => Object.values(likuloka.getDoc().nodes).find(n => n.type === 'opening' && n.kind === 'door' && n.finish === 'timber').id);
    ok('the client can change a door’s finish', await c.evaluate(i => likuloka.commit(d => likuloka.ops.updateOpening(d, i, { finish: 'steel' }), 'Steel'), door));
    ok('the client saves to the cloud, through the server’s check', await c.evaluate(() => likuloka.save()));
    cs = await state(c);
    ok('after saving, the client’s copy is the saved one', !cs.project.unsaved);

    // A changed editor that skips its own check is refused by the server.
    const tampered = await c.evaluate(i => likuloka.cloud.sendSceneUnchecked(likuloka.ops.offsetWall(likuloka.getDoc(), i, 1)).then(() => 'saved', e => e.message), wallId);
    ok('the server refuses a client’s scene that moves a wall', /client view/.test(tampered), tampered);
    const resized = await c.evaluate(i => likuloka.cloud.sendSceneUnchecked(likuloka.ops.updateOpening(likuloka.getDoc(), i, { width: 1.7 })).then(() => 'saved', e => e.message), door);
    ok('the server refuses a custom size from a client', /catalogue/.test(resized), resized);
    const allowed = await c.evaluate(i => likuloka.cloud.sendSceneUnchecked(likuloka.ops.updateOpening(likuloka.getDoc(), i, { state: 'open' })).then(v => v, e => e.message), door);
    ok('the server accepts a change a client may make', typeof allowed === 'number' && allowed > 2, allowed);
    await c.evaluate(() => likuloka.cloud.open(likuloka.getState().project.id));
    cs = await state(c);

    // ---- the designer sees it -----------------------------------------------------------------
    await until(d, () => !!document.querySelector('[data-notice="remote"]'));
    ok('the designer is told the client saved', (await d.locator('[data-notice="remote"]').textContent()).includes('Carl Client saved a newer version'));
    // A save from the older copy is refused rather than overwriting the client's change.
    await d.evaluate(() => likuloka.commit(doc => likuloka.ops.renameProject(doc, 'Beach house'), 'Rename'));
    ok('a save from an out-of-date copy is refused, saying who saved', !(await d.evaluate(() => likuloka.save())) && /Carl Client saved this project after you opened it/.test((await state(d)).error), (await state(d)).error);
    await d.locator('[data-action="reload"]').click();
    await until(d, i => likuloka.getDoc().nodes[i]?.finish === 'steel' && likuloka.getDoc().nodes[i]?.state === 'open', door);
    ok('Reload brings in the client’s changes', true);
    ok('the designer still has the designer view', (await d.evaluate(() => likuloka.role())).kind === 'designer');

    // ---- versions and sign-off --------------------------------------------------------------------
    await menu(d, 'versions');
    const vd = d.locator('dialog[aria-labelledby="versions-title"]');
    await vd.getByLabel('Your name').fill('Dana Designer');
    await vd.getByLabel('Version note').fill('Steel front door');
    await vd.locator('[data-action="save-version"]').click();
    await until(d, () => document.querySelectorAll('.versions li').length === 1);
    ok('the designer saves a version to the cloud', (await d.locator('.versions li').first().textContent()).includes('Steel front door'));
    await vd.getByRole('button', { name: 'Close' }).click();

    await menu(c, 'versions');
    const vc = c.locator('dialog[aria-labelledby="versions-title"]');
    await until(c, () => document.querySelectorAll('.versions li').length === 1);
    ok('the client sees the version', (await c.locator('.versions li').first().textContent()).includes('Steel front door'));
    // A client's version is the project as saved: unsaved changes are saved, through the check, first.
    await c.evaluate(i => likuloka.commit(d => likuloka.ops.updateOpening(d, i, { state: 'closed' }), 'Close'), door);
    await vc.getByLabel('Your name').fill('Carl Client');
    await vc.getByLabel('Version note').fill('Door shut');
    await vc.locator('[data-action="save-version"]').click();
    await until(c, () => document.querySelectorAll('.versions li').length === 2);
    ok('a client saves a version, saving the project first', (await c.locator('.versions li').first().textContent()).includes('Door shut') && !(await state(c)).project.unsaved);
    await c.locator('.versions li[data-version="1"] [data-action="approve"]').click();
    await vc.locator('.approve input[type="checkbox"]').check();
    await vc.locator('[data-action="confirm-approve"]').click();
    await until(c, () => !!document.querySelector('.versions [data-approval]'));
    ok('the client approves it', (await c.locator('.versions [data-approval]').textContent()).includes('Approved by Carl Client'));
    ok('the client cannot restore or delete versions', (await c.locator('.versions [data-action="restore"]').count()) === 0 && (await c.locator('.versions [data-action="delete-version"]').count()) === 0);
    await vc.getByRole('button', { name: 'Close' }).click();

    await menu(d, 'versions');
    await until(d, () => !!document.querySelector('.versions [data-approval]'));
    ok('the designer sees the approval', (await d.locator('.versions [data-approval]').textContent()).includes('Carl Client'));
    ok('an approved version cannot be deleted', (await d.locator('.versions li[data-approved="true"] [data-action="delete-version"]').count()) === 0);
    await d.locator('dialog[aria-labelledby="versions-title"]').getByRole('button', { name: 'Close' }).click();

    // ---- members ---------------------------------------------------------------------------------
    const people = await d.evaluate(() => likuloka.cloud.members());
    ok('the members are the owner and the client', people.map(p => `${p.name}:${p.role}`).join() === 'Dana Designer:owner,Carl Client:client', people);
    const carlUid = people.find(p => p.role === 'client').uid;
    await d.evaluate(u => likuloka.cloud.removeMember(u), carlUid);
    ok('a removed client can no longer open the project', !(await c.evaluate(i => likuloka.cloud.open(i), projectId)) && !!(await state(c)).error);

    // ---- reload keeps a cloud project ------------------------------------------------------------
    await d.waitForTimeout(600);
    await d.reload();
    await d.waitForFunction(() => window.likuloka && likuloka.cloud.state().status === 'signed-in', null, { timeout: 60000 });
    const after = await state(d);
    ok('after a reload the cloud project is still open and saved', after.project.id === projectId && !after.project.unsaved, after.project);
    // The client saved since; a fresh copy saves again.
    await d.evaluate(() => likuloka.cloud.open(likuloka.getState().project.id));
    await d.evaluate(() => likuloka.commit(doc => likuloka.ops.renameProject(doc, 'Beach house v2'), 'Rename'));
    ok('saving it again works', await d.evaluate(() => likuloka.save()), (await state(d)).error);

    ok('no page errors', dana.errors.length === 0 && carl.errors.length === 0, [...dana.errors, ...carl.errors].slice(0, 5));
  } catch (e) {
    ok('the run finished', false, String(e && e.stack || e));
  }
  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
