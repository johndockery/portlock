#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const LOCK_ROOT = process.env.PORTLOCK_HOME
  ? path.resolve(process.env.PORTLOCK_HOME)
  : path.join(os.homedir(), '.portlock');
const LOCK_FILE = path.join(LOCK_ROOT, 'lock.json');
const LOCK_DIR = path.join(LOCK_ROOT, 'lock');
const CONFIG_NAME = '.portlock.json';

const command = process.argv[2];
const args = process.argv.slice(3);

main();

function main() {
  try {
    switch (command) {
      case 'init':
        handleInit();
        return;
      case 'env':
        handleEnv();
        return;
      case 'status':
        handleStatus();
        return;
      case 'release':
        handleRelease();
        return;
      case 'cleanup':
        handleCleanup();
        return;
      case 'current':
        handleCurrent(args);
        return;
      case 'resolve':
        handleResolve(args);
        return;
      case '--help':
      case '-h':
      case undefined:
        printHelp();
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`portlock: ${error.message}`);
    process.exitCode = 1;
  }
}

function handleInit() {
  const context = loadContext();
  const claim = withClaimStore((store) => {
    const pruned = pruneClaims(store);
    const existing = findClaimForWorktree(pruned, context.worktreeRoot);
    if (existing) {
      saveStore(pruned);
      return existing;
    }

    const base = nextAvailableBase(pruned, context.config.basePort, context.config.step);
    const claimName = deriveUniqueClaim(pruned, context);
    const claim = {
      id: createClaimId(),
      repoRoot: context.repoRoot,
      worktree: context.worktreeRoot,
      branch: context.branch,
      claim: claimName,
      base,
      claimedAt: new Date().toISOString()
    };

    pruned.claims.push(claim);
    saveStore(pruned);
    return claim;
  });

  writeOutputs(context, claim);
  console.log(`Initialized ${claim.claim} at base ${claim.base}`);
}

function handleEnv() {
  const { context, claim } = loadActiveClaimContext();
  const env = buildEnv(context.config, claim);
  printEnv(env);
}

function handleStatus() {
  const store = withClaimStore((data) => {
    const pruned = pruneClaims(data);
    saveStore(pruned);
    return pruned;
  });

  if (store.claims.length === 0) {
    console.log('No active claims');
    return;
  }

  for (const claim of store.claims.sort((a, b) => a.base - b.base)) {
    console.log(`${claim.base}\t${claim.claim}\t${claim.worktree}`);
  }
}

function handleRelease() {
  const context = loadContext();
  const released = withClaimStore((store) => {
    const pruned = pruneClaims(store);
    const nextClaims = pruned.claims.filter((claim) => claim.worktree !== context.worktreeRoot);
    const didRelease = nextClaims.length !== pruned.claims.length;
    saveStore({ claims: nextClaims });
    return didRelease;
  });

  removeGeneratedOutputs(context.worktreeRoot);
  console.log(released ? 'Released claim' : 'No active claim for this worktree');
}

function handleCleanup() {
  const removed = withClaimStore((store) => {
    const before = store.claims.length;
    const pruned = pruneClaims(store);
    saveStore(pruned);
    return before - pruned.claims.length;
  });

  console.log(`Removed ${removed} stale claim${removed === 1 ? '' : 's'}`);
}

