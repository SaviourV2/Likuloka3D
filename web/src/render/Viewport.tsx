'use client';
/**
 * The 3D view. The renderer is three.js's WebGPURenderer, which uses WebGPU
 * where the browser has it and falls back to WebGL 2 by itself.
 *
 * Frames are drawn on demand: only when the document, the view or the camera
 * changes, while levels are still easing into place, or while a selected
 * zone pulses. Each frame first runs the ECS systems over the dirty set.
 */
import { useEffect, useLayoutEffect } from 'react';
import { Canvas, events, extend, useFrame, useThree, type ThreeToJSXElements } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { color, float, mix, screenUV, smoothstep } from 'three/tsl';
import { world } from '@/ecs/world';
import { CUT, cutHeight, materials, motion } from '@/ecs/materials';
import { diff } from '@/scene/ops';
import { editor, select } from '@/scene/store';
import type { SceneDoc } from '@/scene/types';
import { attachWallTool, rig } from './interact';
import { SceneRoot } from './nodes';
import { Labels } from './Labels';

declare module '@react-three/fiber' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
extend(THREE as unknown as Parameters<typeof extend>[0]);

export const renderInfo = { backend: 'starting' as 'starting' | 'WebGPU' | 'WebGL 2' };

/** Keeps the ECS in step with the store and draws a frame when something changed. */
function Systems() {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => { world.reducedMotion = media.matches; motion.value = media.matches ? 0 : 1; invalidate(); };
    apply();
    media.addEventListener('change', apply);
    cutHeight.value = editor.getState().cut ? CUT : 1000;
    const unsub = editor.subscribe((s, prev) => {
      if (s.doc !== prev.doc) world.markDirty(diff(prev.doc, s.doc));
      if (s.views !== prev.views) world.markDirty([]);
      if (s.cut !== prev.cut) cutHeight.value = s.cut ? CUT : 1000;
      invalidate();
    });
    return () => { unsub(); media.removeEventListener('change', apply); };
  }, [invalidate]);

  useFrame((_, dt) => {
    const s = editor.getState();
    world.step(s.doc, s.views, s.selection, s.cut, Math.min(dt, 0.1));
    let animating = false;
    for (const l of world.levels.values()) if (l.y !== l.target) { animating = true; break; }
    // A selection glows from the shader's clock, so it needs frames while selected.
    const pulsing = !world.reducedMotion && !!s.selection;
    // Orbit and zoom ease to a stop: keep drawing while they do.
    const easing = !!rig.controls?.enableDamping && rig.controls.update(Math.min(dt, 0.1));
    if (animating || pulsing || easing) invalidate();
  }, -1);
  return null;
}

/** The camera rig: orbit controls, the wall tool's listeners and framing. */
function Rig() {
  const { camera, gl, invalidate } = useThree();
  useLayoutEffect(() => {
    const dom = gl.domElement as HTMLElement;
    const controls = new OrbitControls(camera, dom);
    // Orbit, pan and zoom glide to a stop, and zoom heads for the pointer; without inertia for reduced motion.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.enableDamping = !reduced;
    controls.dampingFactor = 0.075;
    controls.zoomToCursor = true;
    controls.zoomSpeed = 0.9;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 2;
    controls.maxDistance = 200;
    controls.addEventListener('change', () => invalidate());
    rig.camera = camera;
    rig.dom = dom;
    rig.controls = controls;
    rig.invalidate = invalidate;
    frame(editor.getState().doc);
    const detach = attachWallTool(dom);
    // The view says when something is being dragged (styles glow the frame).
    const holder = dom.closest('.viewport') as HTMLElement | null;
    const unsub = editor.subscribe(s => {
      const dragging = s.interaction.kind === 'dragging';
      if (holder && holder.dataset.dragging !== String(dragging)) holder.dataset.dragging = String(dragging);
      if (dragging) dom.style.cursor = 'grabbing';
    });
    return () => { detach(); unsub(); controls.dispose(); rig.controls = null; };
  }, [camera, gl, invalidate]);

  useEffect(() => {
    const be = (gl as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    renderInfo.backend = be?.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
    document.documentElement.dataset.backend = renderInfo.backend;
  }, [gl]);
  return null;
}

/** Points the camera at every building. */
export function frame(doc: SceneDoc) {
  const box = new THREE.Box3();
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'wall' && n.type !== 'slab') continue;
    const level = doc.nodes[n.parent];
    const building = level ? doc.nodes[level.parent!] : undefined;
    const ox = building?.type === 'building' ? building.origin[0] : 0;
    const oz = building?.type === 'building' ? building.origin[1] : 0;
    const y = level?.type === 'level' ? level.elevation + level.height : 3;
    const pts = n.type === 'wall' ? [n.a, n.b] : n.points;
    for (const p of pts) box.expandByPoint(new THREE.Vector3(p[0] + ox, y, p[1] + oz)).expandByPoint(new THREE.Vector3(p[0] + ox, 0, p[1] + oz));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
  fit(box, 4);
}

