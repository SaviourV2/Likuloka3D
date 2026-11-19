# Likuloka3D

Roomlines, a floor plan editor with a 3D view. `README.md` documents the plan format, the state machines and the `window.roomlines` API.

## Working here

- Edit `app.html` only. `index.html` is generated from it by `./build.sh`, and `models.js` from `models/*.glb`; never edit either directly, and rebuild before committing.
- After any change, run the tests and keep them green:

  ```bash
  ./build.sh && cd tests && npm install && npm test
  ```

- The page is one file plus `models.js`, with no bundler. Libraries load from a CDN as classic scripts, pinned to an exact version. Add a library only if it ships a browser (UMD) build.
- Flows with ordered steps or interruptible work are XState machines in the "state machines" section of `app.html`. Add a state or a machine for new behaviour of that kind; do not add a boolean flag. Plain settings stay in `state`.
- Change rooms through `addRoom`, `updateRoom` and `removeRoom`. They validate input and are what `window.roomlines` exposes.
- To check behaviour in a browser, read `roomlines.getState()` or the `data-tool`, `data-drawing`, `data-describe`, `data-read` and `data-models` attributes on `.wrap` instead of inferring state from the DOM.
- The look follows likuloka.com: cobalt `--accent`, Archivo, JetBrains Mono for figures. Errors and destructive actions use `--crit`, never the accent. Only colours, fonts and the logo may come from the private `likuloka-web` repository; this repository is public.
- Every furniture piece keeps its box `parts` even when it has `models`: the boxes are what is drawn when the model files are missing. Only add model files whose licence allows redistribution (the current ones are CC0) and record the source in `models/README.md`.
- Finishes are generated in the page. Do not add a manufacturer's tile or paint images; a room's `spec` note is where a real product is recorded.
- Glass (`.glass`) is for controls that float above the drawing. Never put it on the plan, the 3D view or anything inside the tools panel; controls inside glass use the `--field` fills instead.
- Never put `view-transition-name`, `filter`, `opacity`, `mask` or `mix-blend-mode` on a parent of a glass element. Any of them stops the glass from seeing the drawing behind it, so the blur silently does nothing. Put them on the glass element itself.
- Nothing floating may cover a room, a handle or the uploaded drawing. The tests check this at 1400×900 and 400×800.
- Animate discrete changes only, and never during a drag. Use `morph()` only for layout changes (view mode, panel): the browser drops clicks while a view transition runs, so content changes such as loading a plan animate with CSS instead. Everything must still work with reduced motion, where changes apply at once.
- Visibility is the `hidden` attribute. Animate how something enters; never hide it with opacity alone, because the tests and assistive tools read `hidden`.
- All lengths are metres on a 0.25 m grid. `x` runs left to right and `y` top to bottom.

## The web editor (`web/`)

`web/` is a separate app: Likuloka 3D, a Next.js editor with React Three Fiber, WebGPU and zustand. The rules above are for Roomlines (`app.html`). In `web/` these apply instead; `web/README.md` documents it.

- After any change in `web/`, run its tests and keep them green:

  ```bash
  cd web && npm install && npm test
  ```

- It is a static export (`output: 'export'`). Do not add server code, API routes or anything that needs a Node server.
- Packages are installed from npm and pinned to exact versions.
- The scene document is immutable. Change it only through the operations in `src/scene/ops.ts`, called through `commit` or a gesture (`begin`, `preview`, `end`) in `src/scene/store.ts`. Never mutate a node: dirty tracking and undo both depend on a changed node having a new identity.
- Openings are children of walls and measured along them from end `a`. Any operation that moves wall ends must re-anchor the openings in the walls it changes (`reanchor` in `ops.ts`) so they keep their place in the room.
- Components must not subscribe to node data that a system draws (wall ends, outlines, openings). Systems in `src/ecs/world.ts` update those objects; React only mounts and unmounts them.
- Pointer modes are values of `interaction` in the store. Add a value for a new mode; do not add a boolean flag. Plain settings, such as `cut`, are plain values.
- Selection, tools, level modes, `cut` and `measure` are view state and are not undone. The project's name is in the document, so renaming it is undone like any edit.
- Saved projects live in browser storage (`src/scene/projects.ts`). A project is unsaved when `doc !== project.saved`; anything that loads a document must set `saved` to the document the store holds after loading, since loading migrates.
- A new field on a node needs a default in `migrate` in `ops.ts`, so projects saved earlier still open.
- Never read browser storage while rendering: the page is pre-rendered as static HTML, and a difference breaks hydration. Read it in effects or in components that render only once a dialog is open.
- A `useFrame` callback must use a priority of 0 or below: a positive priority takes rendering over from React Three Fiber and the view goes blank.
- The look follows likuloka.com, as above: cobalt `--accent`, Archivo, JetBrains Mono for figures, and `--crit` for errors and destructive actions.
- All lengths are metres on a 0.25 m grid. Plan `x` is world `x`, plan `y` is world `z`.
