export const CHECKPOINT_OPERATIONS = { restore: 'Before restore' } as const;

export type CheckpointOperation = keyof typeof CHECKPOINT_OPERATIONS;

export function isCheckpointOperation(value: unknown): value is CheckpointOperation {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHECKPOINT_OPERATIONS, value);
}

export function checkpointLabelFor(op: CheckpointOperation): string {
  if (!isCheckpointOperation(op)) throw new Error('unknown checkpoint operation');
  return CHECKPOINT_OPERATIONS[op];
}
