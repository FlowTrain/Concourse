# Concourse, StructureView, and the Read-Only Antagonist

**Architecture evaluation for technical leadership**  
**Evaluation date:** 2026-08-03  
**Decision status:** Proceed in stages; preserve Claude support and establish Codex as an independent second runtime.

## Executive verdict

The central idea is coherent: give non-engineers a state-legible way to direct coding agents, keep document and specification work in a purpose-built reading surface, and place quality judgment in a separate lane that cannot silently repair or weaken the standard it is judging. The strongest contribution is not a new individual agent pattern; it is the combination of a non-terminal agent surface, deterministic evidence, a read-only coaching role, and an auditable handoff protocol.

The concept notes nevertheless mix shipped software, near-term designs, research hypotheses, and aspirational language. Concourse v0.1 is currently a local bridge to **Claude Code**, not yet a shared or provider-neutral runtime. Codex is a credible second coding-agent backend and a supported editor experience, but it should be integrated through a native Codex interface rather than treated as an OpenAI model behind Claude's SDK. The preferred rich-client seam is Codex app-server; the Codex SDK or `codex exec --json` are useful alternatives for narrower automation.

Concourse is also **not exclusively consumption-based**. Its own source is local software, while the model behind it may be funded through subscription seats with included limits, credits or overages, direct token-based API charges, or cloud-provider billing. Deployment, support, security, and evidence retention add internal costs regardless of the inference contract.

### Confidence summary

| Claim | Verdict | Reason |
| --- | --- | --- |
| A non-terminal surface can make coding agents usable by business roles | **Validated** | Concourse v0.1 already supplies a browser UI, state model, file surface, and streamed Claude Code loop. User-value validation is still needed. |
| Concourse is a reusable multi-provider agent runtime | **Directionally sound** | Its engine/event/state seams support the direction, but only `CliEngine` exists today and it directly spawns Claude Code. |
| StructureView should remain the document/specification surface | **Validated as product separation** | Reading, specification, and agent execution have different interaction and risk models. A common host is optional; a common product identity is not required. |
| A read-only antagonist can coach and improve a builder | **Directionally sound** | Separation of powers is strong; the claimed quality improvement still requires comparative evidence. |
| Deterministic findings should ground the antagonist | **Validated** | Tests, schemas, lint rules, and policy checks provide reproducible observations that an LLM alone cannot guarantee. |
| Relay ReAct prevents context rot and lowers long-run cost | **Unproven** | The baton and bounded-context logic are credible, but quality, cost, trigger, and handoff reliability have not been measured. |
| Append-only JSONL is an ALCOA/WORM evidence trail | **Needs correction** | It is useful local audit evidence, but lacks protected storage, identity controls, integrity proofs, retention enforcement, and independent custody. |
| `Read,Glob,Grep` as an allowlist makes an agent hard read-only | **Needs correction** | An allowlist alone is not a complete security boundary. Explicit denials and containment controls are required. |
| A host plus browser can replace StructureView's Electron shell | **Directionally sound** | It removes a bundled Chromium runtime, but launch, offline, file association, update, accessibility, and enterprise distribution need validation. |
| Concourse is all consumption-based | **Needs correction** | Both Claude Code and Codex offer multiple commercial paths; local and organizational operating costs are separate again. |

## What exists today

The repository supports the following claims as shipped Concourse v0.1 behavior:

- `CliEngine` launches `claude -p`, consumes streaming JSON, resumes sessions, and statically configures tools and permission mode.
- `normaliseEvent` translates Claude-specific traffic into internal session, narration, tool, approval-seam, error, and turn events.
- `reduceState` exposes legible states such as thinking, reading, writing, running, blocked, and done.
- Session persistence and replay metadata are stored under the configured workspace.
- `WorkspaceFs` rejects lexical and resolved path escapes, including tested symlink or junction escapes, for the host's file-list/read/download surface.
- `TranscriptSink` appends timestamped JSONL events and treats a failed audit write as a hard stop.
- `app.html` provides the non-terminal browser surface; there is no Electron dependency in Concourse.
- The turn result captures Claude-reported duration, cost, and turn count, although the current UI does not render all of that telemetry.

