# proofpack

Local-first pilot evidence: criteria, evidence, risks, attachments, agent proposals and a customer-safe handover, with the proceed, hold or stop call left to a human.

A pilot succeeds or fails on whether the evidence supports the success criteria the customer agreed to, and that trail usually lives in a chat thread, a slide and someone's memory. proofpack keeps it as a record. Each pilot has a charter, criteria with metric, baseline and threshold, evidence items tied to criteria, risks, decisions, a checklist and attachments verified by SHA-256. `pilot.check` reports criterion coverage, stale evidence and outstanding handover actions. Every record carries a visibility flag, and the customer export includes only what was marked customer-visible.

The part I care most about is the review boundary. An agent session can propose that a criterion is met, tied to the exact inputs it reviewed, and the proposal goes stale the moment those inputs change. Recording a criterion review or a proceed, hold or stop decision is a separate operation that an agent session cannot call. The tool makes no claim that this is authenticated sign-off. It is a deliberate, locally asserted human action, kept apart from what the agent did.

## Quick start

Node 23 or newer.

```sh
npm ci
node agent/cli.mjs commands                                   # 16 operations with input schemas
node agent/cli.mjs record schema                              # allowed fields per section
node agent/cli.mjs init --workspace /absolute/path/pilots     # explicit; never created implicitly
node agent/cli.mjs setup --workspace /absolute/path/pilots    # prints an MCP server config
node agent/cli.mjs ui --workspace /absolute/path/pilots       # optional review UI on loopback
```

Operations take JSON on `--input file.json` or stdin and answer `{ ok, data | error }`. Mutations carry the library revision and are rejected when stale. `--output` never overwrites a file. `skills/proofpack-workflow/SKILL.md` is the version an agent reads.

`npm test` runs 50 tests.

## What it produces

- A `library.json` of isolated pilots, written atomically, with archives kept.
- `pilot.export` in four formats: a customer HTML handover with a strict CSP and no scripts, an evidence manifest with attachment hashes, a [deckforge](https://github.com/ong6/deckforge) readout deck (version 1 JSON, customer-visible records only, fails loudly if text will not fit), and a private backup you have to acknowledge.
- Recovery backups before any restore replaces a pilot.

## In the suite

proofpack is one of three tools in [fieldpack](https://github.com/ong6/fieldpack). The deckforge export is the seam between them: evidence goes in here, the readout deck gets measured over there. [skillforge](https://github.com/ong6/skillforge) is where the skill that drives this workflow would be evaluated.

## More from ong6

Forges make things, packs bundle them.

- [groundplane](https://github.com/ong6/groundplane) — fails the build when an agent asserts a fact its tools never produced
- [jobforge](https://github.com/ong6/jobforge) — grades the interview plan you say out loud, not the code you submit
- [skillforge](https://github.com/ong6/skillforge) — skill discovery, versioning and baseline-aware evaluation
- [deckforge](https://github.com/ong6/deckforge) — agent-first presentation studio with a measured preflight
- [fieldpack](https://github.com/ong6/fieldpack) — deckforge, skillforge and proofpack as one local-first suite
- [skillpack](https://github.com/ong6/skillpack) — the Claude Code and Codex skills used across all of these
