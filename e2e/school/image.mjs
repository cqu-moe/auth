import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';

export function browserBase() {
  const hash=createHash('sha256');
  for(const name of readdirSync('container').filter(name=>(name.endsWith('.py')&&!name.startsWith('test_'))||['Dockerfile','requirements.txt'].includes(name)).sort()) {
    hash.update(name);hash.update('\0');hash.update(readFileSync(`container/${name}`));
  }
  return `auth-school-browser:${hash.digest('hex').slice(0,16)}`;
}
