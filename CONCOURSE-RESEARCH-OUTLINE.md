# Concourse Architecture Research Outline

**Purpose:** Convert the open questions in [CONCOURSE-ARCHITECTURE-EVALUATION.md](CONCOURSE-ARCHITECTURE-EVALUATION.md) into evidence-backed decisions that can be used to author implementation-ready `SPEC-INSTRUCTION.md` files.  
**Audience:** Technical leadership, researchers, and future spec authors.  
**Status:** Research program — no implementation authorized by this document.  
**Last updated:** 2026-08-03

---

## 1. How to use this outline

This is a decision pipeline, not a product backlog. Each research workstream must finish with evidence, a decision, and explicit inputs for a subsequent specification. A spec should not inherit unresolved assumptions disguised as design.

Use this sequence for every workstream:

1. State the stakeholder decision the research must enable.
2. Establish the current repository and product baseline.
3. Gather primary-source documentation and reproducible experimental evidence.
4. Compare the viable options against declared criteria.
5. Record the decision, rejected alternatives, limitations, and date.
6. Translate the decision into a spec seed: Job Story, scope boundary, contracts, examples, failure cases, non-functional requirements, and acceptance evidence.

The downstream specification pipeline remains:

> Job Story → Impact/Boundary Map → Example Map → BDD Scenarios → EARS Requirements → Test Strategy → Agent Execution

### Research evidence standard

Every finding should identify:

- the question answered;
- source or experiment identifier;
- product, provider, model, version, configuration, and date where applicable;
- observation versus interpretation;
- confidence level: `confirmed`, `probable`, `inconclusive`, or `disproved`;
- limitations and conditions under which the finding may no longer hold;
- the architecture or spec decision affected.

Current product documentation is evidence only for the dated product surface. Runtime claims should be verified with captured fixtures or a reproducible spike. Marketing statements are context, not acceptance evidence.

## 2. Research program map

| ID | Workstream | Decision produced | Primary spec seed | Dependency |
| --- | --- | --- | --- | --- |
| R1 | Provider-neutral engine contract | What Concourse normalizes and what adapters retain | Agent engine and event contract | None |
| R2 | Codex second-backend feasibility | Which Codex interface Concourse supports first | Codex engine adapter | R1 draft contract |
| R3 | Claude runtime and v0.2 approvals | Whether CLI, Agent SDK, or hybrid remains the Claude path | Claude SDK engine and approvals | R1 draft contract |
| R4 | Read-only antagonist boundary | What “cannot hold the pen” means operationally | Antagonist security profile | R1; security baseline |
| R5 | Antagonist quality and authority | Where coaching ends and blocking begins | Antagonist verdict and governance | R4 |
| R6 | Evidence integrity and telemetry | What constitutes authoritative audit and cost evidence | Evidence and telemetry subsystem | R1; R4 |
| R7 | Relay ReAct and baton protocol | Whether and when relay orchestration is beneficial | Relay orchestration | R1; R5; R6 |
| R8 | StructureView delivery surface | Whether browser-hosted StructureView can replace Electron | StructureView browser-host integration | R1 interface boundary |
| R9 | Commercial model and procurement | How seats, credits, APIs, and cloud billing are governed | Provider configuration and spend controls | R2; R3; R6 |
| R10 | Business-user experience | Which states, approvals, and evidence are legible to the target audience | Concourse front-door UX | R1; R3; R8 |

### Recommended order

Run R1 first. R2 and R3 may then run in parallel. R4 and R6 can begin once the draft engine contract identifies tool, permission, identity, and event boundaries. R5 follows the security boundary. R7 follows the verdict and telemetry contracts. R8 and R10 should share user research but produce separate architectural and experience decisions. R9 should use measured telemetry shapes from R6 rather than inventing a cost model in isolation.

## 3. R1 — Provider-neutral agent engine contract

### Decision to enable

Define the smallest stable Concourse contract that can support Claude and Codex without reducing either runtime to a lowest-common-denominator chat API.

