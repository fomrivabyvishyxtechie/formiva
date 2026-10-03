# Claude Code Skill Installation Guide

## Before you install

For third-party skills, inspect the repository and `SKILL.md` before granting broad permissions. A skill can contain instructions and executable scripts that run with your developer permissions.

The commands below use the current public repositories found during preparation of this kit.

---

# 1. Taste Skill

Repository:
https://github.com/Leonxlnx/taste-skill

Recommended global install:

```powershell
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend" --agent claude-code --global
```

Project-local:

```powershell
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend" --agent claude-code
```

The current default `design-taste-frontend` is v2 according to the repository documentation. The repository also exposes `design-taste-frontend-v1`.

---

# 2. awesome-design-md

Important: `awesome-design-md` is primarily a DESIGN.md collection/workflow, not one universal canonical Claude skill.

Official collection:

https://github.com/VoltAgent/awesome-design-md

Clone the collection:

```powershell
git clone https://github.com/VoltAgent/awesome-design-md.git "$env:USERPROFILE\awesome-design-md"
```

Then copy a selected design system into your project, for example:

```powershell
Copy-Item "$env:USERPROFILE\awesome-design-md\design-md\vercel\DESIGN.md" ".\DESIGN.md"
```

Browse available styles under:

```text
$env:USERPROFILE\awesome-design-md\design-md\
```

If you want a Claude Code skill that creates DESIGN.md files, one current option is:

```powershell
git clone https://github.com/moesuito/claude-skill-design-md.git "$env:USERPROFILE\.claude\skills\design-md"
```

---

# 3. web-design-guidelines

The current Vercel Labs agent-skills source is:

https://github.com/vercel-labs/agent-skills

Install globally:

```powershell
npx skills add vercel-labs/agent-skills --skill web-design-guidelines --agent claude-code --global
```

Project-local:

```powershell
npx skills add vercel-labs/agent-skills --skill web-design-guidelines --agent claude-code
```

The skill reviews UI against the Web Interface Guidelines and fetches current guideline content during review.

---

# 4. Security Audit Skill

There are multiple projects using this name. Do not install all of them because they can register duplicate `/security-audit` skills.

A full-stack option:

https://github.com/sam-cre/Security_Audit_Skill

Windows:

```powershell
git clone https://github.com/sam-cre/Security_Audit_Skill.git "$env:USERPROFILE\security-audit-skill"
Set-Location "$env:USERPROFILE\security-audit-skill"
.\install.ps1
```

This project documents installation into:

```text
~/.claude/skills/security-audit/
```

and provides `/security-audit`, `/security-audit quick`, `/security-audit deep`, `/security-audit setup`, and `/security-audit diff`.

Alternative repository with a Node-focused scanner:

```powershell
npx skills add https://github.com/Tomass10/security-audit-skill --skill security-audit-skill --agent claude-code --global
```

Pick ONE security-audit implementation unless you intentionally want both.

---

# 5. Impeccable

Current project:

https://github.com/pbakaus/impeccable

From the project root:

```powershell
npx impeccable install
```

Then inside Claude Code:

```text
/impeccable init
```

The current project describes one `impeccable` skill with 24 commands and a Claude Code hook that can inspect UI edits.

Useful commands include:

```text
/impeccable init
/impeccable audit
/impeccable critique
/impeccable polish
```

---

# 6. agent-skills

This name is ambiguous because several repositories publish `agent-skills`.

A known Claude Code collection is:

https://github.com/carlkibler/agent-skills

Inside Claude Code:

```text
/plugin marketplace add carlkibler/agent-skills
/plugin install pre-mortem@carl-tools
/plugin install empathy-audit@carl-tools
/reload-plugins
```

Another major source is Vercel Labs:

```powershell
npx skills add vercel-labs/agent-skills --agent claude-code --global
```

For your setup, prefer installing individual skills from a collection instead of blindly installing every skill.

---

# 7. Coder

If by "coder" you mean Coder's official Claude Code skills:

https://github.com/coder/skills

Global:

```powershell
npx skills add coder/skills --global
```

Or Claude Code marketplace:

```text
/plugin marketplace add coder/skills
/plugin install coder-skills@coder-skills
```

Then ask Claude:

```text
setup coder
```

---

# 8. ux-engine

I could not verify a single canonical Claude Code repository named exactly `ux-engine`.

Do NOT run a random `npx skills add` command for this name.

If you meant a specific repository, send me its GitHub URL and I can give you the exact command.

For a broad UI/UX intelligence layer, one current alternative is UI/UX Pro Max:

```powershell
npx skills add nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max --agent claude-code --global
```

---

# Recommended installation order

1. Base Claude Full-Stack Engineering OS
2. `web-design-guidelines`
3. `impeccable`
4. `design-taste-frontend`
5. `design-md`
6. ONE security-audit implementation
7. Coder, if you actually use Coder
8. Selected agent-skills
9. UI/UX Pro Max or the exact `ux-engine` repository once identified

---

# Verify

Restart Claude Code, then use:

```text
/skills
```

For the installed skills, test with prompts such as:

```text
Review this UI against web interface guidelines.
```

```text
/impeccable audit
```

```text
Run a security audit of this project.
```

```text
Create a DESIGN.md for this project.
```

```text
Run a pre-mortem on the current architecture.
```

---

# Global vs project-local

Global:

```text
~/.claude/skills/
```

Use for skills you want in every project.

Project-local:

```text
<project>/.claude/skills/
```

Use for skills that should be versioned with a specific repository.

Keep your engineering operating system (`CLAUDE.md`, `.claude/memory`, docs structure) in the repository so it travels with the project.

---

# Security note

Third-party skills are executable/instructional code operating with your developer tooling. Read their `SKILL.md`, inspect scripts/hooks, and pin or review versions before using them on sensitive repositories.
