import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { z } from 'zod';
import { checked, pathSchema, RepairError } from './model.ts';

export async function validateRepairPaths(input:unknown) {
  const request=checked(z.strictObject({checkoutRoot:z.string().min(1),paths:z.array(pathSchema).min(1),allowedPaths:z.array(pathSchema).min(1)}),input);
  const root=resolve(request.checkoutRoot),rootStat=await lstat(root);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new RepairError('REPAIR_PATH_REJECTED');
  const physicalRoot=await realpath(root);
  for(const path of request.paths) {
    if(!request.allowedPaths.includes(path))throw new RepairError('REPAIR_PATH_REJECTED');
    let current=root;
    const parts=path.split('/');
    for(const [index,part]of parts.entries()) {
      current=resolve(current,part);
      try {
        const stat=await lstat(current);
        if(stat.isSymbolicLink()||(index<parts.length-1&&!stat.isDirectory())||(index===parts.length-1&&(!stat.isFile()||(stat.mode&0o111)!==0)))throw new RepairError('REPAIR_PATH_REJECTED');
        const relativePath=relative(physicalRoot,await realpath(current));
        if(relativePath==='..'||relativePath.startsWith(`..${sep}`)||resolve(physicalRoot,relativePath)!==await realpath(current))throw new RepairError('REPAIR_PATH_REJECTED');
      }catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')break;throw error;}
    }
  }
  return {root:physicalRoot,paths:[...request.paths]};
}