### Research questions

- Which current `CliEngine` responsibilities belong to the engine contract, Claude adapter, host, state reducer, or UI?
- Which normalized events are genuinely provider-neutral: session lifecycle, narration, tool activity, approvals, artifacts, usage, errors, and completion?
- Which provider-native details must remain attached for diagnosis, replay, compliance, and cost reconciliation?
- How do cancellation, resumption, multi-turn state, concurrent tools, partial messages, and unavailable capabilities differ?
- How should capability discovery work when an adapter lacks approvals, native multi-turn, structured output, or usage fields?
- What is the compatibility and versioning policy for fixtures, raw events, normalized events, and persisted sessions?
- Can a session safely change provider, or must cross-provider continuation always use a structured baton?

### Evidence and activities

- Map every exported runtime function and state transition in `host.mjs` to its current responsibility.
- Catalogue the Claude fixture fields currently consumed, retained, or discarded.
- Build paper mappings from current official Claude and Codex event/protocol documentation.
- Capture one read-only and one read/write fixture from each candidate runtime during the adapter spikes; do not use repeated live calls for parser tests.
- Perform a gap analysis against approvals, cancellation, failures, tool concurrency, usage, and session continuation.
- Draft the contract and attempt both provider mappings before accepting it.

### Exit criteria

- A field-level event mapping exists for Claude and Codex, including unsupported and lossy mappings.
- Provider-native raw events and identifiers have an explicit retention rule.
- Capability negotiation and contract versioning are decided.
- Session continuation and cross-provider handoff rules are decided.
- At least one failure, cancellation, approval, and concurrent-tool example can be represented without provider-specific logic leaking into the UI reducer.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-agent-engine-contract.md`

- **Job Story:** When Concourse adds or updates an agent provider, I want one stable host contract that preserves provider-specific evidence, so the product can change providers without rewriting its user experience or hiding important behavioral differences.
- **In scope:** engine lifecycle, capabilities, normalized event schema, raw-event envelope, cancellation, session identity, usage envelope, error taxonomy, fixture contract, compatibility policy.
- **Out of scope:** provider authentication UI, antagonist policy, relay scheduling, provider pricing.
- **Required examples:** adapter with full approvals; adapter without approvals; partial narration; concurrent tools; provider error; unknown event; missing usage; resume; cross-provider handoff rejection.

## 4. R2 — Codex as the second backend

### Decision to enable

Choose the first supported Codex integration surface and establish whether it can meet Concourse's local rich-client, approval, evidence, and business-user requirements.

### Research questions

- Does Codex app-server over local stdio provide the required authentication, streamed events, approvals, history, cancellation, and resumption?
- Which parts of app-server are stable, experimental, or unsuitable for production at the time of implementation?
- When are the Codex SDK or `codex exec --json` better choices than app-server?
- How do Codex sandbox and approval semantics map to Concourse states without misrepresenting their strength?
- Can ChatGPT-managed authentication and API-key authentication both be supported without leaking credentials into the hosted workspace?
- Which Codex features require OpenAI-hosted services and which remain available with alternate supported providers such as Amazon Bedrock?
- What must administrators configure or prohibit for a managed business deployment?

### Evidence and activities

- Recheck current official Codex app-server, SDK, non-interactive, authentication, sandbox, and pricing documentation on the day of the spike.
- Build a disposable read-only protocol probe outside production code.
- Capture raw traces for startup, authentication failure, narration, tool use, approval, denial, cancellation, completion, and resume.
- Compare app-server, SDK, and `codex exec --json` using the R1 contract and a weighted decision matrix.
- Document Windows-native and WSL behavior separately if both are candidate deployment environments.

### Exit criteria

- The preferred Codex interface and fallback are selected with dated rationale.
- Transport, authentication, process lifecycle, and upgrade strategy are decided.
- All required R1 events are mapped or explicitly declared unsupported.
- Experimental features have a containment or deferral decision.
- A no-credential-in-workspace threat review is complete.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-codex-engine-adapter.md`

