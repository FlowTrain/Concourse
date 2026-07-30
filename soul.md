# soul.md — Concourse

Private program context. Not for stakeholders. `CLAUDE.md` tells you what to build; this tells
you what is actually going on, so that when the spec is ambiguous you resolve it in the right
direction.

## The situation this came out of

Claude Code got handed to everyone. The engineers took to it. Everybody else hit the terminal and
stopped. There is no bridge between VS Code and anything a product manager, a designer, or a
senior business leader would voluntarily open. Right now there is no organisational appetite to
bring in the desktop app or Cowork, so the answer has to be something built in-house that runs on
the seats people already have.

The tempting fix — reskin VS Code so it looks less like a developer tool — is the wrong fix, and
the reasoning matters because you will be tempted to drift toward it. Non-developers do not avoid
the terminal because it is ugly. They avoid it because it offers no undo, no visible state, and no
signal about whether the thing is working, waiting on them, or broken. Restyling the same opaque
text stream ships the same anxiety in a nicer font. **The chasm is legibility, not aesthetics.**

That is why §6 of the spec — the state machine — is the load-bearing component and everything
else is plumbing. If you have to trade transcript fidelity, file browsing, or session persistence
to keep the state display crisp and honest, make that trade.

## Who is on the other side of the screen

A PM who has a real deliverable due, no mental model of a filesystem beyond Finder or Explorer,
and one unit of patience. They will use this tool exactly once before deciding whether it is real.
If the first run leaves them unsure whether anything happened, there is no second run and the
pilot is over.

This is why the "no developer vocabulary" rule in `CLAUDE.md` is not stylistic fussiness. Every
piece of jargon that survives into the UI is a moment where that person concludes the tool was not
built for them. And it is why `Bash` is denied rather than gated. One destructive command in this
population's hands ends the programme regardless of who technically approved it.

## Why the strange architectural choices are correct

**Why a Node host at all.** A browser cannot spawn a process. That is the whole reason. Do not go
looking for a purer answer; there isn't one. Keep the host thin and resist the gravity that pulls
every local host toward becoming an application server.

**Why CLI-first when the SDK is better.** The SDK is the target because its permission callback is
the only way to turn an approval into a modal, and the modal is what earns trust. But the state
machine needs to be proven against real event traffic before anything is built on top of it, and
the CLI gets us there in an afternoon with no library surface to learn. Build the interface, ship
the cheap engine, swap it. Same loose-coupler move as `ITerminalAdapter` in the FlowTrain
dual-terminal work — it worked there for the same reason.

**Why no bundler.** Partly speed. Mostly that a single auditable HTML file has already proven
itself in this programme — the graph studio shipped that way at 79KB and it was inspectable,
hackable, and trivially distributable. A build step buys nothing here and costs the property that
anyone can open the file and see what it does.

**Why the skill panel is read-only.** Because the org has ten skill marketplaces and exactly one
working distribution channel: the Artifactory-backed one with the custom pull/install CLI.
Building a skill installer into Concourse would be competing with the thing that already works.
Concourse reads what that channel puts on disk and displays it. Nothing more.

The panel has a second function that is not in the spec's rationale. Accumulated skills across
the org are written inconsistently, and a vague `description` field means the skill silently never
triggers — the worst kind of failure, because it looks like the model is just bad. Rendering those
descriptions in a UI panel a PM will read makes the quality visible without anyone having to
circulate a style guide. The real fix is a lint gate in the pipeline that publishes to Artifactory:
bad frontmatter fails to publish. That is a separate piece of work. This panel is the thing that
makes people want it.

## What this is really a probe for

Two possible futures, and Concourse is deliberately built to serve either.

The first is that this stays an internal tool and grows into the front door for AI-assisted work
by non-engineers. Fine outcome.

The second is that the Microsoft path gets funded — declarative agents with MCP support, MCP Apps
rendering interactive UI directly inside Copilot chat, governance landing in the tenant where the
admins want it. In that world Copilot is the face and the engine underneath is still ours. If that
happens, `host.mjs` becomes the MCP server and `app.html` gets thrown away. That is a good outcome
too, and it is the reason the engine and the normaliser must stay clean of front-end assumptions.
Keep that seam honest and the pivot costs a week.

What Concourse is *not* a probe for: replacing Claude Code as the place real implementation
happens. Agent Builder and declarative agents are retrieval plus tool-calling — a reception desk,
not a workshop. Anyone who proposes that the Microsoft surface can be the whole answer has not yet
tried to make it produce a spec. Concourse exists precisely because the workshop is good and the
door to it is too narrow.

## Compliance, honestly

FINRA 4511 applies to this organisation, and a tool that generates work product needs a retention
story. The spec puts in a `TranscriptSink` and stops there deliberately — the WORM decision
involves infrastructure choices well above this component. Do not solve it here, and do not let it
block v0.1. But do not make it hard to add later, which is why the sink is append-only JSONL keyed
on `session_id` from day one rather than something clever.

The one non-negotiable: a failed audit write is a hard stop. Not a warning, not a retry that gives
up. If the transcript cannot be written, the turn does not proceed.

## Standing preference

Public-facing artefacts stay narrowly scoped — one card at a time. Richer programme context lives
in companion files like this one. Keep that separation. If you are about to put reasoning like the
above into the spec or a stakeholder-visible document, put it here instead.
