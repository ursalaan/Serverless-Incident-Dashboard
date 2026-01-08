# Serverless Incident Management Dashboard:

This project is a deliberately scoped incident management dashboard designed to model how real internal operational tools are built, not how demo applications are marketed.

It prioritises clarity, state integrity, and explainable system behaviour over UI polish or feature volume.


## Why This Exists:

Most portfolio projects optimise for surface-level complexity:
- Flashy frontends
- Excessive frameworks
- Unrealistic assumptions

This project does the opposite.

It demonstrates how a small but serious internal tool might be designed when:
- Consistency matters more than scale
- Auditability matters more than aesthetics
- AI is an assistant, not an authority


## High-Level Architecture:

![Architecture Diagram](docs/Architecture Diagram)

- **Cloudflare Worker**
  - Serves both API endpoints and the dashboard UI
  - Acts as the entry point for all interaction

- **Durable Object**
  - Single source of truth for all incident data
  - Strongly consistent, persistent server-side state

- **Thin Client**
  - Vanilla JavaScript
  - No frameworks
  - No client-side persistence

All meaningful state lives on the server.

Reloading the page, closing the browser, or returning later does not affect stored data.


## Incident Model:

Each incident includes:
- Metadata (ID, title, description, severity)
- Explicit lifecycle state (`Open`, `Investigating`, `Resolved`)
- Timestamps for creation, updates, and resolution
- Append-only context notes
- AI-generated artefacts
- aA complete timeline of actions

### Lifecycle Rules:

- Incidents move explicitly between states
- Resolved incidents can be reopened
- Reopening clears resolution timestamps to preserve metric accuracy
- No state changes happen silently


## Context & Auditability:

Investigation context is captured through append-only notes, not chat-style messages.

Each note is timestamped, immutable, and part of the permanent audit trail.

Every meaningful system action is recorded in a timeline:
- Incident creation
- Status changes
- Context updates
- AI output generation

This makes system behaviour explainable and reviewable.


## AI Integration (Deliberate & Constrained):

AI is used in a bounded, non-magical way.

It generates:
- A technical summary
- Suggested next steps
- A stakeholder-friendly update

AI output is:
- Constrained to provided context
- Severity-aware
- Explicitly instructed not to invent facts

All AI outputs are stored as timestamped artefacts, not conversations.


## Metrics:

The dashboard calculates operational metrics directly from server-side data:
- Total incidents
- Open vs resolved
- Average resolution time

Metrics are derived only from valid timestamps and update automatically as incidents change state.


## UI Philosophy:

This is an internal tool, not a consumer product.

Design principles:
- No frontend framework
- No animations or visual noise
- Clear hierarchy and readability
- Muted metadata, strong state indicators

Styling choices are communicative, not decorative.


## Scope & Trade-offs:

The following are intentionally out of scope:
- Authentication
- Multi-user isolation
- Role-based access control

The system currently uses a single global incident store, which is appropriate for:
- Demos
- Portfolio review
- Architectural discussion

These omissions are conscious trade-offs, not oversights.


## What This Project Demonstrates:

- Serverless backend design
- Stateful systems using Durable Objects
- Operationally realistic workflows
- Audit-first data modelling
- Intentional UI restraint
- Sound architectural judgment

This project is designed to be discussed, extended, and reviewed - Not to just run.
