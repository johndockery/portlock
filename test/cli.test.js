import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const cliPath = path.resolve('src/cli.js');

test('init writes env and metadata for the current repo', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portlock-test-'));
  const repoDir = path.join(sandbox, 'repo');
  const lockHome = path.join(sandbox, 'lock-home');

  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  fs.copyFileSync(path.resolve('examples/meridian.portlock.json'), path.join(repoDir, '.portlock.json'));

  runCli(['init'], repoDir, lockHome);

  const envFile = fs.readFileSync(path.join(repoDir, '.env.portlock'), 'utf8');
  assert.match(envFile, /API_PORT=3000/);
  assert.match(envFile, /WEB_PORT=3001/);
  assert.match(envFile, /PORTLOCK_CLAIM=main/);

  const current = JSON.parse(runCli(['current', '--json'], repoDir, lockHome));
  assert.equal(current.claim, 'main');
  assert.equal(current.services.api.port, 3000);
  assert.equal(current.services.web.port, 3001);
});

test('bases are unique across different repos on the same machine', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portlock-test-'));
  const lockHome = path.join(sandbox, 'lock-home');
  const repoA = createRepo(path.join(sandbox, 'repo-a'), 'main');
  const repoB = createRepo(path.join(sandbox, 'repo-b'), 'main');

  runCli(['init'], repoA, lockHome);
  runCli(['init'], repoB, lockHome);

  const currentA = JSON.parse(runCli(['current', '--json'], repoA, lockHome));
  const currentB = JSON.parse(runCli(['current', '--json'], repoB, lockHome));

  assert.equal(currentA.base, 3000);
  assert.equal(currentB.base, 3100);
});

function createRepo(repoDir, branch) {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', branch], { cwd: repoDir });
  fs.copyFileSync(path.resolve('examples/meridian.portlock.json'), path.join(repoDir, '.portlock.json'));
  return repoDir;
}

function runCli(args, cwd, lockHome) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PORTLOCK_HOME: lockHome
    }
  }).trim();
}
