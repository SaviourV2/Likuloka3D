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
- All lengths are metres. `x` runs left to right and `y` top to bottom. Rectangles stay on the 0.25 m grid; the corners of a shaped room may sit anywhere, rounded to the millimetre.
- Geometry works on edges, never on north/south/east/west. Use `outline(r)`, `edgesOf(r)` and `onWall(piece, t)`; do not read a wall's direction from a room's `x, y, w, h`, which is only a bounding box once the room has `points`.
- The four built-in layouts must keep producing the same walls, openings and furniture. When changing `analyze`, `put` or a recipe on purpose, say so in the commit.

## The web editor (`web/`)

`web/` is a separate app: Likuloka 3D, a Next.js editor with React Three Fiber, WebGPU and zustand. The rules above are for Roomlines (`app.html`). In `web/` these apply instead; `web/README.md` documents it.

- After any change in `web/`, run its tests and keep them green:

  ```bash
  cd web && npm install && npm test
  ```

  After a change to the rules, `src/scene/cloud.ts`, versions or anything a client can do, also run `npm run test:rules` and `npm run test:cloud` (they start the Firebase emulators, which need Java).

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
- The look is the night edition of likuloka.com: one dark theme, black with light-blue `--accent` and cobalt `--accent-2`, Archivo, JetBrains Mono for figures, `--crit` for errors and destructive actions, `--warn` for warnings. Printed and exported drawings stay black on white.
- Glass in `web/` is for what floats above the 3D view: the bar (`.glass`), its menu, the labels and the dialogs. The panels beside the view are translucent, not glass. Never put `filter`, `opacity`, `mask` or `view-transition-name` on a parent of a glass element; the menu sits inside the bar, so it stays nearly solid. Everything must turn solid with `prefers-reduced-transparency`.
- The ground shows the grid the editor snaps to: a line every 0.25 m, brighter ones every 1 m and 5 m. Keep the 0.25 m lines; people line their source drawing up against them.
- Furniture in `web/` is worked out from the rooms by `furnishLevel` (`src/scene/furnish.ts`) and never stored in the document. The same scene must always give the same pieces, so no randomness there. Every piece keeps its box `parts` even when it has `models`: the boxes are drawn when the files in `public/models` are missing. Only add model files whose licence allows redistribution, and record the source in `public/models/README.md`.
- The plot (`doc.plot`) is the land's boundary: corners to the millimetre in the plan coordinates building origins use, not on the grid. It is not a node. Change it through `setPlot` and the other plot operations in `ops.ts`; the `plot` tool and the `dragging-plot` interaction drag its corners. Plot checks warn and never block.
- Motion must stop with reduced motion: camera inertia, the selection pulse (the `motion` uniform) and every CSS animation.
- All lengths are metres. Wall positions are on a 0.25 m grid; door and window sizes are kept to 5 mm (frames are ordered in millimetres) and wall layers to 0.1 mm. Plan `x` is world `x`, plan `y` is world `z`.
- An opening's width and height are the structural opening. Frame sizes come from `frameSize` with the project's fitting gap; catalogue products are given by frame size.
- Products, wall types, check limits and the schedule's columns live in `public/catalogue.json`, read at runtime. Do not hard-code products. The example products are not real ones; never add a manufacturer's real product data to this public repository.
- What a client may change is decided in one place, `clientRefusal` in `src/scene/access.ts`. It is enforced in the store's `commit` and `preview`, and on the server by the `saveScene` Cloud Function (`functions/`), which bundles the same file. It must compare values, not object identity: the server compares two scenes parsed from text. Do not enforce it only by hiding controls. Rebuild the function (`npm run functions:build`) after changing it.
- Cloud features read `cloud.json` at runtime and must keep working when it is absent. Never commit a real `public/cloud.json`. Every Firestore access rule is in `firebase/firestore.rules` and tested in `tests/rules.test.cjs`; change both together.
- Buildability checks warn and never block an edit.
- The inspector shows and takes lengths in whole millimetres, and sets nothing by x and y coordinates: positions are set by dragging. Use the `Mm` field for new lengths.
- The DXF export (`src/scene/dxf.ts`) is R12, at true size in millimetres, on the `A-…` layers listed there. Keep it R12 and keep the layer names: people's CAD layer setups depend on them. Check a changed exporter with ezdxf's audit (`recover.readfile`), not only the tests.
