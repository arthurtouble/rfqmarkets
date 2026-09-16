import {test} from 'node:test';
import assert from 'node:assert/strict';
import {childEnvironment} from '../packages/shared/src/process-environment.js';
test('child roles receive explicit credentials without parent secrets or executable injection',()=>{
 const env=childEnvironment({RFQ_APPROVER_KEY:'role-key'},{PATH:'/usr/bin',RFQ_RUNTIME_ENV_JSON:'canary-governance',PYTH_API_KEY:'canary',NODE_OPTIONS:'--require evil',PYTHONPATH:'/evil',RFQ_APPROVER_KEY:'wrong-key'});
 assert.deepEqual(env,{PATH:'/usr/bin',RFQ_APPROVER_KEY:'role-key'});
});
