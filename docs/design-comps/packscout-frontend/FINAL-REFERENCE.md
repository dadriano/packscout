# PackScout Dashboard V1 Final Reference

These two 1536×1024 images are the approved visual source of truth for the PackScout Repack Dashboard V1 planning artifacts.

| Theme | File | SHA-256 |
|---|---|---|
| Light | `final-dashboard-v1-light.png` | `0c7f3eed899445920c14c2949cb42b20aecded9f7d5abc4c8cfc36a4b2cee50d` |
| Dark | `final-dashboard-v1-dark.png` | `c492dbf971dcd8d5450d1abcf08d49c4867e3a9ae881fef4678f1b17bec4b538` |

## Precedence

1. Use these final files for layout hierarchy, density, theme parity, and visual QA.
2. Use `.tasks/repack-dashboard/_index.md` and numbered task PRDs for product behavior and deliberate departures from the images.
3. Use the approved production logo exports under `apps/frontend/public/brand/`.
4. Treat the other files in this directory as historical design exploration.

## Required Departures

- Show all four KPI cards in both themes.
- Remove the bookmark control, Net EV, fee/shipping/cost rows, and EV donut.
- Use the Overview side inspector, the All Packs bottom preview, and a narrow-screen modal sheet.
- Preserve the public anonymous experience without account or saved-state controls.
- Review the exact comps at 1536×1024 plus responsive behavior at 1440×1000 and 390×844.
