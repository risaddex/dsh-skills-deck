# Coding Standards

## Keep unknown relationships unknown

Never turn an absent relationship field, such as `blockedBy`, into an empty array or `null`.
An absent field means the relationship is unknown. An empty array means the backend confirmed that no relationship exists.
Consumers must treat unknown relationships conservatively: for example, do not show a ticket as ready when its blockers are unknown.
Use `src/shared/snapshot-row-fields.ts` as the reference for preserving this distinction between unknown and confirmed-empty values.
