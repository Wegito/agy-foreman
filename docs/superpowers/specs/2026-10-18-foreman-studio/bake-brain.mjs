// Bakes the MNI152 brain mesh (gzipped MZ3) into two files for the spike:
//   brain-points.bin  Float32 [x, y, z, crest, region] per sampled surface point
//   brain-shell.bin   Uint32 header [nvert, nindex], Float32 verts, Uint32 indices (vertex-clustered)
// Scene axes: x = MNI x (left/right), y = MNI z (up), z = MNI y (front). Units: MNI mm / 75.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [src, outDir] = process.argv.slice(2);
const buf = gunzipSync(readFileSync(src));
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const nface = dv.getUint32(4, true), nvert = dv.getUint32(8, true), nskip = dv.getUint32(12, true);
let o = 16 + nskip;
const F = new Uint32Array(nface * 3);
for (let i = 0; i < F.length; i++, o += 4) F[i] = dv.getInt32(o, true);
const V = new Float32Array(nvert * 3);
for (let i = 0; i < V.length; i++, o += 4) V[i] = dv.getFloat32(o, true);

// MNI mm → scene
const C = [0.1, -16.8, 5]; // bbox centre (x, y, z in MNI)
const S = 1 / 75;
const toScene = (x, y, z) => [(x - C[0]) * S, (z - C[2]) * S, (y - C[1]) * S];

function region(x, y, z) { // MNI mm
  if (Math.abs(x) < 14 && z < -25 && y > -42 && y < -5) return 6;              // brainstem
  if (y < -40 && z < -14) return 5;                                    // cerebellum
  if (Math.abs(x) > 32 && z < 0 && y < 25 && y > -75) return 3;        // temporal
  if (y > 30) return 0;                                                // prefrontal
  if (y > -10 - 0.25 * (z - 20)) return 1;                             // frontal (central sulcus slopes back)
  if (y < -72) return 4;                                               // occipital
  return 2;                                                            // parietal
}

// face areas + normals, orientation check
const area = new Float64Array(nface), N = new Float32Array(nface * 3);
let total = 0, outward = 0;
for (let f = 0; f < nface; f++) {
  const a = F[f*3]*3, b = F[f*3+1]*3, c = F[f*3+2]*3;
  const ux = V[b]-V[a], uy = V[b+1]-V[a+1], uz = V[b+2]-V[a+2];
  const vx = V[c]-V[a], vy = V[c+1]-V[a+1], vz = V[c+2]-V[a+2];
  let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  area[f] = l / 2; total += l / 2;
  nx /= l; ny /= l; nz /= l; N.set([nx, ny, nz], f*3);
  const cx = (V[a]+V[b]+V[c])/3 - C[0], cy = (V[a+1]+V[b+1]+V[c+1])/3 - C[1], cz = (V[a+2]+V[b+2]+V[c+2])/3 - C[2];
  if (nx*cx + ny*cy + nz*cz > 0) outward++;
}
const flip = outward < nface / 2 ? -1 : 1;
console.log({ nface, nvert, flip });

// cumulative area for weighted sampling
const cum = new Float64Array(nface);
let acc = 0; for (let f = 0; f < nface; f++) { acc += area[f]; cum[f] = acc; }
const pick = () => { const r = Math.random() * acc; let lo = 0, hi = nface - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; } return lo; };

const TARGET = 95000, pts = [];
while (pts.length / 5 < TARGET) {
  const f = pick(), a = F[f*3]*3, b = F[f*3+1]*3, c = F[f*3+2]*3;
  let u = Math.random(), v = Math.random(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
  const x = V[a] + u*(V[b]-V[a]) + v*(V[c]-V[a]);
  const y = V[a+1] + u*(V[b+1]-V[a+1]) + v*(V[c+1]-V[a+1]);
  const z = V[a+2] + u*(V[b+2]-V[a+2]) + v*(V[c+2]-V[a+2]);
  const rx = x - C[0], ry = y - C[1], rz = z - C[2], rl = Math.hypot(rx, ry, rz) || 1;
  const crest = Math.max(0, flip * (N[f*3]*rx + N[f*3+1]*ry + N[f*3+2]*rz) / rl);
  if (Math.random() > 0.2 + 0.8 * crest) continue;   // thin out sulcal walls
  pts.push(...toScene(x, y, z), crest, region(x, y, z));
}
writeFileSync(`${outDir}/brain-points.bin`, Buffer.from(new Float32Array(pts).buffer));

// vertex-clustered shell
const CELL = 2.4, map = new Map(), sums = [], remap = new Uint32Array(nvert);
for (let i = 0; i < nvert; i++) {
  const k = `${Math.floor(V[i*3]/CELL)},${Math.floor(V[i*3+1]/CELL)},${Math.floor(V[i*3+2]/CELL)}`;
  let id = map.get(k);
  if (id === undefined) { id = sums.length / 4; map.set(k, id); sums.push(0, 0, 0, 0); }
  sums[id*4] += V[i*3]; sums[id*4+1] += V[i*3+1]; sums[id*4+2] += V[i*3+2]; sums[id*4+3]++;
  remap[i] = id;
}
const nv = sums.length / 4, sv = new Float32Array(nv * 3);
for (let i = 0; i < nv; i++) sv.set(toScene(sums[i*4]/sums[i*4+3], sums[i*4+1]/sums[i*4+3], sums[i*4+2]/sums[i*4+3]), i*3);
const idx = [];
for (let f = 0; f < nface; f++) {
  const a = remap[F[f*3]], b = remap[F[f*3+1]], c = remap[F[f*3+2]];
  if (a === b || b === c || a === c) continue;
  // scene axes swap y/z, which mirrors handedness: swap winding so normals stay outward
  if (flip > 0) idx.push(a, c, b); else idx.push(a, b, c);
}
const head = new Uint32Array([nv, idx.length]);
writeFileSync(`${outDir}/brain-shell.bin`, Buffer.concat([Buffer.from(head.buffer), Buffer.from(sv.buffer), Buffer.from(new Uint32Array(idx).buffer)]));
const counts = new Array(7).fill(0); for (let i = 4; i < pts.length; i += 5) counts[pts[i]]++;
console.log({ points: pts.length / 5, regionCounts: counts, shellVerts: nv, shellTris: idx.length / 3 });
