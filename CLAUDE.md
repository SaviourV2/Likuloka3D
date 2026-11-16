# Likuloka3D

Roomlines, a floor plan editor with a 3D view. `README.md` documents the plan format, the state machines and the `window.roomlines` API.

## Working here

- Edit `app.html` only. `index.html` is generated from it by `./build.sh`; never edit it directly, and rebuild before committing.
- After any change, run the tests and keep them green:

  ```bash
  ./build.sh && cd tests && npm install && npm test
  ```

- The page is one file with no bundler. Libraries load from a CDN as classic scripts, pinned to an exact version. Add a library only if it ships a browser (UMD) build.
- Flows with ordered steps or interruptible work are XState machines in the "state machines" section of `app.html`. Add a state or a machine for new behaviour of that kind; do not add a boolean flag. Plain settings stay in `state`.
- Change rooms through `addRoom`, `updateRoom` and `removeRoom`. They validate input and are what `window.roomlines` exposes.
- To check behaviour in a browser, read `roomlines.getState()` or the `data-tool`, `data-drawing`, `data-describe` and `data-read` attributes on `.wrap` instead of inferring state from the DOM.
- Glass (`.glass`) is for controls that float above the drawing. Never put it on the plan, the 3D view or anything inside the tools panel; controls inside glass use the `--field` fills instead.
- Nothing floating may cover a room, a handle or the uploaded drawing. The tests check this at 1400×900 and 400×800.
- Animate discrete changes only, through `morph()` or CSS, and never during a drag. Everything must still work with reduced motion, where changes apply at once.
- Visibility is the `hidden` attribute. Animate how something enters; never hide it with opacity alone, because the tests and assistive tools read `hidden`.
- All lengths are metres on a 0.25 m grid. `x` runs left to right and `y` top to bottom.