/** Points the camera at one node, as it is drawn now: a door, a wall, a level. */
export function focus(id: string) {
  const object = world.entities.get(id)?.object;
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object);
  if (!box.isEmpty()) fit(box, 1.6);
}

function fit(box: THREE.Box3, minRadius: number) {
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(minRadius, box.getBoundingSphere(new THREE.Sphere()).radius);
  // Fit the bounding sphere in the narrower of the two fields of view.
  const cam = rig.camera as THREE.PerspectiveCamera;
  const vfov = THREE.MathUtils.degToRad(cam.fov ?? 42);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (cam.aspect || 1));
  const dist = radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.02;
  const dir = new THREE.Vector3(0.55, 0.7, 0.75).normalize();
  rig.camera.position.copy(center).addScaledVector(dir, dist);
  rig.controls?.target.copy(center);
  rig.controls?.update();
  rig.invalidate();
}

function Ground() {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.27, 0]} material={materials.ground} receiveShadow
        onClick={e => { if (e.delta < 4 && editor.getState().tool === 'select') select(null); }}>
        <planeGeometry args={[400, 400]} />
      </mesh>
      <gridHelper args={[160, 160, '#2f6bff', '#12223d']} position={[0, -0.265, 0]} />
      <gridHelper args={[160, 32, '#2f6bff', '#1c3a6b']} position={[0, -0.262, 0]} />
    </>
  );
}

/** A night sky: a gradient from deep cobalt to black, drawn by the GPU, and fog into the distance. */
function Sky() {
  const scene = useThree(s => s.scene) as unknown as THREE.Scene;
  useLayoutEffect(() => {
    scene.backgroundNode = mix(color('#0c1a3a'), color('#020309'), smoothstep(float(0), float(0.85), screenUV.y));
    scene.fog = new THREE.Fog('#03050b', 55, 170);
    return () => { scene.backgroundNode = null; scene.fog = null; };
  }, [scene]);
  return null;
}

export default function Viewport() {
  return (
    <Canvas
      className="viewport"
      frameloop="demand"
      shadows
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.1, far: 1000, position: [18, 16, 20] }}
      gl={async props => {
        const renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: true } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
        await renderer.init();
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        return renderer as unknown as THREE.WebGPURenderer;
      }}
      // Handles are drawn on top of everything, so they also win every hit test.
      events={store => ({
        ...events(store),
        filter: items => [...items].sort((p, q) => Number(!!q.object.userData.handle) - Number(!!p.object.userData.handle) || p.distance - q.distance),
      })}
    >
      <Sky />
      <hemisphereLight args={['#cfe9ff', '#05070d', 1.35]} />
      <directionalLight position={[-18, 12, -16]} intensity={1.1} color="#6fd0ff" />
      <directionalLight position={[14, 22, 10]} intensity={2.2} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-30} shadow-camera-right={30}
        shadow-camera-top={30} shadow-camera-bottom={-30} shadow-bias={-0.0005} />
      <Ground />
      <SceneRoot />
      <Systems />
      <Rig />
      <Labels />
    </Canvas>
  );
}