- **Job Story:** When my organization cannot depend exclusively on Claude Code, I want Concourse to run Codex through its native agent interface, so I retain an independent supported coding-agent path without losing approvals or evidence.
- **In scope:** selected Codex interface, process/transport, authentication boundary, event adapter, capabilities, fixtures, cancellation, resume, health check, failure behavior.
- **Out of scope:** generic model gateway, relay behavior, UX redesign, procurement policy.
- **Required examples:** unavailable Codex binary; expired authentication; approval allow/deny; sandbox denial; interrupted turn; successful resume; missing optional telemetry; protocol-version mismatch.

## 5. R3 — Claude runtime and interactive approvals

### Decision to enable

Decide whether Claude CLI, Claude Agent SDK, or a deliberately limited combination becomes the supported Claude runtime after v0.1.

### Research questions

- What are the current Agent SDK package, query interface, permission callback, event shapes, session semantics, and configuration inheritance?
- What capabilities are lost or changed when moving from CLI to SDK?
- Is a hybrid operationally defensible, or does it create two inconsistent permission and session systems?
- How are skills, MCP configuration, project instructions, memory, and subagents inherited or isolated?
- Which permission denials remove a tool versus merely require approval?
- Can writes be constrained to the workspace independently of Concourse's read/download `WorkspaceFs`?

### Evidence and activities

- Refresh `V0.2-FINDINGS.md` against current primary documentation and source where necessary.
- Capture equivalent CLI and SDK traces using the R1 scenarios.
- Test permission precedence and negative cases rather than inferring them from option names.
- Trace all inherited configuration and memory paths under a disposable user profile.
- Compare operational complexity, debuggability, compatibility, and update risk.

### Exit criteria

- CLI, SDK, or hybrid is selected and the non-selected paths have recorded reasons.
- Approval and permission semantics are demonstrated with negative tests.
- Memory, skills, MCP, and configuration inheritance are explicitly governed.
- The debug/fallback path and version-compatibility policy are decided.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-claude-sdk-engine-and-approvals.md`

- **Job Story:** When a business user asks an agent to act on local documents, I want Concourse to pause on consequential actions using verified Claude permission semantics, so the user can give informed approval without entering a terminal.
- **In scope:** chosen runtime, callback translation, approval lifecycle, timeout/cancellation, configuration inheritance, fixtures, fallback path.
- **Out of scope:** antagonist permissions, generic provider contract already owned by R1, multi-agent mesh.

## 6. R4 — Read-only antagonist security boundary

### Decision to enable

Define the assurance level and technical controls required before Concourse may claim that an antagonist “cannot hold the pen.”

### Research questions

- What assets must the antagonist never modify: workspace, Git state, test definitions, rubric, checker configuration, transcript, meter, identity, and external systems?
- Is the target a provider tool-policy boundary, operating-system containment, separate process/account, or a combination?
- Which built-in, MCP, plugin, skill, network, scheduled, and subagent paths can cause writes indirectly?
- What read-only credentials and external-service permissions are available?
- How are prompt injection, symlink/junction escape, subprocesses, environment variables, and credential discovery handled?
- What assurance language is supportable for local personal use versus regulated enterprise use?

### Evidence and activities

- Create an asset/threat/actor boundary diagram.
- Catalogue every callable capability for each supported adapter and classify direct and indirect mutation paths.
- Build an abuse-case matrix covering filesystem, process, network, provider, MCP, and human approval paths.
- Run negative tests in a disposable workspace and external test accounts.
- Review whether authoritative artifacts require separate credentials, storage, or service ownership.
- Define claim language for each tested assurance level.

### Exit criteria

- Protected assets and trusted computing boundary are explicit.
- Every known mutation path is denied, contained, approved, or documented as residual risk.
- A reproducible read-only escape test suite and expected audit events are specified.
- Separate-credential and process-isolation decisions are made.
- Product wording does not claim stronger isolation than tests establish.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-read-only-antagonist-profile.md`

