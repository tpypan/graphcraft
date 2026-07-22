# Security and privacy policy

Graphcraft is an alpha execution layer for coding-agent hosts. It is designed to
make approved work durable, inspectable, resumable, and bounded by a validated
contract. It is not an operating-system sandbox and does not make an untrusted
host CLI safe.

Do not report vulnerabilities in a public issue. Contact the repository owner
through <https://github.com/tpypan> with a minimal reproduction, affected
version, and impact. Do not include live credentials or private repository
content.

## Security model

### Protected assets

Graphcraft tries to protect:

- the user's checkout and unrelated local changes;
- isolated run worktrees and accepted work;
- approved permissions, scopes, finish lines, probes, and acceptance anchors;
- local run records, artifacts, transcripts, and recovery state;
- credentials that cross supported model or persistence boundaries; and
- remote Git and GitHub state touched by an approved finish line.

The user-owned run contract and explicit approvals are trusted. Graphcraft's
runtime and installed package are trusted. Repository files, issue and review
text, GitHub state, command output, probe output, model output, and predecessor
evidence are untrusted data. They may supply evidence but cannot grant
authority. A locally installed Codex or Claude host is a privileged dependency:
Graphcraft limits the tool profile it requests and validates the result, but
cannot prove that a malicious or compromised host obeyed that profile.

### Enforced boundaries

- Agent-authored graphs and amendments pass deterministic schema, dependency,
  scope, permission, side-effect, anchor, probe, and finish-line validation.
- Write-capable work runs in an isolated Git worktree. Graphcraft compares
  tracked, untracked, ignored-excluded, mode, symlink, branch, HEAD, and index
  state before accepting a worker result. Unauthorized changes block acceptance
  and the worktree is preserved for inspection.
- Commits, normal pushes, pull-request creation, review replies and resolution,
  and check reruns use a durable claim-act-confirm journal with exact local and
  remote preconditions. Graphcraft does not force-push, rebase a published
  branch, merge, or deploy.
- Supported host, probe, Git, and GitHub processes are spawned with argument
  arrays and never opt into Node's shell interpolation. The Windows package-
  script bridge uses `cmd.exe` only with allowlisted package managers and
  metacharacter-free script tokens. Commands and paths are validated at their
  owning boundary.
- Known provider tokens, authorization headers, credential-bearing URLs,
  password assignments, private keys, and configured sensitive values are
  redacted before supported model, event, transcript, artifact, report, CLI,
  MCP, and viewer persistence boundaries. Integrity-bound plans reject
  secret-like structural content instead of silently rewriting it.
- Run and artifact files have explicit byte limits, truncation or refusal
  metadata, quotas, recovery reserves, atomic publication, and owner-only local
  permissions. Oversized durable state stops with one inspectable blocker.
- The graphical viewer binds to loopback, accepts only read methods, reloads
  durable state on every projection, applies the same redaction boundary, and
  never becomes an authority or second state store.

### Explicit non-guarantees

Graphcraft does not independently contain arbitrary host subprocess effects
outside the isolated worktree, restrict host network access, or replace a
host-provided OS sandbox. A writable worker may receive shell capability when
the approved task requires it. Use only trusted host installations and apply
the host or operating system's sandbox when stronger containment is required.

Owner-only modes and ACLs protect Graphcraft state from other local accounts;
they do not protect against a malicious process running as the same UID or
Windows SID. In particular, ordinary Node path APIs cannot exclude a fully
coordinated same-user process that swaps and restores a directory entry between
validation and use. Graphcraft detects ordinary drift, binds migrations and
artifact publication to verified snapshots, and fails closed on observed
replacement, but a malicious same-user path-swap adversary is outside the
supported alpha threat model. Closing that boundary would require a native
descriptor-relative traversal such as `openat` throughout, or an equivalent
filesystem snapshot boundary.

Codex and Claude do not expose a conditional compare-and-remove operation for
MCP registrations. Graphcraft verifies its ownership receipt and reinspects the
exact registration immediately before uninstalling it, but another process
running as the same account could still replace that registration between the
final inspection and the host CLI removal command. Avoid changing the
`graphcraft` MCP registration concurrently with install, update, or uninstall.

Local state is not encrypted at rest. A user or process with access to the
account, repository, terminal, host CLI, debugger, swap, or backups may observe
content before redaction. Redaction is defense in depth, not a substitute for
keeping unnecessary secrets out of repositories and prompts.

Loopback binding prevents remote viewer exposure by default, but it is not
authentication against another process or browser session on the same account.
Binding beyond loopback is intentionally unsupported by the stable viewer.

## Data flow and storage

1. The user's task, repository policy, bounded repository evidence, and finish
   line enter planning. Untrusted evidence is delimited from authority-bearing
   contract data.
2. A proposed graph is parsed and deterministically validated. Only the runtime
   attaches the approved contract, anchors, probes, permissions, and control
   edges.
3. Workers receive a bounded capsule rather than the entire event history.
   Host events are schema-validated, redacted, bounded, and appended to the
   integrity-hashed local event log.
4. Deterministic and isolated semantic verification produce evidence. External
   mutations, when approved, pass through the side-effect journal and are
   reconciled before retry after interruption.
5. CLI, MCP, viewer, exports, and benchmark reports project the same durable
   state through bounded reads and redaction.

Run state lives under the repository's `.graphcraft/` directory. Versioned
migrations retain a complete pre-migration backup until the migrated state is
durably published. Artifact inventories record size, hash, disposition,
omitted-byte information, and retention ownership. Supervisor records and logs
are local projections and are not authoritative for run outcome.

`graphcraft delete <run>` and `graphcraft prune` are dry-run by default. A real
deletion requires exact run identifiers and immediate revalidation of terminal
state, locks, supervisors, and pruning criteria. These commands remove only
Graphcraft-owned run state. Preserved worktrees and branches are deliberately
not deleted and must be reviewed and removed separately by the user.

## Privacy and telemetry

Graphcraft has no telemetry, analytics account, or cloud control plane. Normal
operation invokes only the user-selected local host and the repository or
GitHub operations explicitly required by the approved finish line. The local
viewer does not load remote assets.

Any future telemetry must be a separate, explicit opt-in feature with all of
the following before collection begins:

- a versioned public event schema and destination;
- collection disabled by default and consent scoped to a named purpose;
- a preview of every field, excluding source, prompts, diffs, logs, paths,
  credentials, and stable repository or user identifiers;
- documented retention, access, export, and deletion periods; and
- a local way to revoke consent without affecting core execution.

Consent to one benchmark report or support artifact must not imply consent to
ongoing telemetry. Exported reports are redacted but should still be reviewed
before sharing because task summaries and repository-derived evidence can be
sensitive without matching a credential pattern.

## Deployment guidance

- Review the displayed contract, permissions, paths, probes, and remote finish
  line before approval.
- Prefer read-only runs and the smallest include scope that can complete the
  task.
- Keep Codex, Claude, Node, Git, GitHub CLI, and Graphcraft updated from trusted
  sources.
- Use a disposable account, VM, container, or host sandbox for repositories or
  tasks that are not trusted to execute local commands.
- Inspect blocked worktrees and durable evidence before retrying; do not delete
  evidence to force progress.

Security claims apply only to released code and its published acceptance
evidence. Roadmap items are not implemented protections.
