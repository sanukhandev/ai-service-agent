# Permanent branch-direction policy — Gemini experiment

**Scope:** `sanukhandev/ai-service-agent`.

## The allowed direction

`main` (Microsoft Foundry baseline) **may be merged into** `experiment/gemini-file-search-poc` to inherit common application, n8n, security, migrations and CI fixes.

**The reverse direction is forbidden.** Never merge `experiment/gemini-file-search-poc`, an experiment descendant, or Gemini-specific commits into `main`; never open a PR with the experiment as source and `main` as destination; never cherry-pick Gemini-only commits to `main`. No direct writes to `main` while performing Gemini tasks.

When syncing, always:
1. Read and record both branch heads.
2. Review full compare diff and identify overlapping paths.
3. Merge `main` **into the experiment only**, preserving independent Gemini files.
4. Verify the new experiment commit has both histories and that `main` remains exactly at the recorded SHA, or report unrelated concurrent movement without attributing it to the experiment.
5. Run relevant integration checks. Do not share Docker volumes, n8n credentials, Postgres data or published knowledge stores across environments.
6. Never create a PR targeting `main` for Gemini changes.

## CI rejection check (advisory until enabled as required)

`.github/workflows/reject-gemini-to-main.yml` fails a PR targeting `main` when the source is the named Gemini experiment, a matching named branch, or has the first unique Gemini experimental commit in its ancestry. This is a defensive signal **on the experimental branch only**. A PR workflow alone does not prevent direct pushes, force pushes, admin bypasses, disabled Actions, renamed/rebased/copied code, or merging when its status check is not required.

## GitHub repository enforcement needed

**Current verification at policy creation:** GitHub reports `main` as `protected: false`. This repository rule is **not technically enforced yet**. A repository administrator must configure a ruleset/branch protection for `main` with:
- Require pull requests before merging and disallow direct pushes and force pushes.
- Require an independently trusted, mandatory status check running from the protected workflow configuration that rejects the Gemini source branch/ancestry. A workflow defined *only* in the experimental head must not be treated as a trustworthy required gate.
- Restrict bypass permissions, require approvals and check policies against branch renamed/rebased scenarios.
- Add an independent automation/check to detect Gemini-only changes if cherry-picking must be blocked; source-name checks alone cannot detect arbitrary copied files or rewritten commits.

Do **not** copy experimental implementation files to `main` to install these rules. Repository-level settings and trusted automation should be configured separately by an authorized administrator.

## Experiment implementation boundaries

Gemini text orchestration, Gemini File Search, POC environment isolation, agent instructions and the 60-minute session-scoped AI memory policy live only in this experimental branch. STT/TTS is a low-priority, separately owned task. Node's authorized n8n workflows, intent catalog and customer ticket authority remain reusable from `main`.

**One-way sync performed 2026-11-14:** integrated `main` at `82aa16de387ebbe78b7741092d799cb6f1420379` into experiment using merge commit `da33c3ba5440d8f04a54b1e3f98145eda62153cd`, without modifying `main`. Includes safe n8n workspace seeding, cross-platform fixes, API preflight and optional local-only mock OTP workflows. 
