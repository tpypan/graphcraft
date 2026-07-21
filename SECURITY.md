# Security policy

Graphcraft v0.1 is an alpha and should be used only in repositories and with coding-agent hosts you trust. It can authorize a host to read and modify an isolated worktree and execute repository commands within the approved run contract.

Do not report vulnerabilities in a public issue. Email the repository owner through the contact method on the GitHub profile at <https://github.com/tpypan> with a minimal reproduction and impact description.

Graphcraft stores run state locally under `.graphcraft/`, uses subprocess argument arrays rather than shell command strings, and does not add telemetry. Secrets must not be written to events, capsules, artifacts, or reports. Remote push, pull-request, merge, and deployment permissions are not implemented in v0.1.
