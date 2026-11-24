import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../offline.ts';
import { createApi, serverOrigin, ApiError } from '../../shared/api.ts';
const event = {key:'event-key',path:'/api/core/motorcycles/test/events',body:{kind:'EXPENSE'}};
test('preserves the key through an ambiguous network failure and replay', async()=>{
  const keys=[];
  let saved=await replay([event],async(_,__,___,key)=>{keys.push(key);throw new TypeError('offline')},async()=>{});
  assert.deepEqual(saved,[event]);
  saved=await replay(saved,async(_,__,___,key)=>keys.push(key),async()=>{});
  assert.deepEqual(saved,[]);
  assert.deepEqual(keys,['event-key','event-key']);
});
test('leaves a rejected event visible for review',async()=>{
  const rows=await replay([event],async()=>{throw new ApiError(409,'Conflicto')},async()=>{});
  assert.equal(rows[0].issue,'Conflicto');
});
test('client sends scoped Bearer and Idempotency-Key',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://localhost:8443'+event.path);
    assert.equal(options.headers.get('Authorization'),'Bearer token');
    assert.equal(options.headers.get('Idempotency-Key'),event.key);
    return Response.json({status:'created'},{status:201});
  });
  const api=createApi(serverOrigin('https://localhost:8443'),'token');
  assert.deepEqual(await api(event.path,'POST',event.body,event.key),{status:'created'});
  assert.throws(()=>serverOrigin('http://example.com'));
});
