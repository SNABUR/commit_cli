#!/usr/bin/env node

/**
 * commit-agent
 * Cross-platform Git commit tracking agent (Windows & Linux)
 * Stores commit messages in Cloudflare D1 via Worker endpoint
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const DEFAULT_ENDPOINT = 'https://commits.tu-dominio.com/v1/commits';
const CONFIG_DIR = path.join(os.homedir(), '.commit-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const QUEUE_FILE = path.join(CONFIG_DIR, 'queue.json');
const HOOKS_DIR = path.join(CONFIG_DIR, 'hooks');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig() {
  ensureDir(CONFIG_DIR);
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      // fallback
    }
  }
  const defaultConf = {
    endpoint: DEFAULT_ENDPOINT,
    secret: '',
    installation_id: os.hostname() || 'worker-node',
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConf, null, 2), 'utf8');
  return defaultConf;
}

function saveConfig(cfg) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function loadQueue() {
  ensureDir(CONFIG_DIR);
  if (fs.existsSync(QUEUE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveQueue(q) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), 'utf8');
}

function enqueueCommit(payload) {
  const q = loadQueue();
  q.push(payload);
  // Keep maximum 500 items to avoid infinite disk usage
  if (q.length > 500) {
    q.splice(0, q.length - 500);
  }
  saveQueue(q);
}

// Post single payload to Worker endpoint
async function sendPayload(endpoint, secret, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) {
    headers['X-Agent-Key'] = secret;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000); // 4s timeout max

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

// Drain local queue asynchronously
async function processQueue() {
  const config = loadConfig();
  const queue = loadQueue();
  if (!queue || queue.length === 0) return;

  const remaining = [];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const success = await sendPayload(config.endpoint, config.secret, item);
    if (!success) {
      remaining.push(item, ...queue.slice(i + 1));
      break;
    }
  }
  saveQueue(remaining);
}

// Helper to run git commands safely
function gitCmd(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Handler for `commit-agent capture <commit-msg-file>`
async function handleCapture(msgFilePath) {
  try {
    if (!msgFilePath || !fs.existsSync(msgFilePath)) {
      process.exit(0);
    }

    const rawContent = fs.readFileSync(msgFilePath, 'utf8');
    // Git comments start with #
    const lines = rawContent.split(/\r?\n/).filter(line => !line.trim().startsWith('#') && line.trim().length > 0);
    if (lines.length === 0) {
      process.exit(0);
    }

    const title = lines[0].trim();
    if (!title) {
      process.exit(0);
    }

    // Identify repository name
    let repoName = '';
    const toplevel = gitCmd('git rev-parse --show-toplevel');
    if (toplevel) {
      repoName = path.basename(toplevel);
    }
    if (!repoName) {
      const remoteUrl = gitCmd('git config --get remote.origin.url');
      if (remoteUrl) {
        repoName = remoteUrl.split('/').pop().replace(/\.git$/, '');
      }
    }
    if (!repoName) {
      repoName = path.basename(process.cwd());
    }

    const branch = gitCmd('git rev-parse --abbrev-ref HEAD') || undefined;
    const author = gitCmd('git config user.name') || undefined;
    const config = loadConfig();

    const payload = {
      installation_id: config.installation_id,
      repository: repoName,
      message: title,
      branch: branch,
      author: author,
      platform: `${os.platform()} ${os.arch()}`,
      timestamp: new Date().toISOString()
    };

    // Fail-open: try sending immediately, if fails, enqueue
    const ok = await sendPayload(config.endpoint, config.secret, payload);
    if (!ok) {
      enqueueCommit(payload);
    } else {
      // Also try draining queue if online
      await processQueue();
    }
  } catch (err) {
    // Fail-open: never block git commit on errors
  }
  process.exit(0);
}

// Handler for `commit-agent init`
function handleInit(args) {
  console.log('\x1b[36m%s\x1b[0m', '⚡ Configurando commit-agent (Windows & Linux)...');

  // Parse args
  let endpoint = DEFAULT_ENDPOINT;
  let secret = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--endpoint' && args[i + 1]) {
      endpoint = args[i + 1];
    }
    if (args[i] === '--secret' && args[i + 1]) {
      secret = args[i + 1];
    }
  }

  const config = loadConfig();
  config.endpoint = endpoint;
  if (secret) config.secret = secret;
  saveConfig(config);

  ensureDir(HOOKS_DIR);

  // Cross-platform commit-msg hook script (works in Linux /bin/sh and Windows Git Bash)
  const hookFilePath = path.join(HOOKS_DIR, 'commit-msg');
  const agentScriptPath = path.resolve(__dirname, 'commit-agent.js').replace(/\\/g, '/');

  const hookContent = `#!/bin/sh
# commit-agent hook - Fail open (never block git commit)
MSG_FILE="$1"

if command -v node >/dev/null 2>&1; then
  node "${agentScriptPath}" capture "$MSG_FILE" >/dev/null 2>&1
fi

exit 0
`;

  fs.writeFileSync(hookFilePath, hookContent, { mode: 0o755 });

  try {
    fs.chmodSync(hookFilePath, 0o755);
  } catch {}

  // Configure Git global hooksPath
  // Normalize hooks directory path for Git
  const gitHooksPath = HOOKS_DIR.replace(/\\/g, '/');
  try {
    execSync(`git config --global core.hooksPath "${gitHooksPath}"`, { stdio: 'inherit' });
    console.log('\x1b[32m%s\x1b[0m', `✓ Git global core.hooksPath configurado en: ${gitHooksPath}`);
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', 'Error al ejecutar git config --global core.hooksPath: ' + err.message);
  }

  console.log('\x1b[32m%s\x1b[0m', `✓ Endpoint configurado: ${config.endpoint}`);
  console.log('\x1b[32m%s\x1b[0m', `✓ ID de Instalación: ${config.installation_id}`);
  console.log('\x1b[32m%s\x1b[0m', `✓ Hook instalado en: ${hookFilePath}`);
  console.log('\n\x1b[35m%s\x1b[0m', '¡Listo! Tus próximos "git commit" se enviarán automáticamente a Cloudflare D1 sin bloquear ningún flujo.');
}

// Handler for `commit-agent status`
function handleStatus() {
  const config = loadConfig();
  const queue = loadQueue();
  const gitHook = gitCmd('git config --global core.hooksPath');

  console.log('\n=== Commit Agent Status ===');
  console.log(`Endpoint:        ${config.endpoint}`);
  console.log(`Installation ID: ${config.installation_id}`);
  console.log(`Git hooksPath:   ${gitHook || '(No configurado)'}`);
  console.log(`Cola pendiente:  ${queue.length} commit(s) pendientes`);
  console.log(`Plataforma:      ${os.platform()} (${os.arch()})`);
  console.log('===========================\n');
}

// Handler for `commit-agent sync`
async function handleSync() {
  console.log('Sincronizando commits pendientes en cola...');
  await processQueue();
  const remaining = loadQueue();
  console.log(`Completado. Commits pendientes restantes: ${remaining.length}`);
}

// CLI Routing
const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
Uso de commit-agent:
  commit-agent init [--endpoint <url>] [--secret <key>]  Configura hook global y endpoint
  commit-agent status                                    Muestra el estado actual y cola
  commit-agent sync                                      Fuerza el envío de commits en cola
  commit-agent capture <commit-msg-file>                 Llamado internamente por el hook
`);
  process.exit(0);
}

if (cmd === 'init') {
  handleInit(rest);
} else if (cmd === 'capture') {
  handleCapture(rest[0]);
} else if (cmd === 'status') {
  handleStatus();
} else if (cmd === 'sync') {
  handleSync();
} else {
  console.log(`Comando desconocido: ${cmd}. Usa "commit-agent help"`);
  process.exit(1);
}
