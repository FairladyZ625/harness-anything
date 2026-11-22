# `@harness-anything/gui-fde`

Independent Forward Deployed Engineer (FDE) visual domain workbench and live materialization / completion-gate simulator (`dec_42EB7B8F636C12381A447E52A3/CH2`).

## Boundaries

- Allowed internal dependencies: `@harness-anything/daemon`, `@harness-anything/kernel`, `@harness-anything/preset`, `@harness-anything/authorization` (declared only when imported in `src/`).
- Strictly decoupled from `@harness-anything/gui` (no imports in either direction).
- All vertical/preset scaffolding, schema validation, and completion-gate probing delegate to `@harness-anything/preset` (`planVerticalScaffold`, `scaffoldVerticalPackage`, `planPresetScaffold`, `scaffoldPresetPackage`, `simulateVerticalPackage`) and `@harness-anything/kernel` (`validateDossierSlots`).

## Commands

```bash
npm run build -w @harness-anything/gui-fde
ha fde --browser --root <repo-path>
ha fde --root <repo-path>
```
