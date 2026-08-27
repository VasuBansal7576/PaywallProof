import {type Billing,type AccessPolicy,hashValue} from '../../core/src/index.ts';
import {EvidenceStore,evaluateEvidence} from './index.ts';
import {type ReferenceTargetAdapter} from '../../adapters/src/network.ts';
import {type BrowserRunner} from '../../adapters/src/browser.ts';

/** Shared trusted observation collector for original and repaired target executions. */
export async function observeFeature(input:{
  store:EvidenceStore;target:ReferenceTargetAdapter;browser:BrowserRunner;
  runId:string;scenarioId:string;subjectId:string;fixtureMarker:string;
  policy:AccessPolicy;targetBuild:string;mode:'local_replay'|'stripe_sandbox';notBefore:number;
  billing:()=>Promise<Billing>;
  onArtifact?:(artifact:NonNullable<Awaited<ReturnType<BrowserRunner['probe']>>['artifact']>&{runId:string;observationId:string})=>void;
}) {
  const target=await input.target.describe();
  if(target.buildId!==input.targetBuild||hashValue(target.feature)!==input.policy.featureConfigHash)throw new Error('TARGET_CHANGED');
  const session=await input.target.session({runId:input.runId,principalId:input.subjectId});
  const observedAt=Date.now();
  const [billing,application,api,browser]=await Promise.all([
    input.billing(),input.target.snapshot({runId:input.runId,principalId:input.subjectId}),input.target.probe(session.cookie),input.browser.probe(session.cookie),
  ]);
  const finalTarget=await input.target.describe();
  if(finalTarget.buildId!==input.targetBuild||hashValue(finalTarget.feature)!==input.policy.featureConfigHash)throw new Error('TARGET_CHANGED');
  const common={runId:input.runId,scenarioId:input.scenarioId,subjectId:input.subjectId,policyHash:input.policy.hash,targetBuild:input.targetBuild,mode:input.mode,billingTime:billing.subscription?.billingTime??null,observedAt};
  const stripe=input.store.record({...common,source:'stripe',payload:billing});
  const app=input.store.record({...common,source:'application',payload:application});
  const apiObservation=input.store.record({...common,source:'api_probe',payload:api});
  const browserObservation=input.store.record({...common,observedAt:Date.now(),source:'browser',payload:browser.probe});
  if(browser.artifact)input.onArtifact?.({...browser.artifact,runId:input.runId,observationId:browserObservation.id});
  return evaluateEvidence(input.store,{runId:input.runId,scenarioId:input.scenarioId,subjectId:input.subjectId,policy:input.policy,targetBuild:input.targetBuild,mode:input.mode,fixtureMarker:input.fixtureMarker,stripeId:stripe.id,applicationId:app.id,apiId:apiObservation.id,browserId:browserObservation.id,now:Date.now(),notBefore:input.notBefore});
}
