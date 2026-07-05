"use server";

import { validateNoteInput } from "../../lib/validateNoteInput";

export async function createNoteAction(input: unknown): Promise<{ ok: boolean }> {
  const v = validateNoteInput(input);
  return { ok: v };
}