The following are **documented intentions or seams, not shipped capabilities**:

- `SdkEngine` and runtime approval callbacks;
- a read-only antagonist engine profile;
- multiple concurrent agents or overlapping relay legs;
- a canonical structured baton and durable shared plan store;
- provider-neutral engine selection;
- a Codex adapter;
- protected or tamper-evident evidence storage;
- calibrated context-occupancy or context-rot measurement.

This distinction matters because [CONCOURSE-AND-STRUCTUREVIEW.md](../CONCOURSE-AND-STRUCTUREVIEW.md) describes Concourse as a shared agent runtime and implies the agent runtime is already available to StructureView. That is a valid target architecture, not a description of current provider coverage. Similarly, [RELAY-REACT-ANTAGONIST.md](../RELAY-REACT-ANTAGONIST.md) says the components have already shipped; the repository provides useful foundations, but not the relay or antagonist orchestration itself.

## Concept evaluation

### 1. Non-terminal access for business users

The problem statement is credible. A terminal exposes incidental machinery—shell syntax, current directory, raw logs, and permission prompts—rather than the state a product manager, risk owner, or subject-matter expert needs. Concourse's “surface state” approach is the right abstraction: show what the agent is doing, which artifacts it used or changed, what decision is needed, and whether the task completed.

The surface should not pretend the agent is a deterministic business application. It must preserve approvals, provenance, uncertainty, and a route to raw evidence. Success should be measured with representative non-engineers completing real tasks without terminal assistance, not merely by whether the browser UI launches.

### 2. Concourse as an agent runtime

The current internal normalization seam is the most reusable part of Concourse. It can become a provider-neutral boundary if the application depends on an `AgentEngine` contract rather than Claude event shapes. Each provider adapter should own authentication, session continuation, approvals, cancellation, and raw protocol translation. The normalized layer should retain provider-native identifiers and telemetry rather than discarding them in pursuit of a falsely universal schema.

The recommended adapter set is:

1. Preserve the existing Claude CLI adapter as a working and diagnosable path.
2. Add the Claude Agent SDK adapter when interactive approval behavior is required.
3. Spike **Codex app-server** as the second rich-client backend. OpenAI documents app-server as the interface for rich clients, including authentication, conversation history, approvals, and streamed agent events. It is explicitly a better match than treating Codex as a raw chat-completions model. The app-server WebSocket transport is currently documented as experimental for production, so stdio should be the initial local transport and production support must be rechecked at implementation time.[^openai-app-server]
4. Use the Codex SDK or `codex exec --json` for batch jobs, CI, and a smaller proof of event normalization.[^openai-sdk][^openai-exec]

This makes Codex a genuinely independent runtime and reduces vendor lock-in at the orchestration layer. It does not make Claude and Codex behavior identical, and the UI should not erase meaningful differences in approval, sandbox, tool, or session semantics.

### 3. StructureView's role

StructureView should remain provider-independent and centered on reading, navigation, specification templates, evidence links, and review. It may consume Concourse's runtime through a stable boundary, but it should not become a Claude-specific shell or inherit terminal concepts merely because the first runtime is Claude Code.

A Concourse-style local host plus browser UI is a reasonable Electron replacement candidate. The claim remains a product experiment until it covers launch behavior, local/offline operation, authentication, file associations, updates, accessibility, browser policy, and enterprise distribution. “No bundled Chromium” is a packaging advantage, not by itself a complete desktop strategy.

### 4. Antagonist: coach, arbiter, and quality challenger

[PAPER-ONE-antagonist-read-only.md](../structureview/structureview/docs/PAPER-ONE-antagonist-read-only.md) makes the strongest conceptual argument: the evaluator should not be able to rewrite the artifact, the test, or the standard to make its own verdict pass. That separation is valuable even without proving every causal or economic claim in the paper.

