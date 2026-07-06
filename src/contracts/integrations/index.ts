// Integrations contracts (Phase-8/01, ADR 0008): the tool catalog, the
// workspace grant, the trail, the bridge, presets, and the service seam —
// pure data shapes + the catalog's load-time assert. Ships zero runtime;
// every phase-8 lane builds on this slice.
export * from './mcp'
export * from './grant'
export * from './trail'
export * from './bridge'
export * from './presets'
export * from './services'