- **Job Story:** When an antagonist evaluates work produced under delivery pressure, I want it technically unable to change the artifact or its quality standard, so its verdict remains independent and reviewable.
- **In scope:** denied capabilities, credentials, containment, immutable authority surfaces, violation events, startup attestation, escape tests, residual-risk disclosure.
- **Out of scope:** verdict rubric quality, automatic blocking policy, relay rotation.
- **Required examples:** direct write; shell write; MCP write; subagent mutation; symlink escape; network-side mutation; rubric modification; transcript modification; unavailable containment; attempted violation.

## 7. R5 — Antagonist quality, coaching, and authority

### Decision to enable

Determine whether the antagonist improves outcomes, when provider diversity helps, and which findings may advise, request rework, or block.

### Research questions

- Does continuous coaching outperform end-of-task review or deterministic gates alone?
- How are defect discovery, false positives, false blocks, rework, review time, and user trust measured?
- Does using a different provider or model family reduce correlated misses enough to justify cost and latency?
- How should deterministic findings, rubric-based model judgments, and human decisions be displayed and recorded separately?
- What evidence must accompany a verdict?
- Who owns the rubric and may approve changes to it?
- Which deterministic policies, if any, are eligible for automatic blocking?

### Evidence and activities

- Assemble a blinded benchmark set with known defects, acceptable variants, and ambiguous cases.
- Compare deterministic-only, same-model judge, different-model judge, and human-review baselines.
- Randomize presentation and record adjudicated ground truth where feasible.
- Conduct qualitative sessions with builders and quality owners to assess coaching usefulness.
- Define escalation, override, appeal, and rubric-change workflows.

### Exit criteria

