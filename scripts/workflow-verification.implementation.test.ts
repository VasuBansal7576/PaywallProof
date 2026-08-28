import {describe,it,expect} from 'vitest';
import {assertLocalWorkflowComplete} from './workflow-verification.ts';

// Implementation-aware acceptance-receipt tests; these fixtures are not live evidence.
const receipt=()=>({run:{status:'completed',outcome:'passed',mode:'local_replay'},scenarios:['SC01','SC02','SC03','SC04'].map(id=>({id,api:{verdict:'pass'},browser:{verdict:'pass'},state:{verdict:'pass'}})),cleanup:[{resourceId:'first',status:'deleted'},{resourceId:'second',status:'deleted'}]});
describe('local workflow completion receipt',()=>{
  it('accepts complete scenarios and two distinct deleted fixtures',()=>expect(()=>assertLocalWorkflowComplete(receipt())).not.toThrow());
  it.each(['running','canceled','awaiting_plan_approval'])('rejects %s despite a passed label',status=>{
    const input=receipt();input.run.status=status;expect(()=>assertLocalWorkflowComplete(input)).toThrow();
  });
  it('rejects a failed overall outcome',()=>{const input=receipt();input.run.outcome='failed';expect(()=>assertLocalWorkflowComplete(input)).toThrow();});
  it('does not reclassify a provider receipt as local replay',()=>{const input=receipt();input.run.mode='polar_sandbox';expect(()=>assertLocalWorkflowComplete(input)).toThrow();});
  for(const index of [0,1,2,3])for(const channel of ['api','browser','state'] as const){
    it(`rejects scenario ${index+1} ${channel} failure despite a passed overall label`,()=>{
      const input=receipt();const scenario=input.scenarios[index];if(!scenario)throw Error('FIXTURE_MISSING');scenario[channel].verdict='fail';
      expect(()=>assertLocalWorkflowComplete(input)).toThrow();
    });
  }
  it('rejects duplicate scenario identities',()=>{const input=receipt();const first=input.scenarios[0];if(!first)throw Error('FIXTURE_MISSING');input.scenarios.fill(first);expect(()=>assertLocalWorkflowComplete(input)).toThrow();});
  it('rejects missing scenarios',()=>{const input=receipt();input.scenarios.pop();expect(()=>assertLocalWorkflowComplete(input)).toThrow();});
  it.each(['leftover','retained','unknown'])('rejects %s cleanup',status=>{
    const input=receipt();input.cleanup=[{resourceId:'first',status},{resourceId:'second',status:'deleted'}];expect(()=>assertLocalWorkflowComplete(input)).toThrow();
  });
  it('rejects missing cleanup',()=>{const input=receipt();input.cleanup=[];expect(()=>assertLocalWorkflowComplete(input)).toThrow();});
  it('rejects counting one deleted fixture twice',()=>{const input=receipt();input.cleanup=[{resourceId:'same',status:'deleted'},{resourceId:'same',status:'deleted'}];expect(()=>assertLocalWorkflowComplete(input)).toThrow();});
});
