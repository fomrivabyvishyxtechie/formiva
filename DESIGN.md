# Formiva — Design System & UX Specification

**Status:** Living specification. This is the single source of truth for UI/UX across Formiva. Any screen, component, or interaction not yet built should be designed against this document before implementation; any new pattern discovered during implementation gets added back here in the same session.

**Inherited, not invented:** the base brand tokens (primary blue, teal accent, type family, 8px radius) were locked in an earlier Formiva design pass and are treated as fixed inputs, not open decisions. Everything else in this document — the surface hierarchy, spacing, motion, component rules, and anti-patterns — is built new, specifically for what Formiva actually is.

---

## 0. What Formiva actually is (why this document looks the way it does)

Formiva is not a marketing dashboard or a consumer app. It is a **document-review and approval workstation**: an HR or operations reviewer opens it dozens of times a day to look at a submitted case, read AI-extracted fields next to the evidence that produced them, decide whether to approve, correct, or escalate, and move on. The same five to twenty people will use this tool for years. Nobody "discovers" it through delight — they get faster at it through familiarity.

That reality sets the whole design direction:

- **Evidence before assertion.** Formiva's core promise is that no AI claim stands alone — every extracted field is shown next to the document region that produced it, and every confidence score is inspectable, never just trusted. The UI must make this pairing physically adjacent, always.
- **Calm, not quiet desperation for attention.** This is a tool for people making consequential decisions about someone's employment documents. It should feel like a well-run records office, not a startup trying to look impressive.
- **One irreversible action per case.** Everything in Formiva is reversible and re-reviewable except the single authorized action at the end (send the notification, create the record). That one moment deserves different visual weight than everything before it.
- **Density with order, not clutter.** Reviewers triage queues of dozens of cases. The interface must hold more information per screen than a typical B2B SaaS product, organized so density reads as "organized," not "busy."
- **Trust through restraint.** Masked Aadhaar numbers, audited reveal actions, watermarked document views, government-document handling — Formiva's selling point is that it is careful with sensitive data. The UI must visibly perform that carefulness, not hide it behind cheerful icons.

If a design choice would read as "looks impressive in a screenshot," it is probably wrong for this product. If it would read as "I trust this to hold legal documents correctly," it is probably right.

---

## 1. Design Philosophy

**Clarity over cleverness.** Every screen answers, without thinking: where am I, what can I do here, what just happened, what should I do next. If a reviewer has to hover or click to discover what a screen does, the screen has failed.

**Hierarchy by position and weight, not by decoration.** The most important thing on a screen is the largest, topmost, or leftmost thing — never the thing with the brightest color or the most motion. Formiva has exactly one accent color in active use at any moment (see §5); it never competes with itself for attention.

**Consistency as a promise.** The same action always looks and behaves the same way everywhere it appears. A "Reject" button is always the same red, in the same relative position, with the same confirmation pattern, whether it's rejecting a document, a case, or a workflow version. Reviewers build muscle memory; the product must not break it.

**Simplicity as subtraction.** Every element on a case screen must answer "why is this here" in terms of what the reviewer needs to decide. Decoration that doesn't carry information is removed, not minimized.

**Speed is a design feature, not an engineering afterthought.** A reviewer processing 40 cases a day feels every 200ms of unnecessary friction. Perceived speed (§19) is treated with the same priority as visual polish.

**Discoverability through structure, not tours.** New reviewers learn Formiva by its layout being predictable, not through onboarding tooltips that get dismissed once and forgotten. Structure teaches; overlays interrupt.

**Accessibility is baseline, not a feature.** A reviewer with a repetitive-strain injury, low vision, or working one-handed is not an edge case for compliance intake software — they are a normal user. WCAG 2.2 AA is the floor everywhere in Formiva (§14).

**Product personality: the trusted records clerk, not the eager assistant.** Formiva never says "Great job!" or celebrates a routine approval with confetti. It is precise, calm, slightly formal, and always shows its work. The personality comes through in restraint, not friendliness.

---

## 2. Visual Identity

**Overall visual character:** a quiet instrument panel for serious work — closer to the cockpit of a well-designed professional tool (think: a good EHR, a case-management system, an air-traffic workstation) than to a consumer SaaS landing page. Flat, bordered surfaces; disciplined color; data treated as data.

**Design personality:** precise, calm, slightly institutional, quietly confident. Never playful, never corporate-sterile either — Formiva has warmth in its language (§18) even when its visuals are restrained.

**Typography direction:** one sans-serif family doing all display and body work (Inter or Geist Sans, inherited), plus one monospace family (Geist Mono, inherited) used **only** where the content is genuinely machine-precise data: case IDs, document hashes, confidence percentages, correlation IDs, last-four digit displays, timestamps in logs. This is not decoration — Formiva's subject matter includes real cryptographic hashes and real IDs, so monospace for those specific tokens is earned, not a stylistic tell.

**Color philosophy:** one primary color (blue), one single-purpose accent (teal, reserved exclusively for "AI-assisted" signifiers), a disciplined neutral scale doing most of the visual work, and semantic colors (success, danger, warning) that are never used decoratively — if something is amber, it means "needs human attention," full stop. See §5.

**Shape language:** 8px corner radius (inherited) applied consistently to interactive surfaces — buttons, inputs, menus. Content panels and tables are **not** rounded-card containers; they are flat bordered regions (see Surface hierarchy below). Rounding is reserved for things you click or type into, not for things you read.

