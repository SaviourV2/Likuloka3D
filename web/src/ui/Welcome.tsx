'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { drawing } from './welcomeDrawing';

/**
 * The welcome page's hero. Its motion follows likuloka.com's hero: the two title
 * lines rise out of a mask, the text, buttons and facts fade up in a stagger, and
 * the drawing drifts slower than the page. All of it is CSS except the drift.
 */
export default function Welcome() {
  const art = useRef<SVGSVGElement>(null);

  // The drawing moves at 0.18 of the scroll, one write per frame, and not at all with reduced motion.
  useEffect(() => {
    const el = art.current;
    if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = reduce.matches ? 0 : scrollY;
      if (y < innerHeight * 1.2) el.style.setProperty('--par', `${(y * 0.18).toFixed(1)}px`);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    addEventListener('scroll', onScroll, { passive: true });
    reduce.addEventListener('change', update);
    update();
    return () => { removeEventListener('scroll', onScroll); reduce.removeEventListener('change', update); cancelAnimationFrame(frame); };
  }, []);

  return (
    <main className="welcome">
      <section className="hero">
        <div className="wrap">
          <div>
            <div className="kicker"><b>BUILDING EDITOR IN THE BROWSER</b><span /></div>
            <h1 className="display" aria-label="Likuloka 3D">
              <span className="ln" aria-hidden="true"><span>Liku</span></span>
              <span className="ln" aria-hidden="true"><span>Loka 3D</span></span>
            </h1>
            <p className="lede">
              Draw buildings, levels, walls, doors and windows straight in 3D. Every size is kept to the
              millimetre and every check runs as you work, so the plans, the schedule and the files for
              CAD and BIM come out of the same model.
            </p>
            <div className="ctas">
              <Link className="cta" href="/">Open the editor</Link>
              <a className="cta ghost" href="https://github.com/SaviourV2/Likuloka3D/tree/main/web#readme">What it does</a>
            </div>
            <div className="facts">
              <div><strong>To the mm</strong><span>doors and windows sized by their frames</span></div>
              <div><strong>Plans, DXF and IFC</strong><span>drawings for AutoCAD, models for BIM tools</span></div>
              <div><strong>No install</strong><span>a static site that runs in any modern browser</span></div>
            </div>
          </div>
          <figure>
            <svg ref={art} viewBox={drawing.viewBox} width={drawing.width} height={drawing.height} role="img" aria-label="Axonometric line drawing of a two-storey house">
              <path className="d-dashed" d={drawing.dashed} />
              <path className="d-hidden" d={drawing.hidden} />
              <path className="d-thin" d={drawing.thin} />
              <path className="d-strong" d={drawing.strong} />
              <text x={drawing.label.x} y={drawing.label.y} textAnchor="middle">{drawing.label.text}</text>
            </svg>
          </figure>
        </div>
      </section>
    </main>
  );
}
