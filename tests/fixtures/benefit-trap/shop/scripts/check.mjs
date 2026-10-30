// The shop's rules (DECISIONS.md ADR-001 and ADR-003), checked over the source of every area:
// money is formatted from its integer minor units, never through floating point, and the backend
// and the frontend never import each other's code. Run it from the shop's folder:
//   node scripts/check.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());
const FLOAT = [
  [/\.toFixed\s*\(/, 'toFixed'],
  [/\bparseFloat\s*\(/, 'parseFloat'],
  [/\bIntl\s*\.\s*NumberFormat\b/, 'Intl.NumberFormat'],
  [/\.toLocaleString\s*\(/, 'toLocaleString'],
];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function files(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|mts|js|mjs)$/.test(n) ? [p] : [];
  });
}

const broken = [];
let checked = 0;
for (const area of ['shared', 'backend', 'frontend']) {
  for (const file of files(path.join(root, area, 'src'))) {
    checked += 1;
    const rel = path.relative(root, file).split(path.sep).join('/');
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const [re, name] of FLOAT)
          if (re.test(line)) broken.push(`${rel}:${i + 1} uses ${name} (ADR-001: money never through floating point)`);
        for (const m of line.matchAll(IMPORT)) {
          const target = path.relative(root, path.resolve(path.dirname(file), m[1])).split(path.sep).join('/');
          const other = area === 'backend' ? 'frontend' : area === 'frontend' ? 'backend' : null;
          if (m[1].startsWith('.') && other && target.startsWith(`${other}/`))
            broken.push(`${rel}:${i + 1} imports ${other} code (ADR-003: neither side imports the other)`);
        }
      });
  }
}
for (const b of broken) console.log(b);
if (broken.length) {
  console.log(`fail: ${broken.length} broken, first ${broken[0]}`);
  process.exit(1);
}
console.log(`ok: the shop's rules hold in ${checked} source files`);