The antagonist should be **advisory by default**. It can explain findings, identify evidence, propose a correction, and request another builder turn. Only deterministic policy violations should block automatically, and only when an explicit governance rule grants that authority. Subjective LLM judgments should be review inputs rather than invisible release gates.

Using a different model family or provider for the antagonist is advisable when the risk justifies the extra cost. Diversity can reduce correlated blind spots and gives a practical hedge against provider-specific failure. It does not create objectivity: two models may share training artifacts, prompt assumptions, missing evidence, or incentives. Provider diversity is a control, not a proof.

### 5. Deterministic evidence and Signalman

The proposed relationship is sound: Signalman or equivalent checks produce observations; the antagonist interprets them against the specification; the builder decides or acts within its authorized lane. Deterministic failures should remain distinguishable from model opinions in both the UI and audit record.

Every finding should carry the check identifier and version, artifact identity, location, observed value, expected rule, timestamp, and evidence pointer. The model's coaching should reference those fields instead of restating an untraceable summary. This also permits re-evaluation after a tool or rubric changes.

### 6. Relay ReAct and context management

The structured-baton idea is stronger than a prose handoff. At minimum, the baton needs the goal, current plan, completed and remaining work, decisions and rationale, unresolved questions, constraints, artifact revisions, evidence pointers, and verification status. A receiving leg should acknowledge and validate the baton before the prior leg stops. The durable goal and plan must live outside every agent's context.

The proposed context meter, onset band, overlap trigger, and baton-drop rate are research hypotheses. Token counts estimate traffic, not cognitive degradation. “Context rot” is likely task-, model-, prompt-, and position-dependent. A soft sensor can be useful only after it is calibrated against outcome measures and versioned with the model and harness.

The cost claim also requires qualification. Transformer attention complexity does not translate directly into the customer's invoice, and providers use caching, batching, optimized kernels, hidden orchestration, and differing rate structures. Bounded legs may reduce repeated context, but overlap and reconstruction add cost and latency. The expected cost curve must be measured rather than asserted to be near-flat.

### 7. Evidence and separation of powers

Concourse's JSONL transcript is an appropriate v0.1 audit substrate: it is chronological, append-oriented, and tested to fail closed on write errors. It is not automatically WORM, tamper-evident, or ALCOA-compliant. A process or user with filesystem access can alter or remove local files.

A governed evidence design additionally needs authenticated actor and runtime identity, sequence or content hashes, protected remote or immutable storage, access separation, clock policy, retention and legal-hold rules, export and reconciliation, schema/version history, and detection of missing events. The builder must not possess credentials that can rewrite its meter, rubric, deterministic results, or authoritative transcript.

## Read-only boundary: required correction

[CONCOURSE-AND-STRUCTUREVIEW.md](../CONCOURSE-AND-STRUCTUREVIEW.md) recommends `Read,Glob,Grep` as an allowlist and calls the result physically read-only. [RELAY-REACT-ANTAGONIST.md](../RELAY-REACT-ANTAGONIST.md) and the repository's [V0.2-FINDINGS.md](V0.2-FINDINGS.md) later correct this to explicit denials. The later correction should govern the design.

A defensible antagonist profile requires layered controls:

- explicitly deny write, edit, notebook-edit, and shell tools, and deny equivalent MCP or custom tools;
- use the provider's most restrictive non-interactive permission mode;
- give the antagonist read-only credentials to repositories, evidence stores, ticket systems, and other services;
- isolate the filesystem or process when the operating risk warrants it;
- prevent the antagonist from changing its rubric, deterministic checks, meter, transcript, or authorization policy;
- log permission decisions and attempted violations;
- run negative tests that attempt direct writes, shell writes, path traversal, symlink escape, subprocess execution, MCP writes, network exfiltration, and instruction-based privilege escalation.

