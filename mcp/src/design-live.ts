// Urban design audit, live part: reads every road, highway and rail edge on owned land from the game
// (one read per owned tile) and runs the pure audit (design.ts). Zero model tokens; about 5 seconds.
import { callOk } from './bridge.ts';
import { audit, auditLine, worstDefects, checkRoadPlan } from './design.ts';
import type { AuditEdge, Defect } from './design.ts';

const id = (n: any) => Number(n?.index ?? n);

export async function readAuditEdges(): Promise<AuditEdge[]> {
  const tiles = ((await callOk('get_tiles', {}, 30)).tiles ?? []).filter((t: any) => t.purchased);
  const edges = new Map<number, AuditEdge>();
  for (const t of tiles) {
    const xs = t.polygon.map((p: any) => Number(p.x)), zs = t.polygon.map((p: any) => Number(p.z));
    const x = (Math.min(...xs) + Math.max(...xs)) / 2, z = (Math.min(...zs) + Math.max(...zs)) / 2;
    const r = await callOk('get_network_edges', { x, z, radius: 470 }, 40);
    const flagsKnown = (r.edges ?? []).some((e: any) => e.upgraded !== undefined);   // the reader gives option flags (mod 0.5.1+); a road without the component has no option at all
    for (const e of r.edges ?? []) {
      if (edges.has(e.index) || !/Road|Highway|Train Track/.test(String(e.prefab))) continue;
      const c = e.curve ?? []; if (c.length < 2) continue; const a = c[0], d = c[c.length - 1];
      // Trees or grass on the road (the Beautification flags of its upgrade); unknown when the reader gives no flags.
      const up = e.upgraded !== undefined ? String(e.upgraded) : flagsKnown ? '' : undefined;
      edges.set(e.index, { index: e.index, prefab: String(e.prefab), length: Number(e.length ?? Math.hypot(d.x - a.x, d.z - a.z)), startNode: id(e.startNode), endNode: id(e.endNode), a: { x: a.x, y: a.y, z: a.z }, d: { x: d.x, y: d.y, z: d.z }, ...(up !== undefined && /Road/.test(String(e.prefab)) ? { trees: /Beautification/i.test(up) } : {}) });
    }
  }
  return [...edges.values()];
}

/** The audit as the loop and the report use it: counts by kind, one line, and the defects to fix first. */
export async function designAudit(top = 10): Promise<{ ok: boolean; edges: number; total: number; counts: Record<string, number>; line: string; worst: Defect[]; ms: number }> {
  const t0 = Date.now(); const edges = await readAuditEdges(); const res = audit({ edges });
  return { ok: true, edges: edges.length, total: res.total, counts: res.counts, line: auditLine(res.counts), worst: worstDefects(res.defects, top), ms: Date.now() - t0 };
}

// Plan check for the builders (city.ts link and joining streets): would this straight piece create a design defect?
// The edge list is cached for a minute, so a batch of candidates costs one read.
let cache: { t: number; edges: AuditEdge[] } | null = null;
export async function planRefusal(prefab: string, from: { x: number; z: number }, to: { x: number; z: number }, ignore: string[] = []): Promise<string[]> {
  try {
    if (!cache || Date.now() - cache.t > 60_000) cache = { t: Date.now(), edges: await readAuditEdges() };
    const t = await callOk('sample_terrain', { points: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }] }, 20); const s = t.samples ?? t.points ?? [];
    const y = (i: number) => Number(s[i]?.position?.y ?? 0);
    const r = checkRoadPlan({ prefab, from: { x: from.x, y: y(0), z: from.z }, to: { x: to.x, y: y(1), z: to.z } }, { edges: cache.edges });
    return r.reasons.filter(x => !ignore.includes(x));
  } catch { return []; }   // the check never blocks building when the read fails
}
export const invalidatePlanCache = () => { cache = null; };
