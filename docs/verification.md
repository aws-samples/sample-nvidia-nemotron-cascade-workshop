# Three-tier example verification

Verified on **2026-09-23, America/Los_Angeles**, using fresh exports of the
uncommitted public source. The final candidate passed the checks below after
initial failures were corrected. This is local execution evidence, not a
production certification or a new model-accuracy evaluation.

**Publication follow-up:** the implementation was published as
[commit 2311904](https://github.com/aws-samples/sample-nvidia-nemotron-cascade-workshop/commit/2311904)
on the [push-mcp branch](https://github.com/aws-samples/sample-nvidia-nemotron-cascade-workshop/tree/push-mcp).
A clean checkout of that commit passed installation, the offline audit, all
88 tests, typecheck and build on **Node.js 24.21.0**. A separate fresh clone
from GitHub matched the tested commit and passed `npm ci`, the public audit,
and both MCP configurations (repository-root and absolute-path/outside-root).
These additional checks used no provider credentials or new model calls.
`.nvmrc` now selects Node.js 24, and the README includes the branch-specific
clone command. The detailed export verification below remains a dated record.

During the initial export verification, the public repository's `push-mcp` branch still pointed
to `68cdc943cda441718e80bae02c8b03961198728f` and did **not** contain the Jev
extension. These checks cover the local publication candidate; cloning the
public branch did not yet provide this update.

## Source and environment

The initial export contained 84 files; the revised candidate contained 86.
Each was copied into a new temporary directory from tracked and non-ignored
untracked working-tree files. Both began without `.git`, private environment
files, model caches, installed dependencies, build output, or internal drafts.
Only the public `.env.example` was included.

The private capture index retains the Git base and dirty status, exact file
inventories and SHA-256 hashes, exclusions, credential-presence booleans,
commands, stdout/stderr, exit codes, timings, HTTP bodies, browser captures,
and source deltas. Original failed captures remain alongside successful
rechecks. Raw logs and machine-specific paths are excluded from this public
summary. A final test-only correction and subsequent reporting-only updates
are recorded separately from the original export inventories.

Tested: **macOS arm64, Node.js 25.2.1, npm 11.6.2**. The final lockfile installed
Next.js **16.3.6**, Vitest **4.1.11**, Sharp **0.35.4**, and MCP SDK **1.30.0**.
The declared Node range is `^22.13.0 || >=24.0.0`; **Node 22 and other operating
systems were not executed** in this run.

## Clean-reader checks

Except for the separately recorded live calls below, subprocesses used an
environment allowlist, empty temporary home and AWS configuration/credential
files, disabled instance metadata, and no provider keys or tokens. Each
installation also used a fresh npm cache and empty npm configuration files.

| Check | Final result |
|---|---|
| `npm ci` | Passed from the lockfile in a fresh directory |
| `npm audit --json` | Exit 0; zero reported vulnerabilities at check time |
| `npm run audit:three-tier` | Passed for 150 public records without credentials or private caches |
| `npm test` | 88 tests passed across nine files; provider behavior here is mocked |
| `npm run typecheck` | Passed |
| `npm run build` | Passed with Next.js 16.3.6 |
| `npm start` and `npm run dev` | Real local servers started and served the existing routes |
| HTTP/UI readiness | `/`, `/bulk`, `/review`, JavaScript/CSS assets, 20 sample tickets, and completed 150-item review data loaded |
| Browser interactions | Sample selection updated the form; bulk sample loading displayed 20 rows; completed review controls remained read-only |
| HTTP validation/errors | Invalid baseline/cascade input returned JSON 400; absent AWS credentials produced the baseline error and cascade SSE error; production review writes returned 403 |
| MCP outside the repository | Explicit `--tsconfig` configuration initialized over real stdio and listed both tools |
| MCP errors | Invalid tickets/labels, absent Gateway key, and absent AWS credentials returned errors |
| CLI usage/errors | Help/no arguments exited 0; example/file/stdin without a key, malformed JSON, invalid schema/tier, missing file, and empty stdin exited 1 with expected errors |
| Cache-dependent comparison commands | Stopped with missing-cache errors without provider calls |
| Source/documentation | Relative links resolved; 13 public reference URLs returned HTTP 200; model IDs remained centralized; both corrected MCP configurations agreed |

The bounded source scan found no matching key literals, private service URLs,
or machine-specific paths. It cannot detect every possible secret format.
Zero npm advisories describes the registry response at this time. Vitest
emitted a non-blocking warning about a future Vite configuration-loader change;
current tests and typecheck passed.

## Failures corrected and rechecked

- **MCP startup:** the original command failed outside the repository with
  `Cannot find module '@/lib/triage/prompts'`, before any provider call.
  Both guides now pass an absolute `--tsconfig` path; stdio and live checks passed.
- **Node contract:** the original `>=20` manifest and “22+” guidance admitted
  incompatible dependency versions. Manifest, lockfile metadata, and guides
  now agree on the supported range above.
- **Lint:** `next lint` failed under Next.js 16. The unused script was removed;
  this verification does not claim a configured lint check.
- **Legacy cascade validation:** malformed/incomplete requests previously
  returned HTTP 500. They now return JSON 400 before model invocation, with
  seven regression cases. Valid input still follows the original Nano-first policy.
- **Dependencies:** the initial audit reported ten vulnerabilities. Compatible
  updates and the Sharp override update were followed by a new clean install,
  audit, tests, typecheck, build, and runtime smoke.
- **Test fixture:** typecheck caught missing `usage.totalTokens` in the new mock.
  A test-only correction was copied into the final export with old/new hashes
  recorded; tests, typecheck, and build then passed.

## Fresh provider execution

A separate credentialed run completed **nine successful steps on the final
dependency candidate**, supplying credentials to processes without adding them to the
export. The [sanitized live record](research/three-tier-live-verification-2026-09-23.json)
contains source hashes, commands, requests, responses, and individual timings.
Its source hashes and responses were checked against the private captures.

The steps covered MCP initialization/tool discovery; actual `jev`, `jev→nano`,
and `jev→sonnet` routes; the generic classifier's Nano and forced-Sonnet paths;
and live CLI example, JSON-file, and stdin input. An earlier successful run on
the initial dependencies is retained privately. Neither run is part of the
150-ticket benchmark.

**No live `jev→nano→sonnet` path was observed.** That branch, transient provider
failures, retries, and cancellation have mocked unit coverage. Individual smoke
timings and cost fields are not comparative benchmarks or billing reconciliation.

## Limits and skipped work

The free auditor checks arithmetic and consistency of the
[dated comparison](three-tier-results.md), including reviewed synthetic labels,
routes, preserved review signals, usage, and six strategy summaries. It does
not authenticate provider responses or establish label correctness. Historical
Bedrock responses, the exploratory Jev comparison, and this new execution
record remain distinct.

The 150-ticket live collection, optional Opus labeling, deployment, and manual
bulk exercise were not run. `/api/triage/bulk` remains the intentional workshop
task and returns 404 until implemented. Private-cache replay cannot succeed on
a fresh checkout without prior collection; the public audit can. No integration-
test platform was invoked. The initial export verification did not commit or
publish changes; the publication follow-up is described above.

## Recheck from source

```bash
npm ci
npm run audit:three-tier
npm test
npm run typecheck
npm run build
npm start
```

Use [the example guide](three-tier-example.md) for exact MCP configuration,
CLI inputs, credentials, and paid-call boundaries. When deliberately replacing
the comparison evidence, review it before refreshing its audit with
`npm run audit:three-tier -- --write`; the hash-binding test rejects a stale audit.
