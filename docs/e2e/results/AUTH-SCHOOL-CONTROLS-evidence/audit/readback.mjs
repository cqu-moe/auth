import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';

const repo=resolve(process.argv[2] || '.');
const tickets=dirname(repo);
const out=join(repo,'.e2e/control-review/readback');
await mkdir(out,{recursive:true});
const {checkSchoolControl}=await import(pathToFileURL(join(repo,'e2e/school/control-evidence.mjs')));
const base='45ddb371495974dcfc86dbabb2c340183cfc7988';
const oldSource=execFileSync('git',['show',`${base}:e2e/school/self-check.mjs`],{cwd:repo,encoding:'utf8'});
const oldBody=oldSource.slice(oldSource.indexOf("assert.equal(negative.meta.cleanup"),oldSource.indexOf('const empty='));
assert.ok(oldBody.includes('countScreenshots') && oldBody.includes('summary.failed'));
const legacy=new (Object.getPrototypeOf(async function(){}).constructor)('negative','assert','readFile','readdir','join',oldBody);
const records=[];
const sources=[];
async function read(dir,name) {return JSON.parse(await readFile(join(dir,name),'utf8'));}
async function preserve(source,dest) {
  await mkdir(dest,{recursive:true});
  for(const name of ['report.json','runtime.json','runner.log']) {
    try {await cp(join(source,name),join(dest,name));} catch(error) {if(error.code!=='ENOENT') throw error;}
  }
  async function visit(dir) {
    for(const e of await readdir(dir,{withFileTypes:true})) {
      const p=join(dir,e.name);
      if(e.isDirectory()) await visit(p);
      else if(e.name.endsWith('.png')) {
        const target=join(dest,relative(source,p));await mkdir(dirname(target),{recursive:true});await cp(p,target);
      }
    }
  }
  await visit(source);
  for(const name of ['runtime.json','report.json','runner.log']) {
    try {
      const original=await readFile(join(source,name)),copy=await readFile(join(dest,name));
      assert.deepEqual(copy,original);
      sources.push({source:join(source,name),copy:relative(out,join(dest,name)),bytes:copy.length,sha256:createHash('sha256').update(copy).digest('hex')});
    } catch(error) {if(error.code!=='ENOENT') throw error;}
  }
}
const foreign=join(out,'actual-unrelated');
await preserve(join(tickets,'AUTH-04/.e2e/oauth-negative-1792079417393/assertion-mobile/mobile/1-d0d928b0d053'),join(foreign,'mobile'));
const foreignMeta=await read(join(foreign,'mobile'),'runtime.json');
assert.equal(foreignMeta.runnerExitCode,1);assert.equal(foreignMeta.result,'failed');
await legacy({dir:foreign,meta:foreignMeta},assert,readFile,readdir,join);
let rejected;
try {await checkSchoolControl('assertion',{dir:join(foreign,'mobile'),meta:foreignMeta});}
catch(error) {rejected=error.message;}
assert.match(rejected,/Unexpected selected school test/);
records.push({case:'unmodified real OAuth failure at school receipt boundary',legacyAccepted:true,newRejected:true,reason:rejected});

for(const [label,source] of [
  ['historical-local','AUTH-03/.e2e/school-negative-1792068166920'],
  ['historical-Linux-CI','AUTH-03-CI/.e2e/ci-38750075601-school/school-negative-1792075483794'],
]) {
  for(const name of ['assertion','zero','pin']) {
    const dir=join(out,label,name,'mobile');await preserve(join(tickets,source,name,'mobile'),dir);
    await checkSchoolControl(name,{dir,meta:await read(dir,'runtime.json')});
    records.push({case:`${label}/${name}`,accepted:true});
  }
}

// Explicit receipt-corruption controls, separate from the unmodified real proof.
const good=join(out,'historical-local/assertion/mobile');
for(const [name,mutate,pattern] of [
  ['wrong-cause',({report})=>{report.run.results.find(x=>x.selected).attempts[0].error.message='unrelated navigation failure';},/故意错误的学校绑定入口/],
  ['wrong-code',({report})=>{report.run.results.find(x=>x.selected).attempts[0].error.code='ENGINE_FAILURE';},/ASSERTION_FAILED/],
  ['wrong-observation',({report})=>{report.run.results.find(x=>x.selected).attempts[0].error.details.observed='no node';},/unrelated reason/],
  ['run-error',({report})=>{report.run.errors.push({message:'unexpected transport failure'});},/framework run error/],
  ['secondary-error',({report})=>{report.run.results.find(x=>x.selected).attempts[0].secondaryErrors.push({phase:'body',message:'unexpected unawaited step'});},/secondary error/],
  ['attempt-cleanup',({report})=>{report.run.results.find(x=>x.selected).attempts[0].cleanup='failed';},/cleanup failed/],
  ['runtime-cleanup',({meta})=>{meta.cleanup='failed';},/passed/],
  ['artifact-error',({meta})=>{meta.artifactError='unrelated artifact failure';},/artifact error/],
]) {
  const dir=join(out,'derived-rejections',name,'mobile');await mkdir(dir,{recursive:true});
  const report=await read(good,'report.json'),meta=await read(good,'runtime.json');mutate({report,meta});
  await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');
  await assert.rejects(checkSchoolControl('assertion',{dir,meta}),pattern);
  records.push({case:`derived/${name}`,rejected:true});
}
const zeroDir=join(out,'derived-rejections/zero/mobile');await mkdir(zeroDir,{recursive:true});
const zeroMeta=await read(join(out,'historical-local/zero/mobile'),'runtime.json');
await writeFile(join(zeroDir,'runner.log'),'ERROR configuration error INVALID_CONFIG (collection)\nTests no tests executed\nErrors 1 error\n');
await assert.rejects(checkSchoolControl('zero',{dir:zeroDir,meta:zeroMeta}),/unrelated reason/);
records.push({case:'derived/zero-unrelated-collection-error',rejected:true});
const pinMeta=await read(join(out,'historical-local/pin/mobile'),'runtime.json');
pinMeta.failure.message='Docker daemon unavailable';
await assert.rejects(checkSchoolControl('pin',{dir:out,meta:pinMeta}),/pinned dependency/);
records.push({case:'derived/pin-unrelated-startup-error',rejected:true});
await writeFile(join(out,'readback.json'),JSON.stringify({base,result:'passed',records,sources},null,2)+'\n');
console.log(JSON.stringify({result:'passed',checks:records.length,unmodifiedSourceFiles:sources.length,evidence:out}));
