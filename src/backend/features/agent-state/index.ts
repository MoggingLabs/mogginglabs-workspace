// The agent-state feature is (for now) a library consumed by the terminal feature
// rather than an IPC module — not every feature owns channels. When it grows a
// quiescence heuristic or standalone queries, add a FeatureModule here.
export * from './osc-parser'
