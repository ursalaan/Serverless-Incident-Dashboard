# Serverless Incident Management Dashboard

A lightweight, serverless incident management dashboard designed to reflect how internal operational tools are built and used in practice.

The system prioritises correctness, explicit state, and auditability over UI polish or feature count. Every design choice favours reliability and clarity rather than surface complexity.


## Why This Exists

Many demo-style projects optimise for visual complexity or framework usage.

This project takes the opposite approach. It focuses on how real internal tools behave when:

- consistency matters more than scale  
- auditability matters more than aesthetics  
- workflows matter more than visuals  
- AI assists humans rather than replacing judgement  

The goal is to model a system that engineers would actually trust during incidents.


## Architecture

The diagram below shows the core data flow and responsibility boundaries.

![Architecture Diagram](docs/architecture.png)

### Cloudflare Worker
- Serves both API endpoints and the dashboard UI  
- Acts as the single entry point for all requests  

### Durable Object
- Single source of truth for incident data  
- Strongly consistent, persistent server-side state  
- Handles all writes and lifecycle transitions  

### Thin Client
- Vanilla JavaScript  
- No frameworks  
- No client-side persistence  

All meaningful state lives on the server. Reloading the page or closing the browser does not affect stored data.


## Incident Model

Each incident includes:

- metadata (ID, title, description, severity)  
- explicit lifecycle state (`Open`, `Investigating`, `Resolved`)  
- timestamps for creation, updates, and resolution  
- append-only notes  
- AI-generated artefacts  
- a complete action timeline  

### Lifecycle Rules

- state transitions are explicit  
- resolved incidents can be reopened  
- reopening clears resolution timestamps for metric accuracy  
- no silent or implicit changes  


## Context & Auditability

Investigation context is stored as append-only notes rather than chat-style messages.

Notes are immutable, timestamped, and form a permanent audit trail.

All meaningful actions are recorded, including:

- incident creation  
- status changes  
- context updates  
- AI output generation  

This keeps system behaviour transparent and reviewable.


## AI Integration

AI is used in a constrained, assistive role.

It generates:

- technical summaries  
- suggested next steps  
- stakeholder-friendly updates  

Outputs are:

- based only on provided context  
- severity-aware  
- explicitly restricted from inventing facts  

Results are stored as timestamped artefacts, not conversations.


## Metrics

Operational metrics are derived directly from server-side timestamps:

- total incidents  
- open vs resolved  
- average resolution time  

Metrics update automatically as incidents change state.


## UI Philosophy

This is an internal tool, not a consumer product.

Design choices favour clarity:

- no frontend framework  
- minimal styling  
- strong state indicators  
- readable layouts  

Visual elements exist to communicate information, not decoration.


## Scope & Trade-offs

Intentionally out of scope:

- authentication  
- multi-user isolation  
- role-based access control  

A single global incident store keeps the system simple and focused for:

- demos  
- architectural discussion  
- portfolio review  

These omissions are deliberate trade-offs, not oversights.


## What This Demonstrates

- serverless backend design  
- stateful systems using Durable Objects  
- audit-first data modelling  
- operationally realistic workflows  
- restrained, maintainable UI  
- clear architectural judgement  


## Future Work

Possible extensions include:

- authentication and ownership  
- role-based access  
- additional operational metrics  
- external notifications (Slack/email)  
- exports or summaries  

All extensions build on the current design without increasing complexity or weakening clarity.
