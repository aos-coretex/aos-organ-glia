/**
 * 8 deterministic autoheal handlers — reimplemented from scr-bash-llm-ops-auto-remediate.sh.
 *
 * Orchestration logic in Node.js, system operations via child_process.execFile.
 * Each handler returns { success: boolean, detail: string }.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const SCRIPTS_ROOT = '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/100-Scripts/01-Scripts-LLM-Ops';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// --- Handler Implementations ---

async function handler_capture_processor() {
  try {
    const script = `${SCRIPTS_ROOT}/06-capture-scripts/scr-bash-llm-ops-capture-processor/scr-bash-llm-ops-capture-processor.sh`;
    await access(script, constants.X_OK);
    await execFileAsync('bash', [script, '--batch'], { timeout: 120000 });
    return { success: true, detail: 'Capture processor batch executed' };
  } catch (err) {
    return { success: false, detail: `Capture processor failed: ${err.message}` };
  }
}

async function handler_symlink_redeploy() {
  try {
    const script = `${SCRIPTS_ROOT}/02-indexing-scripts/scr-bash-llm-ops-symlink-deployer/scr-bash-llm-ops-symlink-deployer.sh`;
    await access(script, constants.X_OK);
    await execFileAsync('bash', [script], { timeout: 60000 });
    return { success: true, detail: 'Symlinks redeployed' };
  } catch (err) {
    return { success: false, detail: `Symlink deploy failed: ${err.message}` };
  }
}

async function handler_launchagent_reload() {
  try {
    // List loaded agents to identify missing ones
    const { stdout } = await execFileAsync('launchctl', ['list'], { timeout: 5000 });
    const agentsDir = `${process.env.HOME}/Library/LaunchAgents`;

    // Reload any unloaded agents
    const { stdout: files } = await execFileAsync('ls', [agentsDir], { timeout: 5000 });
    const plistFiles = files.split('\n').filter((f) => f.startsWith('com.llm-ops.') || f.startsWith('com.coretex.'));
    let reloaded = 0;

    for (const plist of plistFiles) {
      const label = plist.replace('.plist', '');
      if (!stdout.includes(label)) {
        try {
          await execFileAsync('launchctl', ['load', `${agentsDir}/${plist}`], { timeout: 5000 });
          reloaded++;
        } catch {
          // already loaded or error
        }
      }
    }

    return { success: true, detail: `LaunchAgents checked, ${reloaded} reloaded` };
  } catch (err) {
    return { success: false, detail: `LaunchAgent reload failed: ${err.message}` };
  }
}

async function handler_radiant_boot_cache() {
  try {
    const script = `${SCRIPTS_ROOT}/03-skill-scripts/scr-node-llm-ops-memory-state-generator/scr-node-llm-ops-memory-state-generator.js`;
    await access(script, constants.R_OK);
    await execFileAsync('node', [script], { timeout: 120000 });
    return { success: true, detail: 'Radiant boot cache regenerated' };
  } catch (err) {
    return { success: false, detail: `Boot cache regen failed: ${err.message}` };
  }
}

async function handler_radiant_dream() {
  try {
    // Trigger dream cycle via Radiant MCP or script
    const script = `${SCRIPTS_ROOT}/03-skill-scripts/scr-node-llm-ops-radiant-dreamer/scr-node-llm-ops-radiant-dreamer.js`;
    await access(script, constants.R_OK);
    await execFileAsync('node', [script], { timeout: 300000 });
    return { success: true, detail: 'Radiant dream cycle executed' };
  } catch (err) {
    return { success: false, detail: `Dream cycle failed: ${err.message}` };
  }
}

async function handler_pg_restart() {
  try {
    await execFileAsync('brew', ['services', 'restart', 'postgresql@17'], { timeout: 30000 });
    // Wait for postgres to come up
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await execFileAsync('pg_isready', [], { timeout: 5000 });
    return { success: true, detail: 'PostgreSQL restarted and ready' };
  } catch (err) {
    return { success: false, detail: `PostgreSQL restart failed: ${err.message}` };
  }
}

async function handler_backup_retry() {
  try {
    const script = `${SCRIPTS_ROOT}/04-backup-scripts/scr-bash-llm-ops-safevault-backup/scr-bash-llm-ops-safevault-backup.sh`;
    await access(script, constants.X_OK);
    await execFileAsync('bash', [script], { timeout: 600000 });
    return { success: true, detail: 'Backup retry completed' };
  } catch (err) {
    return { success: false, detail: `Backup retry failed: ${err.message}` };
  }
}

async function handler_custom() {
  // Custom handler — placeholder for test-specific fixes
  return { success: false, detail: 'Custom handler not implemented for this test' };
}

// --- Handler Map: test-id patterns → handler functions ---

export const HANDLER_MAP = [
  {
    name: 'capture_processor',
    patterns: ['capture-unprocessed', 'capture-verify-pass', 'capture-event-count'],
    fn: handler_capture_processor,
    cooldown_ms: 30 * 60 * 1000,
  },
  {
    name: 'symlink_redeploy',
    patterns: ['symlinks-*'],
    fn: handler_symlink_redeploy,
    cooldown_ms: 30 * 60 * 1000,
  },
  {
    name: 'launchagent_reload',
    patterns: ['launchagent-*'],
    fn: handler_launchagent_reload,
    cooldown_ms: 15 * 60 * 1000,
  },
  {
    name: 'radiant_boot_cache',
    patterns: ['radiant-boot-cache'],
    fn: handler_radiant_boot_cache,
    cooldown_ms: 60 * 60 * 1000,
  },
  {
    name: 'radiant_dream',
    patterns: ['radiant-dream-fresh'],
    fn: handler_radiant_dream,
    cooldown_ms: 6 * 60 * 60 * 1000,
  },
  {
    name: 'pg_restart',
    patterns: ['db-radiant-*', 'db-minder-*', 'db-aosweb-*'],
    fn: handler_pg_restart,
    cooldown_ms: 30 * 60 * 1000,
  },
  {
    name: 'backup_retry',
    patterns: ['backup-*'],
    fn: handler_backup_retry,
    cooldown_ms: 6 * 60 * 60 * 1000,
  },
  {
    name: 'custom',
    patterns: [],
    fn: handler_custom,
    cooldown_ms: 30 * 60 * 1000,
  },
];

/**
 * Get handler function by name.
 * @param {string} name
 * @returns {Function|null}
 */
export function getHandlerFn(name) {
  const entry = HANDLER_MAP.find((h) => h.name === name);
  return entry ? entry.fn : null;
}
