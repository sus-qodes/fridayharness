# Friday — landing page (design exercise)

A single static page, zero dependencies, no build step. It exists to practice one thing:
**taking the Studio's own design system to a marketing page** — the same tokens, the same springs,
the same components, per the rules in `docs/ui-redesign-changelog.md` (Phase 5) and
`docs/frontend/PLAN.md` §6–7.

## Run it

Open `index.html` directly in a browser (classic scripts, no modules), or serve the folder:

```
npx serve site
# or: python -m http.server -d site 8080
```

## Structure

```
index.html            the page (all copy lives here)
css/tokens.css        apps/ui tokens, verbatim + one marketing type/spacing extension
css/base.css          reset, canvas, focus ring, selection, reduced motion
css/components.css    the island, buttons, cards, chips, tags, mascot holders (ported values)
css/sections.css      nav, hero, sections, diagrams, breakpoints (1440/1100/720)
js/spring.js          Hooke springs, 1/240 s substeps — port of apps/ui/src/notch/spring.ts
js/mascot.js          the duck — port of apps/ui/src/mascot/svg.ts + accessories.ts + a light driver
js/island.js          island FSM + springs — port of apps/ui/src/notch/island.ts + island-fsm.ts
js/main.js            wiring: launch sequence, scenario cycle, reveals, CTAs
assets/favicon.svg    the mark (copy of apps/ui/public/favicon.svg)
```

## Mapping: site element to app component

| Site element | Ported from |
| --- | --- |
| The island at the top of the page | `apps/ui/src/notch/island.ts` (geometry springs), `island-fsm.ts` (timings, pin invariant), `styles/notch.css` (surface, tags, banner) |
| The duck (hero island, showcase, Studio mock, final CTA) | `apps/ui/src/mascot/svg.ts` + `accessories.ts` (paths, palette, six states, six accessories), `mascot.css` (overflow) |
| Product mark (nav, footer, diagram) | `apps/ui/src/shell/mark.ts` + `shell.css` `.sh-mark-*` |
| Buttons, cards, chips | `apps/ui/src/styles/base.css` `.btn` / `.card` |
| Glass nav | `apps/ui/src/styles/shell.css` `.sh-header` |
| Status tints and dots | Apple semantic palette (changelog Phase 5) and `notch.css` `.nt-tag` / `.nt-dot` |
| Spring presets (reveals, hop) | changelog presets: snappy 340/28, smooth 240/24, bouncy 180/14, gentle 120/18 |
| Pillar panels (ledger, AST bars, DAG, checklist) | written for the page with the app's tokens; vocabulary from `packages/events` (append-only spine), `packages/code-graph` (slices), `packages/git` (worktrees), `packages/policy` (reservations) |

## The design rules, and how this page obeys them

- **Zero gradients in layout.** The only gradients on the page live inside the duck artwork itself,
  which is the character spec (`docs/MASCOT_SHOWCASE.md`). The hero/Studio dot grids are SVG
  `<pattern>` circles, not CSS gradient paint.
- **Zero emojis.** Icons are inline stroke SVGs; status is shown with semantic dots and tags.
- **Monochrome, color only where it indicates.** The page is ink/dim/hairline grey. The four Apple
  status tints appear only on status (tags, dots, checks, diagram accents). The duck's yellow marks
  exactly one thing everywhere it appears: Friday itself.
- **Physics-based motion.** The island's width/height/radius, the scroll reveals and the duck's hop
  are real damped springs (semi-implicit Euler, 1/240 s substeps) — not CSS durations. Press
  feedback (`scale(0.94)`) is on every button, as in the app.
- **Reduced motion.** Springs jump to their targets, reveals fade, decorative loops stop
  (plan §6 rule 6).

## Content strategy (the showcase-script adaptation)

The page follows the showcase script's narrative — hook, wrapper, then the pillars — adapted to a
static page and kept honest:

1. **Hero hook**: "Your context belongs to your project. Not to any harness." — with the product's
   own component (the island) live in the first viewport instead of a screenshot.
2. **The problem**: four agitation cards + the silo diagram (isolated terminal tabs, lost memory,
   unwatched writes, wholesale exfiltration).
3. **Meet Friday**: the unified local brain — loopback infrastructure, the append-only ledger, the
   goal→plan→task→agent→verify→git flow as architecture facts.
4. **The four pillars** (the script's Second/Third/Fourth):
   - *Memory* — the append-only event ledger visual (events appended, never rewritten).
   - *Tokens* — the whole-codebase prompt vs the pre-computed AST slice, with a comparison bar.
   - *Intent* — the deterministic DAG, isolated Git worktrees and file reservations
     (the write policy's own word, ADR-0025).
   - *Verification* — "AI can never lie to you": an unverified claim until lint, typecheck and
     tests deterministically prove it.
5. **Governance**: the Notch showcase — one-click approval without stealing focus, the pin invariant.
6. **Also on board**: a bento grid for the rest of the system — the Studio canvas, routing and
   budget, recovery fencing, guided onboarding, tray and shortcuts, one daemon per clone.
7. **Beliefs and the final CTA** ("Run your AI agents with Friday.").

No testimonials or invented metrics: proof is architectural. The two illustrative mocks (token
bars, routing rows) demonstrate UI, not measured results.

## Before this goes anywhere real

- The download CTAs open `https://github.com/sus-qodes/fridayharness/releases/latest`, the release page with
  the desktop installer, the `friday` package and the install steps; the GitHub CTAs open the repository.
- The Studio mock, checklist and routing panels are illustrative mocks, not screenshots — swap in
  real captures when the UI settles.