function handleCurrent(argv) {
  const asJson = argv.includes('--json');
  const { context, claim } = loadActiveClaimContext();
  const payload = buildMeta(context.config, claim);
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${payload.label} (${payload.worktree})`);
}

function handleResolve(argv) {
  const serviceName = argv[0];
  if (!serviceName) {
    throw new Error('Usage: portlock resolve <service>');
  }

  const { context, claim } = loadActiveClaimContext();
  const meta = buildMeta(context.config, claim);
  const service = meta.services[serviceName];
  if (!service) {
    throw new Error(`Unknown service: ${serviceName}`);
  }

  console.log(service.origin ?? service.port ?? JSON.stringify(service));
}

function loadActiveClaimContext() {
  const context = loadContext();
  const store = readStore();
  const claim = findClaimForWorktree(store, context.worktreeRoot);
  if (!claim) {
    throw new Error('No active claim for this worktree. Run `portlock init` first.');
  }

  return { context, claim };
}

function loadContext() {
  const worktreeRoot = getGitRoot(process.cwd());
  const configPath = path.join(worktreeRoot, CONFIG_NAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${CONFIG_NAME} in ${worktreeRoot}`);
  }

  const repoRoot = getMainRepoRoot(worktreeRoot);
  const branch = getGitBranch(worktreeRoot);
  const config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));

  return {
    branch,
    config,
    configPath,
    repoRoot,
    worktreeRoot
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  if (!Number.isInteger(config.basePort)) {
    throw new Error('Config requires integer basePort');
  }

  if (!Number.isInteger(config.step) || config.step <= 0) {
    throw new Error('Config requires positive integer step');
  }

  if (!config.services || typeof config.services !== 'object' || Object.keys(config.services).length === 0) {
    throw new Error('Config requires at least one service');
  }

  const offsets = new Set();
  const envNames = new Set();
  for (const [serviceName, service] of Object.entries(config.services)) {
    if (!Number.isInteger(service.offset)) {
      throw new Error(`Service ${serviceName} requires integer offset`);
    }

    if (service.offset >= config.step) {
      throw new Error(`Service ${serviceName} offset must be less than step`);
    }

    if (offsets.has(service.offset)) {
      throw new Error(`Duplicate service offset: ${service.offset}`);
    }

    offsets.add(service.offset);
    for (const envName of Object.keys(service.env ?? {})) {
      if (envNames.has(envName)) {
        throw new Error(`Duplicate env name: ${envName}`);
      }
      envNames.add(envName);
    }
  }

  for (const envGroup of [config.namespace?.env ?? {}, config.metadata?.env ?? {}]) {
    for (const envName of Object.keys(envGroup)) {
      if (envNames.has(envName)) {
        throw new Error(`Duplicate env name: ${envName}`);
      }
      envNames.add(envName);
    }
  }

  config.stripPrefixes ??= [];
  return config;
}

function buildEnv(config, claim) {
  const servicePorts = Object.fromEntries(
    Object.entries(config.services).map(([serviceName, service]) => [serviceName, claim.base + service.offset])
  );

  const baseTokens = {
    base: String(claim.base),
    branch: claim.branch,
    claim: claim.claim,
    label: buildLabel(claim),
    repoRoot: claim.repoRoot,
    worktree: claim.worktree,
    ...Object.fromEntries(Object.entries(servicePorts).map(([name, port]) => [name, String(port)]))
  };

  const env = {};
  for (const [serviceName, service] of Object.entries(config.services)) {
    const serviceTokens = {
      ...baseTokens,
      port: String(servicePorts[serviceName])
    };
    for (const [envName, template] of Object.entries(service.env ?? {})) {
      env[envName] = renderTemplate(String(template), serviceTokens);
    }
  }

  for (const [envName, template] of Object.entries(config.namespace?.env ?? {})) {
    env[envName] = renderTemplate(String(template), baseTokens);
  }

  for (const [envName, template] of Object.entries(config.metadata?.env ?? {})) {
    env[envName] = renderTemplate(String(template), baseTokens);
  }

  return env;
}

function buildMeta(config, claim) {
  const env = buildEnv(config, claim);
  const services = {};
  for (const [serviceName, service] of Object.entries(config.services)) {
    const port = claim.base + service.offset;
    services[serviceName] = {
      port
    };

    for (const [envName, value] of Object.entries(service.env ?? {})) {
      if (/_ORIGIN$/.test(envName)) {
        services[serviceName].origin = renderTemplate(String(value), {
          base: String(claim.base),
          branch: claim.branch,
          claim: claim.claim,
          label: buildLabel(claim),
          port: String(port),
          repoRoot: claim.repoRoot,
          worktree: claim.worktree,
          ...Object.fromEntries(
            Object.entries(config.services).map(([name, definition]) => [name, String(claim.base + definition.offset)])
          )
        });
      }
    }
  }

  return {
    claim: claim.claim,
    label: buildLabel(claim),
    base: claim.base,
    branch: claim.branch,
    repoRoot: claim.repoRoot,
    worktree: claim.worktree,
    services,
    env
  };
}

