// How long services keep finished records. Journals snapshot whole SQLite files, so rows that no longer
// decide anything (archived approvals and commitments, settled transactions, finished orders) are
// deleted once they are older than this, keeping snapshots small without touching live state.

/** Thirty days: long enough to review an incident, short enough that journals stay small. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The newest timestamp (ms) a finished record may have and still be deleted at `nowMs`. */
export const retentionCutoff = (nowMs = Date.now(), retentionMs = RETENTION_MS) => nowMs - retentionMs;
