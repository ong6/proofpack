---
name: proofpack-workflow
description: Manage pilot criteria, evidence, risks, attachments, agent proposals and customer handovers through Proofpack CLI or MCP. Use to trace pilot goals to supporting records, check freshness and prepare a human-reviewed proceed, hold or stop decision.
---

# Proofpack agent workflow

## Connect

Resolve PACKAGE_ROOT two directories above this folder. Install pinned dependencies with `npm ci --prefix PACKAGE_ROOT` when authorized. Invoke `node PACKAGE_ROOT/agent/cli.mjs`; an installed package exposes `proofpack`.

Run `commands` for operation schemas and `record.schema` for section fields. Select `--workspace PATH` explicitly and `init` only when appropriate. `setup` prints MCP configuration without changing agent settings. MCP names replace dots with underscores. Pass JSON using `--input file.json` or stdin with `--input -`.

## Keep a traceable pilot record

1. Inspect `pilot.list`; retain the pilot ID and current library revision. Use `pilot.create` for a new isolated engagement rather than resetting prior work.
2. Read `pilot.get` before writes. Use `record.edit` to update the charter or add/edit criteria, evidence, risks, decision notes and handover tasks. Supply the pilot revision and stable record IDs. Use `dryRun:true` to validate uncertain changes.
3. Define success with a metric, baseline, threshold, owner and date before claiming a result. Link evidence to criteria and record sources, collection dates and freshness windows. Unknown evidence remains unknown.
4. Stage authorized files inside the workspace, then use `attachment.add` with a relative file path. Symlinks, traversal and oversized files are rejected. Files and new records default internal. Never read unrelated files to manufacture evidence.
5. Run `pilot.check` for coverage, staleness, attachment integrity and incomplete tasks. Evidence presence does not mark criteria met.
6. Use `review.propose` for your assessment or recommended proceed/hold/stop outcome. Identify yourself as the agent. Proposals are internal, snapshot-bound and never count as reviewed approval. Do not call `review.record` or `decision.record` to impersonate a human. Those CLI actions are only for a deliberate human-entered review and still are not authenticated customer sign-off.
7. Ask the human to inspect proposals and current evidence in `ui --workspace PATH`, then record the review themselves. Changed inputs require re-review.
8. Export `pilot.export` as customer `handover`, `manifest` or `deckforge`. Inspect shared free text and file contents before distribution: record visibility is filtering, not semantic secret redaction. Use `--output PATH` to save bytes without overwriting an existing artifact.

## Recover without hiding uncertainty

On conflict, reload the pilot and preserve unrelated changes. Do not delete reviewed criteria or edit immutable review history. Archive reversibly instead of clearing work. Request a full private backup with `format:"backup", includePrivate:true`; it contains internal records and attachment bytes. Preview `pilot.restore` before `confirm:true` replacement.

Supply the restore preview's `previewToken` with the same backup, pilot and revision, `dryRun:false` and `confirm:true` within ten minutes. Retain the recovery backup.

Local storage is not encrypted or multi-user authenticated. MCP is bound to the configured workspace. A clear customer export is not a whole-workspace approval, and neither an agent proposal nor a historical decision resolves unmet gates.