function writeOutputs(context, claim) {
  const env = buildEnv(context.config, claim);
  const meta = buildMeta(context.config, claim);
  const envPath = path.join(context.worktreeRoot, '.env.portlock');
  const metaDir = path.join(context.worktreeRoot, '.portlock');
  const metaPath = path.join(metaDir, 'meta.json');

  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    envPath,
    [
      '# Auto-generated by portlock - do not edit',
      `# Claim: ${claim.claim}`,
      `# Base: ${claim.base}`,
      `# Worktree: ${claim.worktree}`,
      '',
      ...Object.entries(env).map(([key, value]) => `${key}=${shellEscape(value)}`),
      ''
    ].join('\n')
  );
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function removeGeneratedOutputs(worktreeRoot) {
  fs.rmSync(path.join(worktreeRoot, '.env.portlock'), { force: true });
  fs.rmSync(path.join(worktreeRoot, '.portlock'), { force: true, recursive: true });
}

function printEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    console.log(`${key}=${shellEscape(value)}`);
  }
}

function shellEscape(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function deriveUniqueClaim(store, context) {
  const baseClaim = deriveBaseClaim(context.branch, context.config.stripPrefixes, context.worktreeRoot, context.repoRoot);
  const activeClaims = new Set(store.claims.map((claim) => claim.claim));
  if (!activeClaims.has(baseClaim)) {
    return baseClaim;
  }

  let index = 2;
  while (activeClaims.has(`${baseClaim}-${index}`)) {
    index += 1;
  }
  return `${baseClaim}-${index}`;
}

function deriveBaseClaim(branch, stripPrefixes, worktreeRoot, repoRoot) {
  if (worktreeRoot === repoRoot) {
    return 'main';
  }

  let value = branch;
  for (const prefix of stripPrefixes) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  value = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  if (!value) {
    value = 'worktree';
  }

  if (value.length <= 32) {
    return value;
  }

  const sliced = value.slice(0, 32);
  const boundary = sliced.lastIndexOf('-');
  return boundary > 0 ? sliced.slice(0, boundary) : sliced;
}

function buildLabel(claim) {
  return `${claim.claim.toUpperCase()} / ${claim.base}`;
}

function renderTemplate(template, tokens) {
  return template.replace(/\{([a-zA-Z0-9]+)\}/g, (_, key) => {
    if (!(key in tokens)) {
      throw new Error(`Unknown template token: ${key}`);
    }
    return tokens[key];
  });
}

function nextAvailableBase(store, basePort, step) {
  const used = new Set(store.claims.map((claim) => claim.base));
  let current = basePort;
  while (used.has(current)) {
    current += step;
  }
  return current;
}

function pruneClaims(store) {
  return {
    claims: store.claims.filter((claim) => {
      if (!fs.existsSync(claim.worktree)) {
        return false;
      }
      if (claim.repoRoot && !fs.existsSync(claim.repoRoot)) {
        return false;
      }
      return true;
    })
  };
}

function findClaimForWorktree(store, worktreeRoot) {
  return store.claims.find((claim) => claim.worktree === worktreeRoot);
}

function createClaimId() {
  return `clm_${Math.random().toString(36).slice(2, 8)}`;
}

function withClaimStore(fn) {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
  acquireLock();
  try {
    return fn(readStore());
  } finally {
    releaseLock();
  }
}

function readStore() {
  if (!fs.existsSync(LOCK_FILE)) {
    return { claims: [] };
  }

  return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
}

function saveStore(store) {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
  const tempPath = `${LOCK_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tempPath, LOCK_FILE);
}

function acquireLock() {
  const timeoutAt = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() > timeoutAt) {
        throw new Error('Timed out acquiring lock');
      }
      sleep(50);
    }
  }
}

function releaseLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function getGitRoot(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

function getMainRepoRoot(cwd) {
  const commonDir = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return path.dirname(commonDir);
}

function getGitBranch(cwd) {
  try {
    return runGit(['branch', '--show-current'], cwd);
  } catch {
    return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  }
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8'
  }).trim();
}

function printHelp() {
  console.log(`portlock

Usage:
  portlock init
  portlock env
  portlock status
  portlock release
  portlock cleanup
  portlock current [--json]
  portlock resolve <service>`);
}
