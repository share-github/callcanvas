export function validateNoteInput(input: unknown): boolean {
  return input !== null && typeof input === "object";
}
