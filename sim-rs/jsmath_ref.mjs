// x, Math.exp(x), Math.tanh(x) as raw f64 bits, one line each
import { writeFileSync } from 'node:fs';
const buf = new DataView(new ArrayBuffer(8));
const hex = (v) => { buf.setFloat64(0, v); return buf.getBigUint64(0).toString(16).padStart(16, '0'); };
let s = 1; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const xs = [0, -0, 1, -1, 0.5, 22, -22, 709.7, -745, 1e-30, -1e-10, 0.34657, 1.03972, 3.7e-9];
for (let i = 0; i < 300000; i++) xs.push((rnd() - 0.5) * 60);
for (let i = 0; i < 100000; i++) xs.push((rnd() - 0.5) * 4);
for (let i = 0; i < 50000; i++) xs.push((rnd() - 0.5) * Math.pow(2, -20 - Math.floor(rnd() * 40)));
for (let i = 0; i < 50000; i++) xs.push(-rnd() * 40);
writeFileSync(process.argv[2], xs.map((x) => `${hex(x)} ${hex(Math.exp(x))} ${hex(Math.tanh(x))}`).join('\n') + '\n');
console.log('n', xs.length, process.version);
