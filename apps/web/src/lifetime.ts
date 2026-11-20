/**
 * Everything a flight (or the title screen) adds to the page, so it can all be taken away
 * again without reloading the page: the viewer and Google's 3D tiles stay, and with them
 * Google's session (one root tile per session of up to three hours, metered by Cesium ion;
 * a page load used to start a new one every flight and every return to the menu).
 *
 * While a lifetime is open it records, without the classes having to know:
 *  - primitives, ground primitives, entities and post-process stages added to the scene,
 *  - listeners added to the scene's frame events and to the imagery layer collection,
 *  - window, document and canvas event listeners,
 *  - workers started, intervals set.
 * close() removes and destroys those primitives and entities, removes the listeners,
 * terminates the workers and clears the intervals. Work that finishes later through a
 * worker can't come back (the worker is gone); objects created before open() are kept.
 * One lifetime at a time.
 */
import type { Event as CesiumEvent, Viewer } from "cesium";

type Remover = () => void;
type AnyFn = (...a: never[]) => unknown;

export class Lifetime {
  private undo: Remover[] = [];
  private removers: Remover[] = [];
  private workers: Worker[] = [];
  private intervals: number[] = [];
  private prims = new Set<unknown>();
  private groundPrims = new Set<unknown>();
  private ents = new Set<unknown>();
  private stages = new Set<unknown>();
  private extra: Remover[] = [];
  private closed = false;

  constructor(private readonly viewer: Viewer) {
    const scene = viewer.scene;
    // What is there already stays.
    for (let i = 0; i < scene.primitives.length; i++) this.prims.add(scene.primitives.get(i));
    for (let i = 0; i < scene.groundPrimitives.length; i++) this.groundPrims.add(scene.groundPrimitives.get(i));
    for (const e of viewer.entities.values) this.ents.add(e);
    for (let i = 0; i < scene.postProcessStages.length; i++) this.stages.add(scene.postProcessStages.get(i));

    // Cesium events: the scene's frame events and the imagery layers' layerAdded.
    const events: CesiumEvent[] = [scene.preUpdate, scene.postUpdate, scene.preRender, scene.postRender, viewer.imageryLayers.layerAdded];
    for (const ev of events) {
      const orig = ev.addEventListener;
      ev.addEventListener = (listener: AnyFn, scope?: object) => {
        const remove = orig.call(ev, listener as never, scope) as Remover;
        this.removers.push(remove);
        return remove;
      };
      this.undo.push(() => (ev.addEventListener = orig));
    }
    // DOM listeners on window, document and the canvas.
    for (const target of [window, document, viewer.canvas] as EventTarget[]) {
      const orig = target.addEventListener;
      target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
        orig.call(target, type, fn, opts);
        this.removers.push(() => target.removeEventListener(type, fn, opts));
      };
      this.undo.push(() => (target.addEventListener = orig));
    }
    // Workers and intervals.
    const W = window.Worker;
    const workers = this.workers;
    window.Worker = class extends W {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        // Ours only: Cesium starts its shared task workers lazily (from its own folder, or a
        // blob), and they must outlive any flight; so must ours named "page-wide:" (work done once
        // per page and shared by every flight, e.g. the cloud noise).
        const u = String(url);
        if (!u.includes("/cesium/") && !u.startsWith("blob:") && !opts?.name?.startsWith("page-wide:")) workers.push(this);
      }
    };
    this.undo.push(() => (window.Worker = W));
    const si = window.setInterval;
    window.setInterval = ((h: TimerHandler, t?: number, ...a: unknown[]) => {
      const id = si(h, t, ...a);
      this.intervals.push(id);
      return id;
    }) as typeof window.setInterval;
    this.undo.push(() => (window.setInterval = si));
  }

  /** Also run this on close (what the recording can't see: DOM content, imagery layers…). */
  onClose(fn: Remover): void {
    if (this.closed) fn();
    else this.extra.push(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Stops recording: what was added since stays until close(). */
  private stopRecording(): void {
    for (const u of this.undo.splice(0).reverse()) u();
  }

  /** Takes away everything added while open. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRecording();
    for (const r of [...this.extra.splice(0).reverse(), ...this.removers.splice(0)]) {
      try {
        r();
      } catch {
        // already gone
      }
    }
    for (const w of this.workers.splice(0)) w.terminate();
    for (const id of this.intervals.splice(0)) clearInterval(id);
    const scene = this.viewer.scene;
    const drop = (col: typeof scene.primitives, keep: Set<unknown>) => {
      for (let i = col.length - 1; i >= 0; i--) {
        const p = col.get(i);
        if (!keep.has(p)) col.remove(p); // destroys it (destroyPrimitives is on by default)
      }
    };
    drop(scene.primitives, this.prims);
    drop(scene.groundPrimitives, this.groundPrims);
    for (const e of [...this.viewer.entities.values]) if (!this.ents.has(e)) this.viewer.entities.remove(e);
    const pp = scene.postProcessStages;
    for (let i = pp.length - 1; i >= 0; i--) {
      const st = pp.get(i);
      if (!this.stages.has(st)) pp.remove(st);
    }
  }
}
