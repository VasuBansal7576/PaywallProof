import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {gitSha,pathSchema,repositorySchema,RepairError} from './model.ts';

const execute=promisify(execFile);
export const REFERENCE_REPAIR_PATHS=[
  'packages/reference/src/index.ts','packages/reference/src/billing.ts','packages/reference/src/store.ts',
  'apps/demo-saas/server.ts','apps/demo-saas/next.config.ts',
  'apps/demo-saas/app/layout.tsx','apps/demo-saas/app/page.tsx','apps/demo-saas/app/styles.css',
  'apps/demo-saas/app/dashboard/page.tsx','apps/demo-saas/app/api/[...path]/route.ts','apps/demo-saas/app/staging/[...path]/route.ts',
];
export const REFERENCE_SUPPORT_PATHS=['packages/reference/src/replay-signature.ts','packages/adapters/src/polar.ts'];
export type CheckoutFile={path:string;bytes:Uint8Array;role:'source'|'support'|'dependency'|'launcher'};
const packageName=z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
const packageSchema=z.object({name:packageName,version:z.string(),dependencies:z.record(z.string(),z.string()).optional(),optionalDependencies:z.record(z.string(),z.string()).optional()});
const metadataSchema=z.object({baseCommit:gitSha,repository:repositorySchema,paths:z.array(pathSchema).min(1).max(100)});
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function beneath(root:string,path:string){const rel=relative(root,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!rel.startsWith(sep);}

/** Reads raw Git blobs only. Never checks out or executes repository files on the host. */
export async function readRepairSource(options:{repositoryRoot:string;baseCommit:string;repository:string;paths?:readonly string[]}) {
  const request=metadataSchema.parse({...options,paths:options.paths??[...REFERENCE_REPAIR_PATHS,...REFERENCE_SUPPORT_PATHS]});
  const foldedPaths=request.paths.map(path=>path.toLowerCase());
  if(new Set(foldedPaths).size!==request.paths.length||foldedPaths.some(path=>foldedPaths.some(other=>other!==path&&other.startsWith(`${path}/`))))throw new RepairError('REPAIR_SCOPE_REJECTED');
  const root=await realpath(options.repositoryRoot);
  const git=async(args:string[])=>execute('git',['--no-pager','--no-replace-objects','-C',root,...args],{encoding:'buffer',maxBuffer:2*1024*1024,timeout:10000});
  const {stdout:remote}=await git(['config','--get','remote.origin.url']);
  if(![`https://github.com/${request.repository}.git`,`https://github.com/${request.repository}`,`git@github.com:${request.repository}.git`].includes(remote.toString('utf8').trim()))throw new RepairError('REPOSITORY_IDENTITY_MISMATCH');
  if((await git(['cat-file','-t',request.baseCommit])).stdout.toString('utf8').trim()!=='commit')throw new RepairError('REPAIR_BASE_NOT_COMMIT');
  const files:CheckoutFile[]=[];
  for(const path of request.paths){
    const {stdout:entry}=await git(['ls-tree','-z',request.baseCommit,'--',path]);
    const entries=entry.toString('utf8').split('\0').filter(Boolean);
    const [header,entryPath]=entries[0]?.split('\t')??[];
    if(entries.length!==1||entryPath!==path||!/^100644 blob [a-f0-9]{40}$/.test(header??''))throw new RepairError('REPAIR_SOURCE_NOT_REGULAR');
    const {stdout:bytes}=await git(['show',`${request.baseCommit}:${path}`]);
    if(bytes.length>1024*1024)throw new RepairError('REPAIR_SOURCE_LIMIT');
    // Candidate publication is UTF-8. Reject source whose decoding changes bytes.
    if(bytes.includes(0)||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new RepairError('REPAIR_SOURCE_ENCODING');
    files.push({path,bytes,role:REFERENCE_SUPPORT_PATHS.includes(path)?'support':'source'});
  }
  return {baseCommit:request.baseCommit,repository:request.repository,files,bindings:files.map(file=>({path:file.path,sha256:sha256(file.bytes),size:file.bytes.length}))};
}

/** Packages only installed runtime dependencies. No package scripts or downloads. */
export async function collectRepairDependencies(repositoryRoot:string,names:readonly string[]=['next','react','react-dom','hono','zod','standardwebhooks','better-sqlite3','typescript','@types/react','@types/node']) {
  const root=await realpath(resolve(repositoryRoot,'node_modules'));
  const files:CheckoutFile[]=[],versions:{name:string;version:string;destination:string}[]=[];
  let total=0;
  const installed=new Map<string,string>();
  const excludedDirectories=new Set(['.git','test','tests','__tests__','docs','examples','coverage','benchmark','benchmarks']);
  async function locate(name:string,from:string):Promise<string> {
    packageName.parse(name);
    let location=from;
    for(;;){
      const candidate=resolve(location,'node_modules',name);
      try{const target=await realpath(candidate);if(!beneath(root,target))throw new RepairError('DEPENDENCY_OUTSIDE_INSTALL');return target;}
      catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}
      if(location===root||location===resolve(root,'..'))break;
      const parent=resolve(location,'..');if(parent===location||!beneath(resolve(root,'..'),parent)&&parent!==root)break;location=parent;
    }
    const target=await realpath(resolve(root,name));if(!beneath(root,target))throw new RepairError('DEPENDENCY_OUTSIDE_INSTALL');return target;
  }
  async function add(name:string,from:string,destination:string,ancestors:ReadonlyMap<string,string>) {
    const directory=await locate(name,from),metadata=packageSchema.parse(JSON.parse(await readFile(resolve(directory,'package.json'),'utf8')));
    if(metadata.name!==name)throw new RepairError('DEPENDENCY_IDENTITY_MISMATCH');
    const key=`${name}@${metadata.version}`;
    if(ancestors.has(key))return; // Node resolves an ancestor's exact package without a nested copy.
    const previous=installed.get(destination);if(previous){if(previous!==directory)throw new RepairError('DEPENDENCY_DESTINATION_CONFLICT');return;}
    installed.set(destination,directory);versions.push({name,version:metadata.version,destination});
    async function walk(current:string,output:string){
      for(const entry of await readdir(current,{withFileTypes:true})){
        if(entry.name==='node_modules'||entry.name.startsWith('.')||entry.name.endsWith('.map')||entry.name.endsWith('.md')||excludedDirectories.has(entry.name))continue;
        const path=resolve(current,entry.name),child=`${output}/${entry.name}`,stat=await lstat(path);
        if(stat.isSymbolicLink())throw new RepairError('DEPENDENCY_SYMLINK_REJECTED');
        if(stat.isDirectory()){await walk(path,child);continue;}
        if(!stat.isFile())throw new RepairError('DEPENDENCY_NOT_REGULAR');
        total+=stat.size;if(total>512*1024*1024||files.length>=20000)throw new RepairError('DEPENDENCY_SIZE_LIMIT');
        const bytes=await readFile(path);if(bytes.length!==stat.size)throw new RepairError('DEPENDENCY_CHANGED_DURING_READ');
        files.push({path:child,bytes,role:'dependency'});
      }
    }
    await walk(directory,destination);
    const chain=new Map(ancestors);chain.set(key,destination);
    for(const dependency of Object.keys(metadata.dependencies??{}))await add(dependency,directory,`${destination}/node_modules/${dependency}`,chain);
    for(const dependency of Object.keys(metadata.optionalDependencies??{})){
      try{await add(dependency,directory,`${destination}/node_modules/${dependency}`,chain);}
      catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}
    }
  }
  for(const name of names)await add(name,resolve(root,'..'),`node_modules/${name}`,new Map());
  return {files,versions,totalBytes:total};
}
