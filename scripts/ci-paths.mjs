import { readFileSync } from 'node:fs';

// NUL-delimited git paths preserve filenames containing whitespace/newlines.
const paths = readFileSync(0, 'utf8').split('\0').filter(Boolean);
const code = paths.length === 0 || paths.some(path =>
  !path.endsWith('.md') && (!path.startsWith('docs/') || path.startsWith('docs/api/')));
console.log(`code=${code}`);
