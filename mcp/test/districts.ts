// LIVE helper: draws rectangular districts and switches district policies on in them.
//   node test/districts.ts '<json: [{box:[x0,x1,z0,z1], policies:[{name, value?}]}]>'
import { call, callOk, waitOperation } from '../src/bridge.ts';
const list = JSON.parse(process.argv[2]); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
for (const d of list) {
  const [x0, x1, z0, z1] = d.box; const before = new Set(((await callOk('get_district_atlas', { layer: 'districts', limit: 100 }, 60)).items ?? []).filter((x: any) => x.index).map((x: any) => x.index));
  let r: any = null; for (let t = 0; t < 8; t++) { const o = await call('create_district', { polygon: [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }], apply: true }, 20); if (!o.ok) { r = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch|wait_for/.test(r.error)) { await wait(3000); continue; } break; } r = await waitOperation(o.result.id, 60); break; }
  if (r?.status !== 'complete') { console.log(JSON.stringify({ box: d.box, district: r?.status, error: String(r?.error ?? '').slice(0, 120) })); continue; }
  await wait(2500); const made = ((await callOk('get_district_atlas', { layer: 'districts', limit: 100 }, 60)).items ?? []).find((x: any) => x.index && !before.has(x.index)); if (!made) { console.log(JSON.stringify({ box: d.box, district: 'created but not found' })); continue; }
  const set: string[] = []; for (const p of d.policies ?? []) { const s = await callOk('set_policy', { scope: 'district', index: made.index, version: made.version, name: p.name, active: true, ...(p.value !== undefined ? { value: p.value } : {}) }, 20).catch((e: any) => ({ err: String(e).slice(0, 80) })); set.push(`${p.name}${p.value !== undefined ? ' ' + p.value : ''}: ${(s as any).ok ? 'on' : (s as any).err}`); }
  console.log(JSON.stringify({ name: made.name, box: d.box, policies: set }));
}
