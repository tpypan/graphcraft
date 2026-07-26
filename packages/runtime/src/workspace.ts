export interface RunWorkspace {
  path: string;
  branch: string;
  created: boolean;
}

const RUN_WORKSPACE_PATH_MAX_CHARACTERS = 32 * 1024;
const RUN_WORKSPACE_BRANCH_MAX_CHARACTERS = 1024;

export class RunWorkspaceRecordError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`The durable run workspace record is invalid: ${detail}`, options);
    this.name = "RunWorkspaceRecordError";
  }
}

function boundedWorkspaceString(
  value: unknown,
  field: "path" | "branch",
  maximumCharacters: number,
): string {
  if (typeof value !== "string" || value.length === 0)
    throw new RunWorkspaceRecordError(`${field} must be a non-empty string`);
  if (value.length > maximumCharacters)
    throw new RunWorkspaceRecordError(`${field} exceeds its character limit`);
  if (value.includes("\0"))
    throw new RunWorkspaceRecordError(`${field} cannot contain NUL characters`);
  return value;
}

export function parseRunWorkspace(value: unknown): RunWorkspace {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RunWorkspaceRecordError("the record must be an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "branch" || keys[1] !== "created" || keys[2] !== "path")
    throw new RunWorkspaceRecordError("the record must contain only path, branch, and created");
  if (typeof record.created !== "boolean")
    throw new RunWorkspaceRecordError("created must be a boolean");
  return {
    path: boundedWorkspaceString(record.path, "path", RUN_WORKSPACE_PATH_MAX_CHARACTERS),
    branch: boundedWorkspaceString(record.branch, "branch", RUN_WORKSPACE_BRANCH_MAX_CHARACTERS),
    created: record.created,
  };
}
