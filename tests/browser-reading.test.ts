import { join } from 'node:path';
import { boundedEvaluation, evaluationExpression } from '../main/browser/page-evaluate';
import { readLimit } from '../main/browser/page-reading';
import { boundedWaitDuration, waitForPage, waitedUrlMatches, waitSubject } from '../main/browser/page-wait';
import { assert, assertEqual, assertRejects, Harness } from './harness';

const h=new Harness();
h.test('read budgets reject nonfinite values and preserve requested small limits',async()=>{
  assertEqual(readLimit(3,10,100,'maxChars'),3,'exact budget');
  for(const value of [0,-1,NaN,Infinity,101,'10'])await assertRejects(async()=>readLimit(value,10,100,'maxChars'),'invalid budget refused');
});
h.test('read-only result limits preserve small data and mark depth and byte truncation',()=>{
  assertEqual(boundedEvaluation('你好'),'你好','small Unicode result');
  assert(JSON.stringify(boundedEvaluation({one:{two:{three:true}}},2)).includes('maximum result depth'),'depth marker');
  assert(JSON.stringify(boundedEvaluation('中文'.repeat(40000))).includes('result exceeds 200000 bytes'),'byte marker');
  assert(evaluationExpression({script:'row=>row.value',args:{value:'literal ` $() "'}}).includes('literal ` $()'),'arguments are data in the expression');
});
h.test('wait subjects reject mixed requests and duration does not require a page',async()=>{
  assertEqual(waitSubject({url:'*/done'}),'url','URL subject');
  await assertRejects(()=>waitForPage(undefined,{ms:0,url:'*/done'}),'mixed wait refused');
  await assertRejects(()=>waitForPage(undefined,{state:'visible'}),'missing element refused');
  assertEqual((await waitForPage(undefined,{ms:0})).waitedMs,0,'zero duration succeeds without page');
  for(const ms of [-1,Infinity])await assertRejects(()=>waitForPage(undefined,{ms}),'invalid duration');
  assertEqual(boundedWaitDuration(60_001),60_001,'released waits may exceed the retired 60 second ceiling');
  assertEqual(boundedWaitDuration(999_999_999),120_000,'released ceiling clamps without sleeping for two minutes');
});
h.test('URL waits treat regex punctuation literally and wildcard positions deliberately',()=>{
  assert(waitedUrlMatches('https://example.test/done?x=1','/done'),'substring match');
  assert(waitedUrlMatches('https://example.test/a/done','*/done'),'wildcard match');
  assert(!waitedUrlMatches('https://example.test/done?x=1','*/done'),'wildcard full URL boundary');
  assert(!waitedUrlMatches('https://exampleXtest/a','https://example.test/*'),'literal dot');
});
void h.finish(join(__dirname,'browser-reading-result.json'),'browser-reading').then(code=>{process.exitCode=code;});
