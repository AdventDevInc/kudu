# Kudu dashboard design studio

Five interactive design directions for feedback, built with the existing React stack,
Lucide icons, Kudu logo, and amber accent. These are deliberately separate from the
production renderer while a direction is being selected.

## Open the studio

```sh
npm ci
npm run dev:concepts
```

Visit <http://127.0.0.1:5185/dashboard-concepts.html?v=1>. The numbered tabs switch
concepts, and the `v` query parameter links directly to each version.

| Version | Direction | Main change |
| --- | --- | --- |
| 1 | Refined | Familiar overview with a stronger cleanup action, health ring, and clear supporting cards. |
| 2 | Focus | Calm, centered layout with one primary task and fewer competing elements. |
| 3 | Pulse | Performance-first composition with a time-range chart, telemetry, and Game Mode. |
| 4 | Daylight | Warm light surfaces, a dark sidebar, soft green status accents, and amber actions. |
| 5 | Canvas | Expressive amber cleanup tile, memory blocks, recovery chart, and modular care widgets. |

## Interactions

- Primary cleanup actions open a review dialog with selectable categories and a computed total.
- Deselecting every category disables the simulated cleanup action.
- Completing a preview displays a confirmation; no files are changed.
- Game Mode toggles a local preview state in Pulse and Canvas.
- Pulse's time-range selector changes the sample chart.
- Navigation and detail links open illustrative information panels.
- Native dialogs support keyboard focus containment, Escape, and focus restoration.
- Layouts adapt to smaller windows and honor reduced-motion preferences.

All metrics, device details, scan findings, histories, and cleanup results are **sample
data**. The studio never imports the Electron bridge, performs scans, modifies
settings, or deletes files. Panels outside the dashboard illustrate interaction
styling; they are not full redesigns of those application pages. Text is English-only
for concept review; the selected production direction should use Kudu's existing
translations and real stores.

## Validation

```sh
npm run typecheck
npx eslint src/renderer/src/design-lab dashboard-concepts.config.ts
npx prettier --check dashboard-concepts.config.ts src/renderer/dashboard-concepts.html src/renderer/src/design-lab docs/dashboard-concepts.md package.json
npm run build:concepts
```

The separate build is written to `out/dashboard-concepts`. The normal Electron
build entry and dashboard behavior remain unchanged.
