# Continuous assurance example

1. Replace every example version and SHA-256 with the exact inputs from the
   independently reviewed release.
2. Validate the scope with `npx agentcert schema validate --schema
   assurance-scope --file agentcert.assurance-scope.json`.
3. Create and issue the matching case in AgentCert Hosted.
4. Save `AGENTCERT_API_KEY` as a repository secret and the project/case IDs as
   repository variables.
5. Copy `github-workflow.yml` to `.github/workflows/agentcert.yml`.

The same workflow is prospective on pull requests and authoritative on main
branch pushes, manual release runs, and the nightly schedule.

The Action also accepts `pull-request-config`, `release-config`, and
`nightly-config`. Omit them to use the same `config` for every trigger; add
them when the repository has separate quick, reviewed, and expanded suites.
