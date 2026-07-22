# Security policy

Graphcraft v0.1 is an alpha and should be used only in repositories and with coding-agent hosts you trust. It can authorize a host to read and modify an isolated worktree and execute repository commands within the approved run contract.

Do not report vulnerabilities in a public issue. Email the repository owner through the contact method on the GitHub profile at <https://github.com/tpypan> with a minimal reproduction and impact description.

Graphcraft stores run state locally under `.graphcraft/`, uses subprocess argument arrays rather than shell command strings, does not add telemetry, and redacts known or configured secrets before current model and persistence boundaries. Its approved remote finish lines can create atomic commits, perform normal non-force pushes, open pull requests, reply to and resolve verified review threads, and rerun fully identified checks through a durable side-effect journal. It does not force-push, rebase a published branch, merge, or deploy.

Repository scope and Git-state audits run before Graphcraft accepts worker output, but Graphcraft does not yet independently contain arbitrary subprocess effects outside the isolated worktree or a host-provided OS/network sandbox. General artifact retention and deletion controls also remain incomplete. Review the displayed permissions and use Graphcraft only with trusted repositories and host installations while the project remains alpha.
