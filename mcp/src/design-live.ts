// Urban design audit, live part: reads every road, highway and rail edge on owned land from the game
// (one read per owned tile) and runs the pure audit (design.ts). Zero model tokens; about 5 seconds.
import { callOk } from './bridge.ts';
import { audit, auditLine, worstDefects } from './design.ts';
import type { AuditEdge, Defect } from './design.ts';

const id = (n: any) => Number(n?.index ?? n);

export async function readAuditEdges(): Promise<AuditEdge[]> {
  const tiles = ((await callOk('get_tiles', {}, 30)).tiles ?? []).filter((t: any) => t.purchased);
  const edges = new Map<number, AuditEdge>();
  for (const t of tiles) {
    const xs = t.polygon.map((p: any) => Number(p.x)), zs = t.polygon.map((p: any) => Number(p.z));
    const x = (Math.min(...xs) + Math.max(...xs)) / 2, z = (Math.min(...zs) + Math.max(...zs)) / 2;
    const r = await callOk('get_network_edges', { x, z, radius: 470 }, 40);
    for (const e of r.edges ?? []) {
      if (edges.has(e.index) || !/Road|Highway|Train Track/.test(String(e.prefab))) continue;
      const c = e.curve ?? []; if (c.length < 2) continue; const a = c[0], d = c[c.length - 1];
      edges.set(e.index, { index: e.index, prefab: String(e.prefab), length: Number(e.length ?? Math.hypot(d.x - a.x, d.z - a.z)), startNode: id(e.startNode), endNode: id(e.endNode), a: { x: a.x, y: a.y, z: a.z }, d: { x: d.x, y: d.y, z: d.z } });
    }
  }
  return [...edges.values()];
}

/** The audit as the loop and the report use it: counts by kind, one line, and the defects to fix first. */
export async function designAudit(top = 10): Promise<{ ok: boolean; edges: number; total: number; counts: Record<string, number>; line: string; worst: Defect[]; ms: number }> {
  const t0 = Date.now(); const edges = await readAuditEdges(); const res = audit({ edges });
  return { ok: true, edges: edges.length, total: res.total, counts: res.counts, line: auditLine(res.counts), worst: worstDefects(res.defects, top), ms: Date.now() - t0 };
}
