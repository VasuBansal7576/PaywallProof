import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Controller} from './controller.ts';
import {hashValue} from '../../../packages/core/src/index.ts';

// Implementation-aware failure-injection tests. No provider or runtime evidence.
const opened:{controller:Controller;directory:string}[]=[];
const feature={id:'pro_export',method:'GET',path:'/api/export',denialStatuses:[403],browserPath:'/dashboard',actionTestId:'export-button',resultTestId:'export-result'} as const;
function setup() {
  const directory=mkdtempSync(join(tmpdir(),'pp-startup-'));
  const controller=new Controller({databasePath:join(directory,'control.sqlite'),artifactDirectory:join(directory,'artifacts'),targetOrigin:'http://127.0.0.1:39981',workerOrigin:'http://127.0.0.1:39982',webOrigin:'http://127.0.0.1:39983',adapterToken:'synthetic-adapter',operatorToken:'synthetic-operator',replaySecret:'synthetic-replay',repository:'synthetic/repository',defaultRef:'a'.repeat(40),priceId:'price_synthetic',runtimeUrl:'http://127.0.0.1:39984',model:'synthetic'});
  opened.push({controller,directory});
  vi.spyOn(controller.target,'describe').mockResolvedValue({adapterVersion:'1',environment:'test',buildId:'a'.repeat(40),billingTimeModel:'provider_status',feature:{...feature,denialStatuses:[403]}});
  vi.spyOn(controller.runtime,'checkConnection').mockResolvedValue({model:'synthetic',local:true});
  const cancel=vi.spyOn(controller.runtime,'cancel').mockResolvedValue({});
  const project=controller.createProject({name:'Startup failure checks',repository:'synthetic/repository',ref:'a'.repeat(40),targetId:'reference',ownershipConfirmed:true,modelConsent:true});
  async function start(){const policy=await controller.proposePolicy(project.id,{schemaVersion:1,priceId:'price_synthetic',featureId:'pro_export',featureConfigHash:hashValue(feature),cancellation:'allow_until_period_end',requireInitialInvoicePaid:true,syncWindowSeconds:5,predicateVersion:'reference-export-v1'});return controller.createRun({projectId:project.id,policyHash:policy.hash,mode:'local_replay'});}
  return {controller,start,cancel};
}
afterEach(()=>{vi.restoreAllMocks();for(const {controller,directory} of opened.splice(0)){controller.close();rmSync(directory,{recursive:true,force:true});}});
describe('runtime startup failure recovery',()=>{
  it('terminates an unapprovable run and releases its project lock when registration fails',async()=>{
    const {controller,start}=setup();
    vi.spyOn(controller.runtime,'registerMcpServer').mockRejectedValue(new Error('synthetic registration failure'));
    const first=await start();
    await expect.poll(()=>controller.viewRun(first.id).run.status,{timeout:500}).toBe('canceled');
    expect(controller.viewRun(first.id).runtimeError).toMatchObject({code:'RUNTIME_INITIALIZATION_FAILED'});
    expect((await start()).id).not.toBe(first.id);
    await new Promise(resolve=>setTimeout(resolve,20));
  });
  it('cancels a known session when beginning its first turn fails',async()=>{
    const {controller,start,cancel}=setup();
    vi.spyOn(controller.runtime,'registerMcpServer').mockResolvedValue({data:{name:'synthetic',authStatus:{status:'not_required'},manifest:{type:'remote',name:'synthetic',url:'http://127.0.0.1:39984/mcp',description:'Synthetic test registration'}}});
    vi.spyOn(controller.runtime,'createSession').mockResolvedValue({id:'synthetic-session',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),createdBy:'synthetic',title:null,agent:{type:'reference',id:'synthetic-agent',name:null}});
    vi.spyOn(controller.runtime,'beginTurn').mockRejectedValue(new Error('synthetic lost first-turn response'));
    const run=await start();
    await expect.poll(()=>controller.viewRun(run.id).run.status,{timeout:500}).toBe('canceled');
    expect(cancel).toHaveBeenCalledWith({sessionId:'synthetic-session'});
  });
});
