import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDir } from './accounts.js';
import { loadConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { createServer, listen, resolveUiDir } from './server.js';
import { missingSkills, missingSkillsMessage } from './skills.js';

const here = dirname(fileURLToPath(import.meta.url));

const cfg = loadConfig();
const orch = new Orchestrator(cfg);

const server = await listen(createServer(cfg, orch), cfg);
console.log(`worker-console  http://${cfg.host}:${cfg.port}`);
console.log(`  repo          ${cfg.repo} at ${cfg.repoPath}`);
console.log(`  max active    ${cfg.maxActive}`);
// The one container the button may restart. Nothing restarts it on its own —
// see "Why there is no automatic restart" in docs/INFO.md.
console.log(`  edge runtime  ${cfg.edgeContainer} — restarted only when you click the button`);
console.log(`  ui            ${resolveUiDir(cfg) ?? 'NOT BUILT — run npm run build'}`);

// SKILLS_RULE names two skills to every worker. A named skill that is not
// installed produces no error anywhere — the worker is simply told to apply
// something it cannot find, and the only symptom is prose that stops following
// the guide. Say it here instead. It does not stop the console: a missing
// writing skill is not a reason to be unable to work a ticket.
for (const line of missingSkillsMessage(
  await missingSkills(join(canonicalDir(), 'skills')),
  join(here, '..', '..', 'scripts', 'setup-skills.sh'),
)) {
  console.log(line);
}

const picked = await orch.start();
console.log('  first poll done');
// Workers outlive this process, so starting up is partly a matter of finding the
// ones that were already running.
if (picked.reattached.length > 0) {
  console.log(`  re-attached    ${picked.reattached.map((n) => `#${n}`).join(', ')} — still running from before`);
}
if (picked.reconciled.length > 0) {
  console.log(`  reconciled     ${picked.reconciled.map((n) => `#${n}`).join(', ')} — ended while the console was down`);
}

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nshutting down');
    void orch.stop().then(({ leftRunning }) => {
      // Restarting the console is not an event in a worker's life. Say so, so
      // that nobody watching this log has to wonder what happened to their run.
      console.log(
        leftRunning === 0
          ? '  no workers were running'
          : `  ${leftRunning} worker${leftRunning === 1 ? '' : 's'} left running — they are detached, ` +
              `and will be re-attached when the console starts again`,
      );
      server.close(() => process.exit(0));
      // An open SSE stream never ends on its own, so a plain close() hangs forever.
      server.closeAllConnections();
    });
  });
}