- Success and harm metrics have thresholds agreed before evaluation.
- Same-provider and diverse-provider results are reported with confidence and limitations.
- Deterministic and subjective authority levels are decided.
- Override, appeal, and rubric ownership are explicit.
- No automatic block depends solely on an uncalibrated LLM verdict.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-antagonist-verdict-and-coaching.md`

- **Job Story:** When an agent's work does not yet meet an agreed standard, I want evidence-linked coaching early enough to act, so quality improves without giving the evaluator permission to rewrite the work or silently block delivery.
- **In scope:** finding schema, verdict levels, evidence links, coaching turns, authority rules, override/appeal, rubric version, UI distinctions, evaluation metrics.
- **Out of scope:** containment controls owned by R4, deterministic checker implementation, relay scheduling.

## 8. R6 — Evidence integrity, telemetry, and cost measurement

### Decision to enable

Define the authoritative record for actions, verdicts, handoffs, usage, and cost, including the assurance required beyond local append-only JSONL.

### Research questions

- Which events are required to reconstruct a task and establish who or what acted?
- What identity is available for user, host, provider account, model, agent role, tool, and artifact revision?
- Is local JSONL sufficient for the target use case, or are hashing, signing, remote append-only storage, WORM retention, and independent custody required?
- How are gaps, duplicates, reordering, clock skew, and partial writes detected?
- Which provider usage and cost fields are reported, estimated, or unavailable?
- How are subscription allowance consumption, purchased credits, direct API charges, and cloud-provider charges represented without inventing false precision?
- What data classification, redaction, retention, export, and legal-hold rules apply?

### Evidence and activities

- Define audit and telemetry event inventories separately, then identify the intentional overlap.
- Threat-model transcript alteration, deletion, identity spoofing, replay, and meter tampering.
- Compare local append-only, hash-chained local, remote log service, and immutable-object-storage options.
- Reconcile sample provider usage records to invoices or administrative usage reports.
- Define missing-data and estimation semantics.
- Review applicable organizational recordkeeping requirements with the accountable compliance owner; do not infer compliance from architecture alone.

### Exit criteria

- Evidence assurance tiers are defined with supportable claims.
- Canonical event identity, ordering, integrity, and retention rules are decided.
- Provider-neutral usage/cost schema preserves raw provider fields and estimation status.
- Reconciliation and missing-event behavior are specified.
- Sensitive-data and access-control decisions have named owners.

### Spec seeds produced

**Suggested files:**

- `SPEC-INSTRUCTION-evidence-integrity-and-retention.md`
- `SPEC-INSTRUCTION-provider-usage-and-cost-telemetry.md`

Split these if regulatory evidence and operational telemetry have different owners, storage, or retention rules. Do not combine them merely because `TranscriptSink` currently receives both event types.

## 9. R7 — Relay ReAct, baton, and context-rot measurement

### Decision to enable

Determine whether relay orchestration produces a measurable advantage, define the canonical baton, and select safe launch and retirement conditions.

### Research questions

- Which task classes exhibit meaningful degradation in one long context?
- What baseline should relay beat: success, defect rate, cost, latency, human rework, or a weighted objective?
- What exact state crosses the handoff, and how is completeness verified?
- Where do the durable goal and plan live, and who may update them?
- What triggers a successor: explicit checkpoint, token/load estimate, quality signal, step count, or combination?
- How much overlap is required, and what proves the receiver has accepted the baton before the sender stops?
- How are loops, conflicting updates, duplicate actions, abandoned tools, and failed handoffs handled?
- Can a context-occupancy soft sensor predict quality degradation well enough to justify automated triggers?

### Evidence and activities

- Define a structured baton candidate before conducting relay comparisons.
- Select short, medium, and genuinely long tasks across multiple task classes.
- Compare single-context and relay variants using fixed models, prompts, tools, and scoring.
- Record input/cache/output usage, duration, handoff overhead, success, defects, rework, and baton omissions.
- Repeat on model changes to measure drift.
- Test corrupted, incomplete, stale, conflicting, and unacknowledged batons.

### Exit criteria

- The baton schema, validation, ownership, and versioning are decided.
- A durable plan store and concurrency rule are selected.
- Relay beats the declared baseline for at least one identified task class or is explicitly deferred.
- Trigger and overlap policies are supported by data, with a manual checkpoint fallback.
- Baton-drop rate and abort/recovery behavior are defined.

### Spec seeds produced

**Suggested files:**

- `SPEC-INSTRUCTION-relay-baton-and-plan-store.md`
- `SPEC-INSTRUCTION-relay-orchestration-and-triggers.md`

The baton/store contract should precede automated orchestration. If research does not show a benefit, preserve manual structured handoff and do not spec automated relay rotation.

## 10. R8 — StructureView browser-host delivery

### Decision to enable

Determine whether StructureView should remain Electron, move to a Concourse-style local host plus browser, or support both during a transition.

### Research questions

- Which current Electron capabilities are actually used: windowing, file associations, filesystem access, PTY, offline launch, updates, clipboard, notifications, and OS integration?
- Which capabilities disappear, weaken, or require a local service in a browser-host design?
- What are the enterprise browser, localhost, firewall, certificate, and software-distribution constraints?
- Can the reader remain useful when no agent runtime is installed or authenticated?
- Should StructureView consume Concourse through a contract, share a host process, or remain separately deployable?
- What is the migration, rollback, and coexistence strategy?

### Evidence and activities

- Inventory Electron APIs and trace them to user-visible jobs.
- Build a non-production reader spike using representative large and complex documents.
- Test startup, offline behavior, file opening, accessibility, browser compatibility, updates, and failure recovery.
- Conduct task-based comparison sessions with current target users.
- Review packaging and support implications with endpoint-management owners.

### Exit criteria

- Electron capabilities are classified as required, replaceable, or unused.
- The target deployment architecture and transition strategy are selected.
- Reader/runtime independence and failure behavior are explicit.
- Business-user completion and accessibility results meet declared thresholds.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-structureview-browser-host.md`

- **Job Story:** When I need to read and evaluate structured documents, I want StructureView to launch predictably without requiring terminal knowledge, so I can work independently of the selected coding-agent provider.
- **In scope:** chosen host/surface architecture, file-open flow, offline behavior, accessibility, update/distribution model, runtime boundary, migration and rollback.
- **Out of scope:** provider adapter internals and antagonist policy.

