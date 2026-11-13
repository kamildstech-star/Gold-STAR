export type SharedRecordType = "lead" | "job" | "account" | "project" | "invoice";
export type SharePickerType = Exclude<SharedRecordType, "lead">;

/** A missing capability on an older database keeps legacy sharing available. */
export function supportedShareTypes(value: unknown): SharePickerType[] {
  const types: SharePickerType[] = ["job", "account"];
  if (Array.isArray(value)) {
    if (value.includes("project")) types.push("project");
    if (value.includes("invoice")) types.push("invoice");
  }
  return types;
}

export function sharedRecordPath(
  type: SharedRecordType,
  id: string,
  jobId?: string | null,
): string {
  if (type === "job") return `/jobs/${id}`;
  if (type === "project") return `/projects/${id}`;
  if (type === "invoice") return jobId ? `/jobs/${jobId}` : "/billing";
  return `/accounts/${id}`;
}