**Border philosophy:** hairline 1px borders (#E5E7EB) are the primary structural device in Formiva, not shadows. Borders divide a records office into its proper sections; shadows imply something is floating above the page, which is only true for genuinely floating things (modals, popovers, dropdowns).

**Shadow philosophy:** shadows are earned, not default. Exactly three elevation levels exist (§6), and only the top one (modals, popovers, toasts) uses a shadow at all. A table row, a panel, a sidebar — none of these float, so none of them cast a shadow. This directly rejects the "identical rounded card, same soft grey shadow under everything" pattern.

**Surface hierarchy:**
1. **Canvas** (`--surface-canvas`, #F7F8FA) — the page background.
2. **Panel** (`--surface-panel`, #FFFFFF) — content containers: tables, forms, the case detail view. Bordered, not shadowed.
3. **Overlay** (`--surface-overlay`, #FFFFFF with shadow) — the only elevated layer: modals, dropdowns, popovers, toasts, command palette.

**Iconography:** a single consistent icon set (Lucide, which the stack already uses via lucide-react), stroke-based, 1.5px stroke weight, never filled/solid style mixed with stroke style. Icons are always paired with a text label in Formiva except inside dense tables where space is genuinely constrained and a tooltip provides the label on hover/focus. No icon exists purely as decoration.

**Illustration direction:** Formiva uses **no decorative illustration.** Empty states use a single small icon plus precise text, never a drawn scene. This is deliberate: illustrated empty states are a strong "generic SaaS" signal and add nothing for a daily-use operational tool. The one exception is the document evidence viewer, where the "illustration" is the actual uploaded document — real content, not decoration.

**Data visualization style:** flat, no gradients, no 3D effects, minimal color per chart (one or two semantic colors plus neutral grey for context). Formiva's charts (queue age, benchmark results, pilot metrics) are read by operators making decisions, not shown to investors — legibility and precise values on hover beat visual impressiveness every time. Numbers are always available as text (in a table or on hover), never gradient-only.

---

## 3. Design Tokens

All values below are the canonical token set. Implementation should define these as CSS custom properties and mirror them in the Tailwind theme config so `bg-surface-panel` and `var(--surface-panel)` always agree.

### Color tokens

```
--color-primary:          #1A56DB   /* inherited brand blue — primary actions, links, focus ring, active nav */
--color-primary-hover:    #1544B0
--color-primary-active:   #0F3485
--color-primary-subtle:   #EEF2FD   /* primary-tinted backgrounds: selected row, active tab indicator track */

--color-accent-ai:        #0D9488   /* inherited teal — reserved EXCLUSIVELY for "AI-assisted" signifiers */
--color-accent-ai-subtle: #ECFDF5

--color-surface-canvas:   #F7F8FA
--color-surface-panel:    #FFFFFF
--color-surface-overlay:  #FFFFFF
--color-surface-sunken:   #F1F3F5   /* code blocks, read-only field backgrounds, masked-value placeholders */

--color-border-default:   #E5E7EB
--color-border-strong:    #D1D5DB  /* table header rules, focused input border */
--color-border-on-dark:   rgba(255,255,255,0.16)

--color-text-primary:     #111827
--color-text-secondary:   #4B5563
--color-text-muted:       #6B7280
--color-text-disabled:    #9CA3AF
--color-text-on-primary:  #FFFFFF
--color-text-link:        var(--color-primary)

--color-success:          #16A34A
--color-success-subtle:   #F0FDF4
--color-danger:           #DC2626
--color-danger-subtle:    #FEF2F2
--color-warning:          #E08A00   /* reserved meaning: "needs human attention" — never decorative */
--color-warning-subtle:   #FFF7E8
--color-info:             #1A56DB  /* reuses primary; Formiva does not invent a second blue */

--color-focus-ring:       #1A56DB
--color-sensitive-hatch:  #D1D5DB  /* masked/hidden value placeholder pattern */
```

Dark mode is **not built for the reviewer workstation at launch** (see §5 — reasoning below). Public respondent-facing pages respect `prefers-color-scheme` for the surrounding chrome only (browser UI), not the form itself, since forms are filled in short, task-focused sessions where consistency matters more than appearance preference.

### Typography tokens

```
--font-sans:   "Inter", "Geist Sans", -apple-system, "Segoe UI", sans-serif
--font-mono:   "Geist Mono", "SFMono-Regular", Consolas, monospace

--text-xs:     12px / 16px    /* metadata, timestamps, helper text */
--text-sm:     13px / 20px    /* table cells, dense labels, secondary body */
--text-base:   14px / 20px    /* default body, form labels, buttons */
--text-md:     16px / 24px    /* case titles, section headers in-page */
--text-lg:     20px / 28px    /* page titles */
--text-xl:     24px / 32px    /* rare — dashboard summary numbers only */
--text-2xl:    30px / 36px    /* reserved for the public respondent-facing form headline only */

--weight-regular: 400
--weight-medium:  500   /* default for labels, emphasis within body text */
--weight-semibold:600  /* headings, primary button labels, active nav */
--weight-bold:    700   /* reserved for the single most important number on a screen, e.g. a case count */

--tracking-tight:  -0.01em   /* headings 20px and above */
--tracking-normal: 0
--tracking-wide:   0.02em    /* table column headers only — the one earned use of letter-spacing in Formiva */
```

Base body size is **14px, not 16px.** This is a deliberate, specific-to-Formiva decision: a dense operational table-and-form product needs to fit meaningfully more real content per screen than a marketing site, and 13–14px body text at a 1.4–1.5 line-height remains fully WCAG-legible while roughly doubling table density versus a 16px default. Public-facing respondent forms (used once, not daily) use 16px body for comfort, since that audience is not optimizing for density.

### Spacing scale

8px base unit, used everywhere — no arbitrary pixel values in component code.

```
--space-0: 0      --space-4:  16px   --space-8:  48px
--space-1: 4px    --space-5:  20px   --space-9:  64px
--space-2: 8px    --space-6:  24px   --space-10: 96px
--space-3: 12px   --space-7:  32px
```

### Radius, border, shadow, opacity, z-index

```
--radius-sm:   6px   /* checkboxes, small badges */
--radius-md:   8px   /* inherited default — buttons, inputs, menus, cards */
--radius-lg:   12px  /* modals only */
--radius-full: 9999px /* avatars, status dots, pill badges */

--border-width: 1px
--border-width-strong: 1.5px   /* focused inputs, selected table rows */

--shadow-overlay: 0 4px 16px rgba(17,24,39,0.10), 0 1px 2px rgba(17,24,39,0.06)
--shadow-none:    none   /* explicit token — panels, cards, table rows ALWAYS use this */

--opacity-disabled: 0.5
--opacity-hover-scrim: 0.04
--opacity-backdrop: 0.4

--z-base:      0
--z-sticky:    10   /* sticky table headers, sticky form progress bar */
--z-dropdown:  100
--z-overlay:   200  /* modals, drawers */
--z-toast:     300
--z-tooltip:   400
```

### Layout tokens

```
--container-sidebar:    260px (expanded) / 64px (collapsed)
--container-max-form:   720px   /* public respondent form — enforces <80 char line length on labels/help text */
--container-max-content:1280px  /* authenticated app content area */

--breakpoint-mobile:  0–639px
--breakpoint-tablet:  640–1023px
--breakpoint-desktop: 1024–1439px
--breakpoint-wide:    1440px+
```

---

## 4. Typography System

| Level | Token | Use | Weight |
|---|---|---|---|
| Display | 2xl | Public form headline only ("Welcome to Acme's onboarding") | Semibold |
| Page title | lg | Top of every authenticated page ("Review queue", "Case #1042") | Semibold |
| Section header | md | In-page section dividers ("Submitted documents", "Approval history") | Semibold |
| Body | base | Default paragraph text, form field values, button labels | Regular / Medium for buttons |
| Secondary body | sm | Table cells, list secondary lines, card descriptions | Regular |
| Label | sm | Form field labels, filter chips | Medium |
| Metadata | xs | Timestamps, "Last updated by", byline text | Regular, text-muted |
| Numbers (data) | sm, mono | Case IDs, hashes, confidence %, correlation IDs | Regular, mono |
| Numbers (metric) | xl/2xl, sans | Dashboard summary counts only (queue size, overdue count) | Bold |
| Table header | xs | Column headers | Medium, tracking-wide, text-muted |
| Form helper text | xs | Beneath an input, explaining format or constraint | Regular, text-muted |
| Error text | sm | Inline validation message | Medium, danger |
| Button label | base | All button text | Medium (primary/secondary), Semibold reserved for the single destructive-confirm button in a dialog |

**Why no second display typeface:** a second face exists to carry "brand personality" on marketing surfaces. Formiva's brand personality is carried by restraint and information design, not by a distinctive letterform — introducing a display serif or geometric display face here would be optimizing for a landing-page impression this product doesn't need, at the cost of one more asset to load and one more inconsistency risk across 40+ screens.

**Numbers get tabular figures.** Every numeral in a table (confidence %, case counts, dates) uses `font-variant-numeric: tabular-nums` so columns of numbers align vertically — essential for a reviewer scanning a queue by confidence score.

---

## 5. Color System

| Semantic role | Token | When it appears |
|---|---|---|
| Background (canvas) | `surface-canvas` | Page background behind all panels |
| Surface (panel) | `surface-panel` | Tables, forms, cards, the case detail pane |
| Elevated surface | `surface-overlay` | Modals, dropdowns, popovers, toasts — the only shadowed layer |
| Sunken surface | `surface-sunken` | Masked-value placeholders, disabled field backgrounds, code/hash display blocks |
| Primary | `primary` | Primary buttons, active nav item, links, focus ring, selected tab |
| Secondary | — (Formiva has no second brand color) | Secondary actions use neutral bordered buttons, not a second brand hue |
| Accent (AI) | `accent-ai` | **Exclusively** on: AI-extracted field labels, confidence score chips, "AI suggested" badges, the AI Engine status indicator. If teal appears anywhere that isn't signaling "this came from the model," it's a bug, not a style choice |
| Text | `text-primary` | Body copy, headings, primary field values |
| Muted text | `text-muted` | Metadata, placeholder text, disabled labels, helper text |
| Border | `border-default` | All dividing lines, table rules, input borders, panel edges |
| Success | `success` | Approved state, successful delivery, passed validation |
| Warning | `warning` | **Reserved meaning only: "needs human attention."** Low-confidence flags, review-queue priority indicators, SLA-approaching timers. Never used for generic emphasis |
| Error | `danger` | Rejected state, failed validation, quarantined document, destructive-action buttons |
| Info | reuses `primary` | Formiva does not introduce a fourth semantic hue for "info" — informational banners use primary at low saturation (`primary-subtle` background) |
| Hover | darken by one step (`primary-hover`, or `surface-sunken` for neutral hover) | |
| Active/pressed | darken by two steps (`primary-active`) | |
| Focus | 2px `focus-ring` offset 2px, visible on every interactive element, never suppressed | |
| Disabled | `opacity-disabled` applied to text and icon, background unchanged | |

**Dark mode is deliberately out of scope for the reviewer application at launch.** This is a reasoned decision, not an oversight: Formiva's reviewer workstation displays evidence photographs and scanned documents where color accuracy matters (is this stamp red or orange, is this signature black or blue ink) — an inverted dark palette risks subtly distorting document color perception at the exact moment a reviewer is making a judgment call about a document's authenticity cues. Dark mode may be revisited post-launch as an explicit, separately-tested mode, never as an automatic `prefers-color-scheme` toggle for this specific screen.

**No gradients anywhere in the authenticated product.** The one and only gradient permitted in Formiva is a subtle single-hue progress-bar fill (primary at 100% → primary at 85% opacity) on the public form's completion indicator, because it communicates continuous progress, which is a legitimate use for a gradient. Everywhere else, flat color only.

---

## 6. Layout System

**Page structure (authenticated app):**

```
┌─────────────────────────────────────────────────────┐
│ Top bar: workspace switcher · search · user menu      │  56px, surface-panel, border-bottom
├───────────┬───────────────────────────────────────────┤
│           │  Page title + primary action        [56px]│
│ Sidebar   ├───────────────────────────────────────────┤
│ 260/64px  │                                            │
│           │   Content area (max-width: 1280px,         │
│           │   left-aligned, NOT centered)              │
│           │                                            │
└───────────┴───────────────────────────────────────────┘
```

- **Navigation structure:** a persistent left sidebar (collapsible to icon-only at 64px) is the primary navigation, grouped by function: Queue, Cases, Workflows (Phase 8+), Integrations (Phase 9+), Audit, Settings. No top mega-menu, no mega-nav — reviewers live in one or two sections all day and need them always one click away, not nested in a dropdown.
- **Content alignment:** **left-aligned, never centered.** Centered content with generous whitespace is a marketing-page pattern; an operational tool that uses it wastes horizontal space a reviewer needs for tables and forms. The only centered layout in the entire product is the public respondent form (§17), because that audience fills it in once, on a phone, like a form — not like a workstation.
- **Grid:** 12-column grid at desktop/wide, content area capped at 1280px max-width so lines of text and table rows don't become unreasonably wide on ultra-wide monitors; tables themselves may exceed this and scroll horizontally within their own container rather than the page compressing.
- **Density:** "comfortable-dense" — more like a spreadsheet than a marketing card grid. Table row height 40px default (36px in a compact queue view toggle), form field vertical rhythm at `space-4` (16px) between fields, section spacing at `space-7` (32px).
- **Spacing is rhythmic, not decorative:** the 8px scale (§3) is used to the pixel; no ad hoc "looks about right" margins in implementation.

**Responsive behavior (desktop → tablet → mobile):**

- **Desktop/wide (1024px+):** full sidebar + content, case detail view shows document viewer and extracted fields side-by-side (two-pane).
- **Tablet (640–1023px):** sidebar collapses to icon rail by default (expandable via toggle, stays expanded until manually collapsed again); case detail view stacks document viewer above extracted fields (the pairing in §0 is preserved — document always directly above the fields it produced, never on a separate tab a reviewer must navigate to).
- **Mobile (<640px):** sidebar becomes a bottom-sheet/drawer triggered by a menu icon in the top bar; tables convert to a card-per-row list (not a shrunk table — shrinking a data table below ~600px produces unreadable truncation, so mobile gets a purpose-built list layout showing the 3–4 fields that matter for triage, with full detail one tap away); the case detail two-pane becomes a tab switcher (Document / Fields) rather than a stack, since there isn't vertical room for both at once on a phone. Mobile is a genuine secondary surface for Formiva (most review work happens at a desk), so it is designed to be fully usable, not merely not-broken, but desktop remains the primary design target.

**Public respondent form** is the one layout exception: single centered column, `container-max-form` (720px), generous vertical rhythm, mobile-first (most respondents will open this on a phone from a message link).

---

## 7. Component Design System

For every component: purpose, when to use/not use, states, and the one or two Formiva-specific rules that keep it from being generic.

### Buttons
- **Purpose:** trigger a single, named action.
- **Variants:** Primary (filled, `primary`) — one per screen/section, the single recommended next action. Secondary (bordered, neutral) — any other available action. Destructive (filled, `danger`) — reserved for actions that cannot be undone (reject, delete, revoke); always requires confirmation (see Modals) except for a reversible-within-this-session "Reject" on a review task, which is not destructive in Formiva's model (it reopens for rework) and uses Secondary styling with a danger-colored label, not a filled danger button.
- **States:** default, hover, active/pressed, focus-visible (2px ring), disabled (opacity, no pointer events), loading (label replaced by inline spinner, button stays its exact width — never resizes on loading).
- **When NOT to use a button:** navigation between pages is always a link styled as a link or a nav item, never a button that happens to navigate. This distinction matters for keyboard users and for browser back/forward expectations.
- **Rule specific to Formiva:** a button that submits an irreversible action (the one authorized action per case) is visually distinct from every other primary button in the product — it carries a small lock or send icon and sits inside a confirmation modal, never as a bare inline button (§8).

### Inputs (text, number, date, textarea)
- **Purpose:** capture a single field value.
- **States:** default, focus (border-strong + focus ring), filled, error (danger border + inline message below, not a tooltip), disabled, read-only (surface-sunken background, no border, signals "shown but not editable" — used for AI-extracted values before a reviewer accepts them).
- **Rule specific to Formiva:** a field holding a sensitive value (per the Government Documents Policy) renders masked by default with a hatched placeholder (`sensitive-hatch` token) and an explicit "Reveal" icon button, never an eye-icon toggle styled identically to a password field — the visual language must read as "this is logged and audited," distinct from a generic show/hide password pattern.

### Selects / Dropdowns
- Native-feeling custom select, opens below (or above if no room), `surface-overlay` + shadow, keyboard navigable (arrow keys, type-ahead, Esc to close). Multi-select uses checkboxes inside the same dropdown pattern, not a separate component.

### Checkboxes / Radio buttons / Toggles
- Checkboxes: multi-select, bulk table row selection. Radios: single choice among 2–5 visible options. Toggles: a setting that takes effect immediately with no "Save" step (e.g., safe-mode switch, workspace setting) — if an action requires a save/submit step, it is **not** a toggle, it's a checkbox in a form, to avoid the common anti-pattern of toggles that silently do nothing until a form is submitted elsewhere.

### Tabs
- Used for switching between views of the **same object** (a case's Fields / Timeline / Documents tabs). Never used as primary navigation between unrelated sections — that's the sidebar's job.

### Sidebar / Navigation
- See §6. Active item: `primary-subtle` background, `primary` text and left-border accent (2px), never relying on color alone (icon + label always present, satisfying non-color-dependent state indication for accessibility).

### Tables
- The primary content surface of Formiva. Flat (`surface-panel`, bordered, no shadow), sticky header on scroll, row hover = `surface-sunken` tint (no shadow, no scale), sortable columns indicated by a small arrow (not a generic "⇅" on every column — only on the currently-sorted one, with a neutral sort icon on hover for sortable-but-inactive columns). Row click opens detail; an explicit action menu (⋯) handles secondary actions so the whole row isn't an ambiguous click target competing with inline buttons.
- **Rule specific to Formiva:** confidence-score and priority columns always render as text + a small color-coded dot (not a colored cell background) — color-coding an entire cell background across a dense table reads as visual noise at scale; a single dot carries the same information with far less competition for attention.

### Cards
- Used **sparingly** — only for the dashboard summary tiles (queue counts, SLA status) and for the public respondent form's document-upload slots. Cards are not used to wrap arbitrary content throughout the product (directly rejecting the "card-inside-card" anti-pattern) — anywhere else that content needs grouping, a bordered panel with a section header does the job without implying "this is one discrete, draggable, decorative unit."

### Modals
- Reserved for: confirmations of destructive/irreversible actions, and short, focused single-task flows (e.g., "Correct this field"). A modal is never used to display a full secondary page of content — that's a route, or a Drawer.
- Backdrop: `surface-overlay`'s shadow plus a 40%-opacity neutral scrim (not blurred — backdrop-blur is a decorative tell Formiva avoids; a flat scrim is faster to render and clearer).
- The confirm button in a destructive-action modal is never the button in the position a reviewer's thumb/cursor naturally rests after reading top-to-bottom — it requires either typing a short confirmation phrase (for case-level irreversible actions) or an explicit second click with a 400ms delay before the button becomes active (for workflow rollback and similar high-stakes but lower-frequency actions), to prevent reflexive confirm-clicking.

### Drawers
- A right-side slide-in panel for viewing/editing something without losing the list context behind it (e.g., inspecting a dead-letter item while the dead-letter list stays visible). Used instead of a modal whenever the background context matters to the task.

### Tooltips / Popovers
- Tooltips: single-line clarification on hover/focus, no interactive content inside. Popovers: can contain interactive content (a mini-form, a menu) and are dismissed by click-outside or Esc.

### Toasts
- Bottom-right (desktop) / bottom-center (mobile), auto-dismiss after 5s for confirmations, **persist until manually dismissed for errors** (an error a reviewer doesn't get to read because it vanished is worse than no toast at all). Max one toast visible at a time; subsequent toasts queue rather than stack.

### Alerts / Banners
- Inline, top of the relevant section, bordered left-edge in the semantic color, `*-subtle` background. Used for state that persists until resolved (e.g., "This workspace is in Safe Mode — external actions are paused"), never for one-off confirmations (that's a toast's job).

### Badges
- Small, `radius-full`, text + optional dot, used for status (Open, Claimed, Resolved) and the AI-assisted indicator (`accent-ai`). Never more than one badge competing for attention per row except status + AI-assisted, which are allowed to coexist since they answer different questions.

### Breadcrumbs / Pagination
- Breadcrumbs appear only where real hierarchy exists (Workflow → Version → Node); not added to flat list pages for decoration. Pagination uses page numbers + prev/next for tables (reviewers often need to jump), infinite scroll is not used for any list a reviewer needs to systematically work through (queues), since "did I see everything" must always be answerable.

### Search
- A single global search (⌘K / Ctrl+K command palette) for jumping to a case by ID or searching across cases; inline per-table filters for narrowing a specific list. The command palette is the one place in Formiva where a slightly more "modern app" interaction pattern is justified, because it's a genuine efficiency tool for power users, not a decorative affordance.

### Forms
- Labels always above the field (never inline-left, which breaks at narrow widths and with long translated labels); helper text below the label, above the field, in `text-xs`/`text-muted`; error text below the field, replacing helper text (not appended beneath it) in `danger`.

### Upload interfaces
- Drag-and-drop zone with an explicit "Browse files" text link inside it (drag-only upload zones are inaccessible to many users), immediate per-file progress and per-file success/error state (a batch of 8 documents never shows one combined progress bar — a reviewer needs to know which specific file failed).

### Empty / Loading / Error / Success states
- Covered in depth in §11 and §12.

---

## 8. UX Patterns

**Create / Edit / Save:** Formiva distinguishes between draft objects (forms, workflows before publish) which **autosave silently** with a small, persistent "Saved" / "Saving…" indicator near the page title, and submitted/published objects which are immutable and require an explicit new-version action to change (this mirrors the actual database design — published form and workflow versions are immutable). The UI must never imply you can "just edit" something the system won't actually let you edit.

**Delete / Duplicate:** Delete always confirms, and always states what will actually happen in system terms a reviewer understands ("This will cancel the case. It will remain visible in the audit log.") — never a generic "Are you sure?". Duplicate is available on workflow versions and form templates (not on cases — a case is a real event, not a reusable template).

**Cancel vs. Undo:** Cancel exits a flow before commitment with no trace. Undo is offered for a narrow set of just-completed, genuinely reversible actions (e.g., "Claimed task — Undo" for 8 seconds via toast) — Formiva does not pretend everything is undoable, matching the database's actual append-only/immutable model; where an action truly cannot be undone, the confirmation step (§7 Modals) is the safeguard, not a false "Undo" promise after the fact.

**Confirmation:** A confirmation step exists exactly where the data model has no take-back (see §7). Formiva never shows a confirmation dialog for an action the system can trivially reverse (that's just friction).

**Search / Filter / Sort:** Filters are visible as chips above a table, not hidden in a collapsed panel — a reviewer needs to see at a glance what subset of the queue they're looking at. Filter state persists in the URL so a filtered queue view is shareable/bookmarkable and survives a refresh.

**Bulk actions:** Checkbox-select rows → a contextual action bar appears, replacing the page's primary action button, showing a count ("12 selected") and the actions valid for that selection. Bulk-reject/approve always confirms with the count explicitly stated.

**Multi-step workflows (the respondent form, the pilot onboarding wizard):** a persistent step indicator (not a progress percentage alone — named steps: "Your details → Upload documents → Review & submit"), back is always available, progress autosaves so a respondent can resume from a link without re-entering anything.

**Validation:** validate on blur (not on every keystroke, which feels naggy; not only on submit, which wastes the respondent's time discovering 6 errors at once). The one exception: format-sensitive fields (matching a government-document pattern) validate as-typed once a plausible length is reached, since immediate feedback there prevents a wasted document upload later.

**Error recovery:** every error state names the specific problem and the specific fix ("This file is larger than 10MB. Try compressing it or splitting it into two uploads.") — never "Something went wrong."

**Notifications (in-app):** a bell icon with an unread count shows SLA breaches, assigned reviews, and approval requests relevant to the signed-in user — not a feed of every system event, which would be noise within a day.

**Permissions:** an action a user cannot perform is either hidden (if they'd never plausibly need to know it exists) or visible-but-disabled with a tooltip explaining the required permission (if knowing it exists but is restricted is itself useful information, e.g., "Only an approver can complete this step").

**Empty / first-time use / returning users:** see §12 for the full breakdown by empty-state type.

---

## 9. Motion & Animation System

**Animation principles:** every motion in Formiva answers one of: cause-and-effect ("you clicked this, that happened"), spatial relationship ("this drawer came from that row"), state change ("this moved from Open to Claimed"), or progress ("this is still working"). If a proposed animation doesn't answer one of these, it is cut.

**Duration scale:**
```
--motion-instant:  0ms     /* state changes that must feel immediate: checkbox check, button press */
--motion-fast:     120ms   /* hover states, focus ring appearance */
--motion-base:     180ms   /* dropdown/popover open, tab switch, toast enter */
--motion-slow:     240ms   /* modal/drawer enter, page-level transitions */
```
Formiva uses **no duration above 240ms** for any UI transition. This is a deliberate ceiling: a reviewer processing dozens of cases a day will experience a 400ms "nice" modal animation literally thousands of times over a year; at that frequency, speed is the only thing that stays pleasant.

**Easing:**
```
--ease-standard: cubic-bezier(0.2, 0, 0, 1)    /* default for entrances */
--ease-exit:     cubic-bezier(0.4, 0, 1, 1)    /* exits are slightly faster than entrances */
```
No spring/bounce easing anywhere in the authenticated product — bounce implies playfulness, which is the wrong register for a compliance-adjacent tool. A single restrained spring (low stiffness, no overshoot) is permitted exactly once, in the success-checkmark micro-animation on completing a case (§10), as the one deliberately "alive" moment in the product.

**Page transitions:** none (instant navigation, standard browser-handled route change) for the authenticated app — a reviewer navigating between 40 cases a day should never wait on a transition. The public respondent form uses a single 180ms cross-fade between steps, since that's a slower-paced, once-off experience where a small transition aids orientation.

**Component transitions (by type):**
- **Modal/Drawer:** scrim fades in (120ms) simultaneously with the panel sliding/scaling in from 98% to 100% scale (240ms, ease-standard) — a subtle scale, not a full off-screen slide, so it reads as "appearing in place" rather than "flying in."
- **Dropdown/Popover:** fades + scales from 96% to 100% (120ms) from its trigger's anchor point.
- **Toast:** slides in from the edge it's docked to (180ms), exits by fading + collapsing its own height (so the item below moves up smoothly, not instantly).
- **Tab switch:** instant content swap (no slide/fade) — the content changing is already clearly caused by the explicit tab click; adding motion here answers no open question and only adds latency perception.
- **Expand/collapse** (sidebar sections, table row detail expansion): height animates (180ms) with content fading in during the latter half, to avoid the "squished text" look of a naive height transition.
- **Drag/drop** (workflow editor nodes, Phase 8): the dragged element follows the pointer at 1:1 with zero lag or easing (any easing on direct manipulation feels laggy, not smooth); on drop, a brief 120ms settle into the grid position.

**Hover / press / focus interactions:** hover = background tint change only, `motion-fast`, no transform/scale on hover for anything (scaling cards/buttons on hover is a strong generic-SaaS tell and adds no information). Press = a slightly darker background, instant. Focus = focus ring appears instantly (focus must never feel delayed for keyboard users).

**Loading animations:** a single consistent spinner style (thin-stroke circular, `primary` color) used everywhere loading is indeterminate; determinate progress (file upload, benchmark run) always shows a real progress bar with a percentage, never a fake animated one.

**Success feedback:** a small checkmark that draws itself (the one permitted spring-eased moment, ~300ms, used only for: case approved, document scan passed, form submitted) — reserved for genuine milestone completions, not every minor save.

**Error feedback:** a brief (150ms) horizontal shake on the specific invalid field only (not the whole form), paired with the error text appearing — motion reinforces exactly where the problem is.

**Data transitions:** when a table re-sorts or a row's status updates live (e.g., a case moves from "AI processing" to "Review queued" while a reviewer is looking at the list), the row that changed briefly highlights with a `primary-subtle` background flash that fades over 600ms — long enough to notice, not so long it feels like a sustained highlight.

**`prefers-reduced-motion`:** every transition above is either removed or cut to an instant cross-fade ≤1 frame when this is set, with zero exceptions — including the success-checkmark, which becomes a static checkmark that simply appears.

---

## 10. Micro-Interactions

- **Buttons:** background/border color shift on hover (no scale, no shadow-pop); loading state swaps label for a spinner at identical button width.
- **Inputs:** border color shifts to `border-strong` + focus ring on focus; a field that was just auto-filled by AI extraction briefly shows a 1px `accent-ai` border for 1.5s that fades to default, so a reviewer notices which fields were machine-populated without needing a separate legend.
- **Navigation:** active item's left-border accent animates in (height-wise) over `motion-fast` when selected, rather than snapping, so the eye can track which item just became active.
- **Tables:** row hover tint at `motion-fast`; a row being bulk-selected checks its checkbox with a 100ms fill animation, not an instant snap, so rapid shift-click range-selection still feels responsive rather than jittery.
- **Cards (dashboard tiles only):** no hover animation at all — they are not clickable in most cases, and adding hover affordance to a non-interactive element is actively misleading.
- **Toggles:** the switch thumb slides over `motion-fast`, background color crossfades simultaneously (not sequentially, which would look laggy).
- **Checkboxes:** checkmark draws in over `motion-fast` (short stroke-dash animation), rather than popping into view.
- **Drag/drop:** a faint drop-target outline appears the instant a drag begins over a valid target (instant, no delay — ambiguity about a valid drop zone is a usability problem, not a place for restraint).
- **Saving indicator:** cycles "Saving…" → "Saved" (with a small checkmark) → fades the checkmark after 2s, leaving just "Saved," never reverting to a blank/neutral state that makes a reviewer wonder if it saved at all.
- **Loading (inline, e.g., a field re-fetching after a correction):** the specific field/row shows a small inline spinner in place of its value — the rest of the screen never blocks for a local, scoped update.
- **Success (case-level):** the single spring-eased checkmark (§9), shown once, inside the confirmation, never repeated or re-triggerable by revisiting the case.
- **Errors (inline):** field shake + red border + error text appearing together, synchronized to the same frame.
- **Notifications (bell icon):** the unread count badge has a single, small, non-repeating "pop" (scale 0→1, `motion-fast`) the moment a new item arrives while the user is active in the app — it does not pulse or repeat, which would be distracting during focused review work.

---

## 11. Loading & Async States

| Situation | Pattern | Why |
|---|---|---|
| Initial page/table load | Skeleton rows matching the real table's row height and column structure | Prevents layout shift; a reviewer's eye already knows where the data will land |
| Loading a single case detail | Skeleton matching the two-pane layout (document placeholder + field-row placeholders) | Same reasoning, scoped to the actual layout being filled |
| Saving a form field (autosave) | Inline "Saving…/Saved" text indicator near the page title, no blocking spinner | The reviewer keeps working; the save is not a thing they should have to wait for |
| Submitting the full respondent form | Full-button loading state (spinner replaces label) + disable the button | This is a genuine wait with a real external effect (the case is created); blocking prevents double-submit |
| Uploading a document | Per-file progress bar with real percentage, inline in the upload list | Matches multi-file reality; never a single combined bar |
| AI processing a document (can take 1–5 minutes per Technical Documentation) | Explicit status text with elapsed/estimated time ("Reading document — usually takes 1–3 minutes"), not a spinner alone | A spinner with no time context for a multi-minute wait reads as broken; Formiva always sets the right expectation given its known CPU-bound processing time |
| Retrying a failed job | Status badge updates to "Retrying (attempt 2 of 4)" — visible, not hidden | Matches the product's reliability design (Technical Documentation §8) — the system is honest about retries happening, never silently masking failure-and-retry as if nothing happened |
| A long-running benchmark/report (admin screens) | Real progress bar with stage labels ("Running corpus 40/100") | Determinate work gets a determinate indicator, always |
| Optimistic UI | Used only for low-stakes, easily-reversible actions (claiming a review task, toggling a filter) — the UI updates instantly and quietly reconciles/reverts with a toast if the server rejects it | Never used for anything touching an approval, a submission, or an external action — those always wait for server confirmation given the real cost of being wrong |

**Skeletons are used sparingly and only where they match real content layout exactly** — a generic shimmering rectangle that doesn't resemble the eventual content is worse than a simple spinner, because it sets a false expectation of structure.

---

## 12. Empty States

Every empty state follows the same three-part structure: **what's happening → why → what to do next.** No decorative illustrations (per §2); a single small icon (stroke style, `text-muted`) at most.

| Type | Example | Message pattern |
|---|---|---|
| First-use (nothing created yet) | A brand-new workspace's case list | "No cases yet. Share your onboarding form's link to start collecting submissions." + a primary button to the form-link screen |
| No-results (filtered to nothing) | A queue filter that matches no cases | "No cases match these filters." + a visible "Clear filters" action (never force the user to hunt for how to reset) |
| User-created empty (user cleared something out) | All review tasks resolved | "Queue clear — nice work." (the one place Formiva allows a small moment of warmth, because it marks a genuine, earned accomplishment for the reviewer, not a system congratulating itself) |
| Permission-based | A viewer-role user opening Integrations | "You don't have access to manage integrations. Ask a workspace admin for the `integration.manage` permission." — names the actual permission, since that's genuinely actionable information for this audience |
| Error-based | A case detail that failed to load | "This case couldn't be loaded right now." + Retry button + a correlation ID visible in monospace for support purposes (never hidden from the user — Formiva's whole trust model is built on visible evidence, including when something goes wrong) |

---

## 13. Forms & Validation

**Field hierarchy:** required fields are marked with a small asterisk next to the label (not color alone); optional fields are explicitly labeled "(optional)" in muted text rather than leaving the asterisk's absence to be inferred — reduces ambiguity for respondents filling this in once, under time pressure, possibly in a second language.

**Helper text** sits between label and field, stating format expectations before the person types ("As shown on your PAN card"), not only as an error after they get it wrong.

**Validation timing:** on-blur for most fields; as-typed for pattern-constrained fields once minimum plausible length is reached (§8); on-submit as a final full-form check that scrolls to and focuses the first error.

**Autosave vs. explicit save:** the respondent form autosaves per field (so a dropped connection doesn't lose progress); internal admin forms (workflow editor, policy settings) use the draft/publish model (§8) with visible autosave on the draft and an explicit, confirmed Publish action.

**Unsaved changes:** if a user navigates away from a form with genuinely unsaved state (rare, given autosave-by-default), a native browser-level confirmation is used rather than a custom modal, since this exact moment benefits from the browser's own trusted interruption pattern.

**Multi-step forms:** named steps, not numbered-only (per the frontend-design skill's guidance — a sequence is appropriate here since the content genuinely is sequential, so naming AND numbering the steps is earned, not decorative).

**Destructive actions inside a form** (removing an uploaded document, clearing a field) use inline confirmation (a brief "Remove? [Yes] [Cancel]" that replaces the action button in place) rather than a full modal, since the stakes are lower and a modal would be disproportionate friction for a simple, locally-reversible-before-submit action.

---

## 14. Accessibility

Target: **WCAG 2.2 AA**, verified with automated checks (axe) in CI plus manual keyboard/screen-reader passes before each release, per the Coding Plan's existing test strategy.

- **Keyboard navigation:** every interactive element reachable and operable via Tab/Shift+Tab/Enter/Space/Esc/Arrow keys; a visible skip-to-content link on every authenticated page; the command palette (⌘K) is keyboard-first by design.
- **Focus states:** the 2px `focus-ring` token is never suppressed (`outline: none` without a replacement is never used anywhere in Formiva's codebase — a lint rule enforces this).
- **Screen readers:** semantic HTML first (`<button>`, `<nav>`, `<table>` with real `<th>`), ARIA only to fill genuine gaps (custom select, toast live-region with `aria-live="polite"`, modal with `aria-modal` and focus trap).
- **Color contrast:** all text meets 4.5:1 (body) / 3:1 (large text) against its background at every token combination defined in §5; this is checked as part of defining the token set, not left to chance per-component.
dc  - **Reduced motion:** `prefers-reduced-motion` fully respected (§9).
- **Touch targets:** minimum 44×44px tappable area on all interactive elements at mobile/tablet breakpoints, even where the visual element (an icon button) is smaller — padding, not icon size, achieves this.
- **Semantic structure:** one `<h1>` per page (the page title), logical heading order beneath it, landmark regions (`<nav>`, `<main>`, `<aside>`) present on every authenticated page.
- **Form accessibility:** every input has a real, programmatically-associated `<label>` (never a placeholder standing in for a label); error messages are associated via `aria-describedby` and announced on appearance.
- **Non-color-dependent state:** every semantic color use (success/danger/warning) is paired with an icon and/or text label, never color alone — directly relevant given Formiva's heavy use of status and confidence indicators.

---

## 15. Responsive Design

See §6 for the full desktop → tablet → mobile breakdown of navigation and the case-detail two-pane. Additional specifics:

- **Tables → mobile:** convert to a card-per-row list showing the 3–4 triage-critical fields (case ID, submitted-by, status, priority) with full row detail one tap away — never a horizontally-scrolling shrunk table, which is unreadable at this information density.
- **Modals on mobile:** become full-screen (not a small centered box) above `640px`'s threshold downward, since a centered modal on a 375px viewport leaves no usable margin and fights with the keyboard.
- **Drawers on mobile:** become full-screen slide-ups (bottom sheet) rather than a right-side drawer, matching the platform-native pattern mobile users expect.
- **Toolbars/filters:** collapse into a single "Filters" button that opens a bottom sheet containing the same filter controls shown inline on desktop — never hide filtering capability on mobile, just relocate it.
- **Actions (bulk action bar, row action menus):** remain available on mobile via the same contextual bar pattern, anchored to the bottom of the viewport (thumb-reachable) rather than the top.
- **Content density:** mobile deliberately shows less per screen (one case at a time, one field group at a time) rather than a zoomed-out version of the desktop density — density is a desktop-specific design decision, not a universal constant to preserve at all costs.

---

## 16. Design Anti-Patterns — DO NOT DO THIS

Treat this as a guardrail checklist for every future screen.

- ❌ Wrapping arbitrary content in a rounded card with a drop shadow "because that's what SaaS products look like." Use a flat bordered panel (§2, §7).
- ❌ A second brand color, a gradient background, or glassmorphism anywhere in the authenticated product.
- ❌ Scaling or shadow-popping a button/card on hover.
- ❌ An eyebrow label in tracked-out ALL CAPS above a heading, purely for texture.
- ❌ Numbered step markers (01 / 02 / 03) on content that isn't actually sequential.
- ❌ A generic AI sparkle/magic-wand icon anywhere. Formiva's "this came from the model" signal is the teal accent + explicit evidence pairing, never a sparkle icon, which implies magic rather than inspectable process — directly contrary to the product's trust model.
- ❌ Skeleton screens that don't match the real content's shape.
- ❌ Infinite scroll on any list a reviewer must systematically process (a queue). Use pagination.
- ❌ Celebratory confetti/animation for routine actions (every approval, every save). Reserve any moment of warmth for genuinely earned milestones (§12), and even then, keep it small.
- ❌ Hiding a destructive or important action behind a double-nested overflow menu to "declutter" — if it's a common action, it gets a visible button; if it's rare but important (data export, deletion), it gets a clearly labeled menu item, not a mystery icon.
- ❌ A toast for an error that then disappears before the user can read it.
- ❌ Centering authenticated-app content the way a marketing page centers a hero section.
- ❌ Icon-only buttons with no text label and no tooltip, anywhere outside a genuinely space-constrained dense table.
- ❌ Dark patterns of any kind (hard-to-find cancel/unsubscribe, pre-checked destructive options, countdown-pressure on decisions) — categorically excluded regardless of any growth-metric justification.
- ❌ Claiming a document is "verified" anywhere in copy or UI — per the Government Documents Policy, Formiva reads and extracts, it does not verify authenticity, and the UI must never imply otherwise (e.g., no green checkmark + "Verified" label on an identity document; use "Format check passed" instead, worded precisely).
- ❌ A masked sensitive value using a casual eye-icon toggle identical to a password field — it must read as audited and deliberate (§7).
- ❌ Blurred backdrop (backdrop-filter: blur) behind modals — flat scrim only.

---

## 17. Page-Level Design Rules

Not every page gets the same visual structure — consistency comes from the shared component/token system, not from forcing every page into one template.

- **Queue (dashboard-like list):** dense table, visible filter chips, bulk-action bar on selection, summary tiles above (queue size, overdue count, by-priority breakdown) — the one page where small metric "cards" are appropriate (§7).
- **Case detail:** the two-pane evidence layout (§0, §6) is the centerpiece; a right-hand or top timeline shows the audit history compactly, collapsible.
- **Create/Edit (form definitions, workflow versions):** draft/publish model, autosave indicator always visible near the title, a persistent "Preview" affordance so a form/workflow can be checked before publishing.
- **Settings/Admin:** a simple left-hand sub-navigation within the Settings section (separate from the main sidebar, to avoid nested-nav confusion), grouped by: Workspace, Members & Roles, Document Policies, Integrations, Billing, Audit & Security.
- **Analytics (Phase 11):** charts are secondary to the underlying data table — every chart has a "View as table" affordance, since operators ultimately need exact numbers, not just a visual trend.
- **Public respondent form:** the one exception to nearly every "authenticated app" rule above — centered, single-column, larger type, warmer and more encouraging copy (§18), no sidebar, no dense tables, mobile-first above all else. This asymmetry is intentional: a once-off respondent and a daily-use reviewer are different audiences with different needs, and treating them identically would serve neither well.
- **Authentication (Clerk-hosted):** Formiva customizes Clerk's hosted components to match the token set (colors, type, radius) but does not attempt pixel-perfect custom auth screens — this is deliberately not a place to spend design effort, since it's a brief, infrequent flow.
- **Onboarding (first-run for a new workspace):** no interactive product tour overlay. Instead, the Queue page's empty state (§12) directly explains the single next action (get your form link), because structural clarity teaches better than a dismissible tour that's forgotten in a week.

---

## 18. UX Writing

**Voice:** precise, calm, plain-spoken, quietly respectful of the seriousness of the work. Never cutesy, never corporate-stiff.

- **Button labels:** name the exact action and its object — "Approve case," "Send notification," "Save draft" — never a vague "Submit" or "Continue" where a more specific verb is available. The vocabulary stays identical through a flow: a "Reject" button produces a "Rejected" status, never a "Declined" status elsewhere.
- **Empty states:** see §12 — explain what's happening, why, and the one clear next action.
- **Errors:** state exactly what happened and exactly how to fix it, in the system's voice, never apologetic ("Oops!") and never vague ("Something went wrong"). Example: "This document is larger than 10MB. Compress it or split it into smaller files."
- **Confirmation messages:** restate the action and its real consequence in plain terms: "This will reject the case and notify the respondent that more information is needed," not "Are you sure you want to proceed?"
- **Tooltips:** one short clause, no punctuation unless it's a full sentence genuinely needed.
- **Notifications:** lead with the object, then the event: "Case #1042 — review requested," not "You have a new notification."
- **Form instructions:** written from the respondent's perspective, in plain language — "Upload a photo or scan of your PAN card," not "Submit identity document artifact."
- **Success messages:** short, specific, in the system's calm register: "Saved," "Case approved," "Sent" — never an exclamation point, never "Great job!"

---

## 19. Performance & Perceived Performance

- **Instant feedback on every interaction:** button press states, checkbox checks, and hover tints render with zero perceptible delay (§9's `motion-instant`/`motion-fast` tiers) — nothing in Formiva should ever feel like it's waiting on the network for purely local UI feedback.
- **Optimistic updates** for low-stakes, reversible actions only (§11) — claiming a task, toggling a filter. Never for approvals, submissions, or anything touching an external integration, where correctness matters more than apparent speed.
- **Loading feedback calibrated to real duration:** sub-300ms operations show no loading indicator at all (a flashing spinner for 150ms reads as jankier than no indicator); 300ms–2s shows a simple spinner; 2s+ shows a spinner with status text; multi-minute operations (AI processing) show elapsed/estimated time (§11), always.
- **Transition timing** stays within the §9 ceiling (240ms max) specifically because this is a high-frequency-use product where milliseconds compound across a workday.
- **Progressive loading for large datasets:** a queue of hundreds of cases paginates server-side (never loads all rows client-side then paginates in JS) and virtualizes table rendering beyond ~100 visible rows, so scroll performance stays smooth regardless of total queue size.
- **Expensive operations** (benchmark runs, large exports) run asynchronously with a visible job status (§11) rather than blocking the UI thread or the user's session — the user can navigate away and come back to find it done.
- **The interface feels fast even when the backend is genuinely slow (AI processing):** by being explicit and precise about what's happening and how long it typically takes, rather than hiding the wait behind a generic spinner and letting the user's imagination (and frustration) fill the gap.

---

## 20. Design Quality Checklist

Run through before shipping any new screen or component:

- [ ] Does this screen answer, at a glance: where am I, what can I do, what just happened, what's next?
- [ ] Is there exactly one primary action, and is it visually obvious which one it is?
- [ ] Does every AI-extracted value sit directly next to the evidence that produced it (§0)?
- [ ] Is color used only for its defined semantic meaning — never decoratively?
- [ ] Is the teal accent used *only* to signal "this came from the AI"?
- [ ] Are panels flat and bordered, with shadow reserved only for genuinely elevated/floating surfaces?
- [ ] Is every interactive element keyboard-reachable with a visible focus state?
- [ ] Does every animation answer cause-and-effect, spatial relationship, state change, or progress — and is it under 240ms?
- [ ] Is this screen usable and complete on mobile, not just "not broken"?
- [ ] Does any element here resemble a generic AI-generated SaaS pattern (§16)? If so, cut or replace it.
- [ ] Does any element here resemble another specific product (Linear, Notion, Stripe) rather than Formiva's own system?
- [ ] Is every destructive/irreversible action appropriately confirmed, and every reversible action appropriately not over-confirmed?
- [ ] Does the copy name the exact object and action, in the system's calm, plain voice?
- [ ] Would a reviewer doing this task 40 times a day find this fast, or merely find this pretty?
- [ ] Does this page correctly reflect what the system actually does underneath (draft/publish immutability, append-only history, masked sensitive values) rather than implying capabilities the backend doesn't have?

---

## Summary of what this file locks in

1. **Design direction:** a calm, operational "records office" workstation — not a startup dashboard, not a marketing product. Density with order, evidence always paired with its source, restraint as the primary design tool.
2. **Major UX principles:** clarity over cleverness, hierarchy by position/weight not color, one accent color with one meaning, consistency as a promise to daily users, speed treated as a design requirement.
3. **Visual identity:** inherited blue/teal/Inter-Geist/8px-radius tokens, built out into a disciplined neutral-first palette, a three-level flat surface hierarchy (canvas/panel/overlay) where shadows are earned rather than default, and monospace reserved for genuinely machine-precise data.
4. **Motion philosophy:** every animation must justify itself against cause-effect/spatial/state/progress; nothing exceeds 240ms; exactly one spring-eased moment of warmth exists in the entire product, reserved for genuine milestones.
5. **Anti-patterns prohibited:** rounded-card-with-shadow-on-everything, gradients/glassmorphism, AI sparkle iconography, hover-scale effects, tracked-out eyebrow labels, decorative numbered steps, infinite scroll on worklists, confetti for routine actions, and any UI implying document "verification" that the backend does not actually perform.
6. **Existing patterns preserved:** the inherited brand colors, type family, and corner radius were kept exactly as locked; nothing here contradicts them — the distinctiveness comes from everything built around them (surface hierarchy, density, motion discipline, evidence-pairing layout) rather than from replacing the brand itself.
