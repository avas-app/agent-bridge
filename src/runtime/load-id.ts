/**
 * One per JS bundle load. Module level on purpose: Fast Refresh re-runs the
 * hook that starts the bridge but keeps the modules (and the undo state they
 * hold), while a reload starts over. Only a reload changes this.
 */
export const loadId = Math.random().toString(36).slice(2, 10)