Tool configuration is necessary but not equivalent to an operating-system security boundary. The strength of the “cannot hold the pen” claim must match the containment actually deployed.

## Codex as the second supported LLM and code editor

**Recommendation: yes.** Codex provides distinct local surfaces—CLI, IDE extension, desktop app, SDK/non-interactive execution, and app-server—and can therefore serve both as an alternative coding environment and as a second Concourse backend.[^openai-surfaces] This is materially better lock-in protection than exposing another model through a Claude-oriented generic endpoint, because it preserves an independent agent runtime, authentication path, sandbox, approvals, and tools.

The integration should not promise perfect portability. Keep prompts, rubrics, baton schemas, deterministic evidence, and normalized business states portable; keep provider session IDs, raw events, permission details, usage, and diagnostics provider-specific and retained. Re-evaluate app-server protocol maturity before production adoption.

## Commercial model and total cost

Concourse's local Node/HTML code has no per-use vendor fee in this repository. That does not make the operated product free, and model inference is not exclusively pay-per-token.

| Cost layer | Examples | Cost behavior |
| --- | --- | --- |
| Local product | Concourse and StructureView code, workstation runtime | Software ownership, packaging, updates, and support; not inherently metered per token |
| Organizational operation | deployment, help desk, security review, observability, evidence storage | Mostly fixed and staffing costs, sometimes service consumption |
| Subscription access | Claude or ChatGPT/Codex seats | Recurring seat price with included or rate-limited usage |
| Extension usage | credits, extra usage, overages | Consumption after or alongside included limits, generally with spend controls |
| Direct API | Anthropic or OpenAI API keys | Usage-based model and tool charges |
| Cloud provider | Amazon Bedrock, Google Vertex AI, comparable services | Provider-specific inference, infrastructure, networking, logging, and support charges |

Anthropic documents Claude Code access through individual subscriptions, premium Team/Enterprise seats, direct Console/API billing, and Amazon Bedrock or Google Vertex AI. Its business offering can combine a seat with extra usage charged at API rates and administrator-set caps.[^anthropic-setup][^anthropic-business] OpenAI documents Codex access through ChatGPT plans with usage limits and extendable credits, an API-key path billed for tokens, and Enterprise/Edu arrangements; current local Codex surfaces can also use supported OpenAI models through Amazon Bedrock.[^openai-pricing][^openai-bedrock]

Therefore the answer to “is Concourse all consumption-based?” is **no**. The appropriate procurement model may still include consumption, especially for high-volume automation or cloud inference, but a predictable base can be established with seats, included usage, caps, and workload routing. Prices, quotas, supported models, and plan entitlements change frequently; procure against a dated quote and current official documentation rather than values embedded in architecture.

Concourse should record the following provider-neutral telemetry for chargeback and comparison:

- provider, commercial cost source, account/workspace, model and model version;
- input, cached-input/cache-read, cache-write, output, and reasoning tokens when exposed;
- provider-reported cost and locally calculated cost, kept as separate fields;
- duration, queue time, tool calls, turns or iterations, and handoffs;
- task class, outcome, deterministic-gate results, human acceptance, and rework;
- missing/estimated-field markers and telemetry schema version.

Cost without outcome is not a useful optimization target. A cheaper run that produces more rework or weaker evidence is not necessarily economical.

## Architecture decision matrix

| Option | Independence | Rich agent behavior | Delivery effort | Governance and cost visibility | Decision |
| --- | --- | --- | --- | --- | --- |
| Claude-only Concourse | Low | Strongest current path | Lowest | One provider is simpler, but creates concentration risk | Preserve as the working baseline, not the destination |
| Native Claude + Codex adapters | High | Preserves each runtime's sessions, tools, approvals, and sandbox | Moderate | Normalization work is required; enables comparison and fallback | **Recommended target** |
| Generic LLM/API gateway | Medium at the model-call layer | Often loses native agent semantics or reduces them to a lowest common denominator | Moderate to high | Central budgets and routing can be useful | Use behind adapters where helpful, not as the primary agent abstraction |

