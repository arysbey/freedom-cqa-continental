/** Reproduce setup offline in a new workspace-local directory, without keys or private data. */
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const destination = resolve('tmp', `clean-setup-${Date.now()}`);
assert(relative(root, destination) && !relative(root, destination).startsWith('..'));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
  assert(!isAbsolute(file) && !file.split(/[\\/]/).includes('..'));
  assert(!/^(private|tmp|dist|node_modules|\.git|\.pnpm-store)[\\/]/.test(file));
  if (/^\.env/.test(file) && file !== '.env.example') throw new Error('PRIVATE_CONFIGURATION_IN_PUBLIC_SOURCE');
  const target = resolve(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, file), target);
}
const cleanEnv = { ...process.env };
for (const name of Object.keys(cleanEnv)) if (/^(GEMINI_|GOOGLE_API_KEY|CQA_)/.test(name)) delete cleanEnv[name];
cleanEnv.PORT = '3019';
cleanEnv.CQA_DB_PATH = resolve(destination, 'private/cqa.sqlite');
const pnpm = process.env.CQA_PNPM_SCRIPT;
if (!pnpm) throw new Error('SET_CQA_PNPM_SCRIPT_TO_LOCAL_PNPM_MJS');
function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: destination, env: cleanEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) { console.error((result.stdout || '') + (result.stderr || '')); throw new Error('CLEAN_SETUP_COMMAND_FAILED'); }
}
run([pnpm, 'install', '--offline', '--frozen-lockfile', '--ignore-workspace', '--ignore-scripts', '--store-dir', resolve(root, '.pnpm-store'), '--config.enable-global-virtual-store=false', '--config.node-linker=hoisted', '--config.package-import-method=copy']);
run(['node_modules/typescript/bin/tsc', '--noEmit']);
run(['node_modules/vite/bin/vite.js', 'build']);
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], { cwd: destination, env: cleanEnv, stdio: 'ignore', windowsHide: true });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3019/api/status');
      if (response.ok) {
        const status = await response.json();
        assert.equal(status.apiKeyPresent, false); assert.equal(status.liveEvaluationCount, 0); assert.equal(status.manualEvaluationCount, 0);
        ready = true; break;
      }
    } catch { /* Wait for this isolated local server to listen. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'CLEAN_SERVER_NOT_READY');
  const response = await fetch('http://127.0.0.1:3019/'); assert(response.ok); assert((await response.text()).includes('<div id="root">'));
  const conversations = await (await fetch('http://127.0.0.1:3019/api/conversations')).json(); assert.deepEqual(conversations, []);
  const report = { status: 'PASS', offlineLockedInstall: true, sourceFilesCopied: files.length, privateFilesCopied: 0, apiKeysProvided: false, typecheck: 'PASS', productionBuild: 'PASS', freshLocalServer: 'PASS', importedRecords: 0, directory: relative(root, destination) };
  mkdirSync('private/reports', { recursive: true }); writeFileSync('private/reports/clean-setup.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { server.kill(); }
