import { z } from 'zod';
import { createHash } from 'node:crypto';
import { digest, hashValue, identifier, parseJson } from '../../core/src/index.ts';

export class RepairError extends Error { constructor(readonly code:string) {super(code);} }
export const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
export const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const repositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/).refine(value=>!value.endsWith('.git'));
export const branchSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value=>!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.endsWith('.')&&!value.endsWith('.lock'));
export const pathSchema = z.string().min(1).max(500).refine(value=>{
  if(value.startsWith('/')||value.includes('\\')||[...value].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)||/[:*?<>|]/.test(value))return false;
  const parts=value.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.trim()!==part))return false;
  const lower=parts.map(part=>part.toLowerCase()),name=lower.at(-1)??'';
  if(lower.some(part=>['.git','.github','.gitlab','.circleci','.buildkite','.codex','.agents','node_modules','tests','test','__tests__','core','oracle','oracles'].includes(part))||name.startsWith('.env')||['.gitlab-ci.yml','azure-pipelines.yml','jenkinsfile'].includes(name))return false;
  return !(/(^\.env($|\.)|\.(test|spec)\.|\.lock$|(^|[-.])lock\.(json|ya?ml)$|^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc|\.gitmodules)$|^(auth|oauth|security)[.-].*config|^(vitest|jest|playwright)\.config)/.test(name));
},'Unsafe or protected repair path');
export const changeSchema=z.strictObject({path:pathSchema,content:z.string().max(1_048_576).nullable()});
export const changesSchema=z.array(changeSchema).min(1).max(50).refine(changes=>new Set(changes.map(change=>change.path.toLowerCase())).size===changes.length).refine(changes=>!changes.some(change=>changes.some(other=>other.path!==change.path&&other.path.toLowerCase().startsWith(`${change.path.toLowerCase()}/`))));
const allowedPathsSchema=z.array(pathSchema).min(1).max(100).refine(paths=>new Set(paths).size===paths.length);
export const proposalSchema=z.strictObject({
  runId:identifier,findingId:identifier,attempt:z.union([z.literal(1),z.literal(2)]),baseCommit:gitSha,baseBranch:branchSchema,
  repository:repositorySchema,branch:branchSchema,policyHash:digest,oracleHash:digest,allowedPaths:allowedPathsSchema,
  changes:changesSchema,diffHash:digest,verificationMode:z.enum(['local_replay','polar_sandbox']),failureCode:identifier,
  summary:z.string().min(1).max(4000),reportUrl:z.string().url().refine(value=>{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}),
});
export const receiptSchema=z.strictObject({id:identifier,executionId:identifier,checkId:identifier,oracleHash:digest,policyHash:digest,baseCommit:gitSha,diffHash:digest.nullable(),artifactHash:digest,observedAt:timestamp,exitCode:z.number().int().min(0).max(255),outcome:z.enum(['pass','fail']),failureCode:identifier.nullable()});
export const verificationSchema=z.strictObject({before:receiptSchema,after:receiptSchema,regressions:z.array(receiptSchema).min(1).max(100)});
export const manifestSchema=proposalSchema.extend({requiredRegressionChecks:z.array(identifier).min(1),verification:verificationSchema});
export type RepairManifest=z.infer<typeof manifestSchema>;
export const publicationArgsSchema=z.strictObject({repository:repositorySchema,baseBranch:branchSchema,branch:branchSchema,draft:z.boolean(),title:z.string().min(1).max(200),body:z.string().min(1).max(50000)});
export const approvalSchema=z.strictObject({id:identifier,bindingHash:digest,expiresAt:timestamp,decision:z.enum(['pending','allow','deny']),args:publicationArgsSchema});
export const publicationReceiptSchema=z.strictObject({repository:repositorySchema,branch:branchSchema,baseCommit:gitSha,commitSha:gitSha,treeSha:gitSha,prNumber:z.number().int().positive(),url:z.string().url(),draft:z.boolean(),manifestHash:digest,collectedAt:timestamp,transportMode:z.enum(['github','synthetic'])});
export const resultSchema=z.strictObject({kind:z.enum(['published','synthetic']),receipt:publicationReceiptSchema});
export const progressSchema=z.strictObject({transportMode:z.enum(['github','synthetic']),treeSha:gitSha.nullable(),commitSha:gitSha.nullable(),prAttempted:z.boolean(),result:resultSchema.nullable()});
export const recordSchema=z.strictObject({id:identifier,createdAt:timestamp,proposal:proposalSchema,state:z.enum(['proposed','verified_local','verified_polar_sandbox','awaiting_publication','published','abandoned']),manifest:manifestSchema.nullable(),manifestHash:digest.nullable(),approval:approvalSchema.nullable(),progress:progressSchema.nullable(),leaseToken:identifier.nullable(),leaseUntil:timestamp});
export type RepairRecord=z.infer<typeof recordSchema>;
export type PublicationProgress=z.infer<typeof progressSchema>;
export function checked<T>(schema:z.ZodType<T>,input:unknown):T {try{return schema.parse(parseJson(input));}catch{throw new RepairError('INVALID_INPUT');}}
export function patchHash(input:unknown):string {return hashValue([...checked(changesSchema,input)].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0));}
export function repairBranch(runId:string,findingId:string,attempt:1|2):string {return `paywallproof/repair-${hashValue({runId:identifier.parse(runId),findingId:identifier.parse(findingId)}).slice(0,20)}-${z.union([z.literal(1),z.literal(2)]).parse(attempt)}`;}
export function blobSha(content:string):string {const bytes=Buffer.from(content);return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
export function marker(manifestHash:string):string {return `<!-- paywallproof-repair:${manifestHash} -->`;}
export function validateProposal(input:unknown,repository:string,allowedPaths:readonly string[]) {
  const proposal=checked(proposalSchema,input);
  if(proposal.repository!==repository||proposal.branch!==repairBranch(proposal.runId,proposal.findingId,proposal.attempt)||proposal.baseBranch===proposal.branch)throw new RepairError('REPAIR_SCOPE_REJECTED');
  if(proposal.diffHash!==patchHash(proposal.changes))throw new RepairError('DIFF_HASH_MISMATCH');
  if(proposal.allowedPaths.some(path=>!allowedPaths.includes(path))||proposal.changes.some(change=>!proposal.allowedPaths.includes(change.path)))throw new RepairError('REPAIR_SCOPE_REJECTED');
  return proposal;
}