## 11. R9 — Commercial model, spend controls, and procurement

### Decision to enable

Choose supported commercial paths and governance controls without assuming Concourse or its providers are exclusively consumption-based.

### Research questions

- Which user groups need subscription seats, API automation, cloud-provider inference, or a combination?
- What usage is included, rate-limited, credit-funded, or separately invoiced under the organization's actual agreements?
- Which administrative limits, analytics, data controls, and audit exports exist for each path?
- How are shared subscription allowances attributed when providers do not expose per-turn currency cost?
- Which workloads require predictable caps versus elastic throughput?
- What are the costs of support, deployment, evidence storage, security, and model/provider reevaluation?
- What exit and portability conditions must be included in procurement decisions?

### Evidence and activities

- Build dated commercial profiles from official sources and actual organizational quotes.
- Map personas and workload classes to eligible authentication and billing paths.
- Run representative workloads and reconcile R6 telemetry against administrative records or invoices.
- Model base, expected, and stress cases without presenting estimates as guarantees.
- Review contract terms for data use, retention, regional processing, support, and termination/export.

### Exit criteria

- Supported commercial paths and persona/workload routing are selected.
- Spend limits, alerts, owners, and exception process are explicit.
- Cost estimates include internal operation and evidence retention.
- Unknown or non-attributable subscription usage is visibly treated as such.
- Procurement has dated revalidation triggers for price, entitlement, and model changes.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-provider-configuration-and-spend-controls.md`

- **Job Story:** When I fund Concourse for multiple business roles, I want predictable guardrails and attributable usage across supported providers, so the organization can benefit from agent work without an uncontrolled or misleading cost model.
- **In scope:** provider/auth profiles, billing-source metadata, budgets, alerts, caps, administrative ownership, workload routing, price-version metadata.
- **Out of scope:** negotiating vendor contracts, hardcoded model prices, outcome telemetry already owned by R6.

## 12. R10 — Business-user state, approvals, and trust

### Decision to enable

Define the minimum interface that lets a non-engineer understand agent state, make consequential approvals, inspect evidence, and recover from failure without terminal vocabulary.

### Research questions

- Which business roles and tasks are in the first supported cohort?
- What information is required to understand progress without exposing implementation noise?
- What does a user need to know before approving read, write, external-service, network, or execution actions?
- How should deterministic findings, antagonist opinions, uncertainty, and human decisions differ visually and linguistically?
- Which raw evidence must remain reachable, and at what disclosure depth?
- How should cost and context pressure be expressed without requiring token literacy?
- What recovery actions are understandable when an adapter, permission, transcript, or task fails?

### Evidence and activities

- Conduct job interviews or observed task sessions with product, design, quality, and business stakeholders.
- Test state and approval prototypes using realistic consequential scenarios, not preference surveys alone.
- Measure task completion, incorrect approvals, time to understand, assistance requests, and confidence calibration.
- Include accessibility and plain-language review.
- Compare provider-specific behavior behind the same normalized state surface.

### Exit criteria

- First-cohort personas and supported jobs are explicit.
- Required states, approval content, evidence disclosures, and recovery actions are validated.
- Plain-language and accessibility thresholds are met.
- The interface does not imply certainty or containment beyond the underlying runtime.

### Spec seed produced

**Suggested file:** `SPEC-INSTRUCTION-concourse-business-user-control-surface.md`

- **Job Story:** When I direct an agent without being a terminal user, I want to understand what it is doing and approve consequential actions with enough context, so I remain accountable without needing developer tools or vocabulary.
- **In scope:** status model presentation, approval content, evidence disclosure, provider capability differences, recovery flows, accessibility, outcome and cost summaries.
- **Out of scope:** adapter protocol implementation, security-policy definition, StructureView reader architecture.

## 13. Cross-workstream research artifacts

Maintain these artifacts once, with named ownership, instead of recreating them inside each study:

| Artifact | Purpose |
| --- | --- |
| Research register | Question, owner, status, dependency, evidence links, decision, and revalidation date |
| Source register | Dated primary sources, versions, access date, supported claim, and volatility |
| Experiment catalogue | Reproducible setup, fixture/task ID, variables, measures, results, and limitations |
| Provider capability matrix | Claude/Codex support and semantic differences against the R1 contract |
| Threat and abuse-case register | Protected asset, actor, attack path, control, test, residual risk, and owner |
| Decision log | Append-only material choices, options, rationale, evidence, date, and reversal history |
| Glossary | Stable definitions for builder, antagonist, deterministic gate, verdict, baton, leg, session, evidence, and cost source |
| Claim register | Product claims such as “read-only,” “tamper-evident,” or “lower cost,” with required evidence and approved wording |

## 14. Gate for authoring a `SPEC-INSTRUCTION.md`

A workstream is ready to become a specification only when all applicable boxes are checked:

- [ ] The stakeholder Job Story and measurable outcome are agreed.
- [ ] Current state is verified against the repository or deployed system.
- [ ] Primary-source product claims are dated and linked.
- [ ] At least two viable options were compared, or the absence of alternatives is evidenced.
- [ ] Security, identity, data, and permission boundaries are explicit.
- [ ] Public interfaces, event/schema shapes, and ownership boundaries are decided.
- [ ] Failure, cancellation, recovery, degradation, and unsupported-capability behavior are decided.
- [ ] Observability and acceptance evidence are defined.
- [ ] Product and cost claims have measurable definitions.
- [ ] Dependencies and downstream consumers are named.
- [ ] Material decisions and rejected alternatives are recorded.
- [ ] No implementation-blocking item remains labelled “TBD,” “research later,” or “verify during coding.”

If a question changes the architecture, security boundary, public contract, acceptance test, or procurement model, it is blocking research. If it only tunes a threshold already exposed as configuration, it may be deferred with a named owner and default.

## 15. Suggested specification sequence

Author specifications in dependency order rather than as one large “Concourse v0.2” document:

1. `SPEC-INSTRUCTION-agent-engine-contract.md`
2. `SPEC-INSTRUCTION-codex-engine-adapter.md`
3. `SPEC-INSTRUCTION-claude-sdk-engine-and-approvals.md`
4. `SPEC-INSTRUCTION-read-only-antagonist-profile.md`
5. `SPEC-INSTRUCTION-evidence-integrity-and-retention.md`
6. `SPEC-INSTRUCTION-provider-usage-and-cost-telemetry.md`
7. `SPEC-INSTRUCTION-antagonist-verdict-and-coaching.md`
8. `SPEC-INSTRUCTION-relay-baton-and-plan-store.md`
9. `SPEC-INSTRUCTION-relay-orchestration-and-triggers.md`
10. `SPEC-INSTRUCTION-structureview-browser-host.md`
11. `SPEC-INSTRUCTION-provider-configuration-and-spend-controls.md`
12. `SPEC-INSTRUCTION-concourse-business-user-control-surface.md`

This order is a default, not a mandate to build every item. Research may merge, split, reorder, or stop a proposed spec. In particular, relay orchestration should be deferred if the benchmark does not demonstrate a meaningful advantage, and an Electron replacement should be deferred if the browser-host trial does not meet user and deployment needs.

## 16. First research increment

Begin with a bounded architecture increment rather than all ten workstreams:

1. Complete R1's responsibility map and draft event/capability contract.
2. Run the smallest R2 Codex app-server protocol probe and capture fixtures.
3. Refresh R3's Claude SDK and permission findings against the same contract.
4. Record the first cross-provider gaps and decide whether the R1 abstraction survives both mappings.
5. Use that decision to author `SPEC-INSTRUCTION-agent-engine-contract.md`.

This first increment tests the load-bearing provider-neutral premise before research effort is committed to the antagonist, relay, UI, and commercial layers that depend on it.
