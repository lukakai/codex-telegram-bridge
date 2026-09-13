import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VERSION, REFERENCE_COMMIT } from './src/util.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const files=['main.mjs','setup.mjs','verify.mjs',...fs.readdirSync(path.join(root,'src')).filter(f=>f.endsWith('.mjs')).map(f=>`src/${f}`),...fs.readdirSync(path.join(root,'test')).filter(f=>f.endsWith('.test.mjs')).map(f=>`test/${f}`)];
const checks=files.map(file=>{
  const r=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8',timeout:15000,shell:false});
  return {file,passed:r.status===0,detail:r.status===0?undefined:r.stderr};
});
const shell=spawnSync('/bin/zsh',['-n',path.join(root,'start.command')],{encoding:'utf8',timeout:10000,shell:false});
checks.push({file:'start.command',passed:shell.status===0,detail:shell.status===0?undefined:shell.stderr});
const tests=spawnSync(process.execPath,['--test','--test-reporter=tap',...files.filter(f=>f.startsWith('test/')).map(f=>path.join(root,f))],{encoding:'utf8',timeout:60000,shell:false,maxBuffer:4*1024*1024});
const output=tests.stdout||'';
const total=Number(output.match(/^# tests (\d+)$/m)?.[1]||0), passed=Number(output.match(/^# pass (\d+)$/m)?.[1]||0);
const report={version:VERSION,generatedAt:new Date().toISOString(),node:process.versions.node,referenceCommit:REFERENCE_COMMIT,syntaxChecks:checks,tests:{total,passed,exitCode:tests.status},allOfflineChecksPassed:checks.every(c=>c.passed)&&tests.status===0&&total>0,liveCodexVerified:false,liveTelegramVerified:false,limitations:['This script runs offline mocks only. No real generation task, Telegram request, credential lookup, or network request is made by this script.','App-server schema may differ across installed Codex versions.','Desktop takeover is verified with synthetic process snapshots only. A real confirmation would terminate the current ChatGPT desktop Codex backend and therefore is intentionally not exercised by this verifier.'],testOutput:output,testError:tests.stderr||''};
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Syntax: ${checks.filter(c=>c.passed).length}/${checks.length}; offline tests: ${passed}/${total}; live Codex/Telegram: not verified.`);
console.log(`Report: ${path.join(root,'verification.json')}`);
if (!report.allOfflineChecksPassed) {console.error(output,tests.stderr);process.exitCode=1;}
