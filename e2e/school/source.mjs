import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

export function sourceFingerprint() {
  const paths=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0');
  const hash=createHash('sha256');
  for(const path of [...new Set(paths)].filter(path=>/^(src\/|shared\/|container\/|frontend\/|e2e\/|scripts\/|\.github\/|package.*\.json$|e2e.*\.ts$|wrangler\.|tsconfig\.|\.dockerignore$|\.gitignore$)/.test(path)).sort()) {
    hash.update(path);hash.update('\0');hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}