## Required validation before product claims

1. **Read-only escape suite:** attempt writes through every built-in, shell, MCP, custom-tool, filesystem, symlink, network, and credential path; verify denial and audit evidence.
2. **Judge-diversity trial:** run the same blinded artifacts through builder-matched and provider-diverse antagonists; compare defect discovery, false positives, agreement, cost, and human usefulness.
3. **Adapter normalization spike:** run equivalent Claude and Codex tasks and prove Concourse can represent narration, tools, approvals, cancellation, errors, completion, identifiers, and usage without losing raw events.
4. **Relay benchmark:** compare a single long context with structured relay legs across multiple task classes and model versions; measure task success, defects, handoff omissions, latency, tokens, cache behavior, cost, and human rework.
5. **StructureView browser-host trial:** test startup, file access, offline behavior, accessibility, updates, and completion rates with representative business users before retiring Electron.

The relay should not be productized until it beats the single-agent baseline on a declared quality/cost objective and has an acceptable baton-drop rate. The antagonist should not become a blocking authority until its deterministic and subjective decisions are visibly separated and its false-block rate is known.

## Staged recommendation

1. **Preserve the current Claude adapter.** It is working evidence and a useful fallback.
2. **Formalize a provider-neutral `AgentEngine` contract.** Normalize business state while retaining provider-native details and raw evidence.
3. **Spike Codex app-server as the second backend.** Start locally over stdio; compare the SDK or `codex exec --json` for narrower automation.
4. **Harden and test the antagonist boundary.** Use explicit denials, restrictive credentials, containment, immutable authority surfaces, and adversarial escape tests.
5. **Validate relay economics and quality.** Establish a single-agent baseline and require measured improvement before building automated overlap and rotation.

This path supports Claude Code without making Claude the permanent architecture. It also gives the read-only antagonist a credible control boundary while keeping its more ambitious quality and economic claims falsifiable.

## Sources and evidence basis

### Internal concept documents

- [Can the Antagonist Stay Read-Only While Driving Quality?](../structureview/structureview/docs/PAPER-ONE-antagonist-read-only.md)
- [Dual-Terminal / Dual-LLM Quality Antagonist — Technical Design](../structureview/structureview/docs/antagonist-design.md)
- [Relay ReAct + the Read-Only Antagonist](../RELAY-REACT-ANTAGONIST.md)
- [Concourse × StructureView](../CONCOURSE-AND-STRUCTUREVIEW.md)

### Repository evidence

- [Concourse host and runtime](host.mjs)
- [Concourse specification](SPEC-concourse-bridge.md)
- [Build ledger](BUILD-LEDGER.md)
- [v0.2 research findings](V0.2-FINDINGS.md)
- Tests under [`test/`](test/)

### Current official product sources

The following sources were checked on 2026-08-03. Product availability, pricing, limits, protocol maturity, and model support are time-sensitive.

[^openai-app-server]: OpenAI, [Codex app-server](https://learn.chatgpt.com/docs/app-server).
[^openai-sdk]: OpenAI, [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
[^openai-exec]: OpenAI, [Codex non-interactive mode](https://learn.chatgpt.com/docs/codex/noninteractive).
[^openai-surfaces]: OpenAI, [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Codex IDE extension](https://learn.chatgpt.com/docs/codex/ide), and [ChatGPT desktop app](https://learn.chatgpt.com/docs/app).
[^openai-pricing]: OpenAI, [Codex pricing](https://learn.chatgpt.com/docs/pricing).
[^openai-bedrock]: OpenAI, [Use ChatGPT Work and Codex with Amazon Bedrock](https://learn.chatgpt.com/docs/amazon-bedrock).
[^anthropic-setup]: Anthropic, [Set up Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started).
[^anthropic-business]: Anthropic, [Claude Code and new admin controls for business plans](https://www.anthropic.com/news/claude-code-on-team-and-enterprise).
