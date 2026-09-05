# Security

## The design, so you can judge the risk yourself

**It is a laptop tool, and it binds loopback only.** The server listens on
`127.0.0.1:4400`. It is not meant to run on a shared host, behind a reverse
proxy, or on any interface a second machine can reach.

**There is no authentication, by design, and there is not going to be.** Anyone
who can open `http://127.0.0.1:4400` on your machine can drive the console. That
is the same trust boundary as your shell: the console can do nothing you could
not do yourself in the terminal it was started from. Adding a login would move
the boundary nowhere and would suggest a safety the tool does not have. If you
expose the port — an SSH tunnel, a proxy, a container port mapping — you have
handed somebody your shell, and that is on you rather than on the design.

**The write surface is small and fenced in code.** The tracker module contains
only read calls. The one path that writes runs an issue or PR comment through a
check that throws on any verb but `issue comment` and `pr comment`, and a test
guards the module against ever exporting a writer. The console cannot merge,
close, label, assign or edit. The only other write it can make anywhere is a
project-board lane, twice per issue, and only when you have set
`BOARD_PROJECT_NUMBER`; unset is the default and unset is off. Worktree creation
may create and nothing else. One
container may be restarted, matched by an edge-runtime name prefix, on your
click. A process is signalled only when it can be attributed to a worker the
console started or to a dev server both listening on that worktree's registered
port and running inside that worktree.

**Workers run with permission prompts off, behind a fence.** A headless agent has
no terminal and cannot answer a prompt, so the guardrail is an attached
fail-closed hook rather than a question nobody is there to answer. Claude workers
carry the fence inline on every start and resume; Codex workers run with a
console-owned hook that is read and verified before every spawn — missing,
unreadable or changed means the console does not spawn. Every invocation pins the
hook on and ignores user config, so a profile cannot disable it. **The agents
still run real commands on your machine against your repository.** Read the
`issue-pipeline` skill before you trust a worker with a repository you care
about, and keep gates D and E where they are.

**No credential is read, stored or displayed.** Not by the console, not by a
worker. The account doctor reports booleans about files. Logging in is always
you, in a terminal.

**Local files that hold secrets** are written mode 0600 and named individually in
`.gitignore`: `connections.json` (a Linear personal API key) and
`push-keys.json` (the push keypair). `accounts.json` holds directory paths, not
credentials. None of them is ever returned to the browser.

## Reporting a problem

Open a GitHub issue on this repository. There is no private disclosure channel,
and that is deliberate: the console is a local tool with no hosted service, no
accounts and no user data, so there is nothing an embargo would protect. A public
issue reaches every operator running it at the same time it reaches us.

Include what you were running, what you observed, and the smallest set of steps
that shows it. If you have found a way to make the console write to a tracker
outside the one comment path, to signal a process it cannot attribute, to restart
a container that is not an edge runtime, to escape the evidence-file fence, or to
reach the server from another machine, say so plainly at the top — those are the
findings that matter most.
