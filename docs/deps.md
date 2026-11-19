# Dependency Policy & Registry

Every dependency in `package.json` and `package-lock.json` is justified, exact-pinned (no `^` or `~` ranges), and isolated behind a replaceable module/script boundary per `IMPLEMENTATION_PLAN.md` §4.7.

## Production dependencies (`packages/*`)

`@mcp-client/core`, `@mcp-client/fixtures`, `@mcp-client/conformance`, `@mcp-client/transport-stdio`, and `@mcp-client/transport-http` have zero third-party runtime dependencies.

| Package | Version | Purpose | Why not hand-written / platform | License | Last release | Integrity (npm) | Removal boundary | Security note |
|---|---|---|---|---|---|---|---|---|
| `ajv` | `8.20.0` | JSON Schema 2020-12 compilation and validation (`ajv/dist/2020`) in `packages/ops` | 2020-12 vocabulary (`$dynamicRef`, `unevaluated*`) is large and validator bugs are security-relevant | `MIT` | `2026` | `sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==` | Isolated behind `SchemaValidator` in `packages/ops/src/schema.ts` | No network `$ref`; compiled locally |

## Development & conformance tooling (`devDependencies`)

| Package | Version | Purpose | Why not hand-written / platform | License | Last release | Integrity (npm) | Removal boundary | Security note |
|---|---|---|---|---|---|---|---|---|
| `typescript` | `7.0.2` | Type checking and ESM build (`tsc -b`) | Standard compiler for strict TypeScript workspace | `Apache-2.0` | `2026-11-18` | `sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==` | Dev compiler only; ships built JS in `dist/` | Not loaded at runtime |
| `vitest` | `5.1.1` | Unit and package test runner | Fast TypeScript ESM test runner for `packages/*/test` | `MIT` | `2026-11-18` | `sha512-trVmzUFOSraCZcI3uZIMD5FqBh4atFkC/XuJP/IU7qtyQay0FCs3Ia+0QiQ2JJwGyWG/xrcBoJNel2+O7kEZ0g==` | Test runner only; conformance runner uses Node ESM directly | Not loaded at runtime |
| `dependency-cruiser` | `18.8.0` | Machine-checks §4.3 package/import boundaries | Full TS/ESM graph analyzer against `.dependency-cruiser.cjs` | `MIT` | `2026-11-16` | `sha512-GNrm+vy8qSM0X3l3n6616iDdWDIvhnQzimd4q/csyusz8ZYrniFzIIOP1uixXXVkt9mVMcRE6vM5f6juKV5etQ==` | Invoked only by `npm run check:deps` | Not loaded at runtime |
| `json-schema-to-typescript` | `16.0.0` | Generates `packages/core/src/schema/types.ts` from pinned `schema.json` | Full Draft 2020-12 `$defs`/`allOf`/`oneOf` generator | `MIT` | `2026-08-28` | `sha512-Ah6kK4q6SjlMzWBH1eNOQkdRh5Qhr5T/RCFwfjQqWZA7UDW+N47A8wfyoiN0L884s4L4bAEI54IjIuN3/u0B/A==` | Build-time codegen script `scripts/gen-schema-types.mjs` only | Not loaded at runtime |
| `@types/node` | `26.6.6` | Node type declarations for `fixtures` / `conformance` test harnesses | Tracks Node 26 built-in APIs for non-`core` packages | `MIT` | `2026-10-28` | `sha512-MzQj+8Kx3XI40OmUAE6Qoh58ZMNstNNMwn2nfd3qWsfe7nDNSqJNzes4njhz6AHwrSHOffSLwXU6yb474Q4aog==` | Excluded from `packages/core/tsconfig.json` | Type-only |
| `fast-check` | `4.10.3` | Property-based testing (SSE chunk-split invariants, etc.) | Shrinking and deterministic seeded generators for fuzz/property tests | `MIT` | `2026` | `sha512-SBaU6nhh+sXxb05r2IHAKfxnR/1Pu6MqtHYaewM1BY6V5xzOxOk+4yoWO7WfeeyZG1iArFE6/DO/7iLYMUuOJg==` | Test files only (`packages/*/test`) | Not loaded at runtime |
