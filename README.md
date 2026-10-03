# Claude Full-Stack Engineering OS

A reusable Claude Code engineering operating system for:

- Full-stack development
- Frontend/UI/UX
- Backend/API engineering
- Databases
- Linux
- DevSecOps
- Cloud
- FDE work
- QA/testing
- Architecture
- AI/LLM/agent engineering
- Persistent project memory
- Single-point documentation
- Dated engineering updates
- ADRs and changelog

## Install

Extract this package into the root of your project.

Then start Claude Code from that project.

Read `INSTALL-SKILLS.md` for the third-party skills.

## Core files

`CLAUDE.md`
- Engineering operating rules
- Source-of-truth hierarchy
- Security rules
- Documentation/update protocol

`.claude/memory/`
- Durable project memory

`.claude/commands/`
- Reusable workflows

`docs/`
- Human-readable project documentation

## Recommended model

Use Claude Code as the main orchestrator. Keep skills modular. Let the repository provide durable context and use your model router/Omniroute below the agent layer when appropriate.

## Principle

Skills teach Claude how to work.
Memory records what is true about the project.
Documentation records what changed.
ADRs record why durable architectural decisions were made.
Git records the complete history.
