import { callOk } from '../src/bridge.ts';
const [x, z, radius] = process.argv.slice(2).map(Number);
const r: any = await callOk('get_buildings', { x, z, radius }, 30);
for (const b of r.buildings ?? []) console.log(b.index, b.version, b.prefab, Math.round(b.position.x), Math.round(b.position.z));
