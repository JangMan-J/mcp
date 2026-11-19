/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "packages-never-import-adapters",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^adapters/" }
    },
    {
      name: "packages-never-import-pi-or-sdk",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "(@earendil-works/pi-|@mariozechner/pi-|@jangmanj/pi-mcp-ext|@modelcontextprotocol/sdk|pi-mcp-ext)" }
    },
    {
      name: "core-self-contained-no-node",
      severity: "error",
      from: { path: "^packages/core/" },
      to: {
        pathNot: "^packages/core/",
        dependencyTypesNot: ["type-only"]
      }
    },
    {
      name: "core-no-node-builtins",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { dependencyTypes: ["core"] }
    },
    {
      name: "fixtures-only-core-types",
      severity: "error",
      from: { path: "^packages/fixtures/" },
      to: {
        path: "^packages/(?!core/|fixtures/)",
        pathNot: "^packages/core/"
      }
    },
    {
      name: "ops-auth-mrtr-never-import-transports",
      severity: "error",
      from: { path: "^packages/(ops|auth|mrtr-cache)/" },
      to: { path: "^packages/transport-" }
    },
    {
      name: "transport-http-never-imports-auth",
      severity: "error",
      from: { path: "^packages/transport-http/" },
      to: { path: "^packages/auth/" }
    },
    {
      name: "core-ops-transports-never-import-extensions",
      severity: "error",
      from: { path: "^packages/(core|ops|transport-|auth|mrtr-cache)/" },
      to: { path: "^packages/ext-" }
    },
    {
      name: "no-deep-cross-package-imports",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/src/",
        pathNot: "^packages/$1/"
      }
    }
  ],
  options: {
    doNotFollow: {
      path: "node_modules"
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json"
    }
  }
};
