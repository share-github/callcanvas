"use client";

import { saveNoteAction } from "../app/actions/saveNote";

export function NoteFormCallCanvas() {
  return (
    <button type="button" onClick={() => saveNoteAction({})}>
      Save
    </button>
  );
}
