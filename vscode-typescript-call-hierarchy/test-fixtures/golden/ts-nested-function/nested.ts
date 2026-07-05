import { saveNote } from "./actions";
import { takeCallback } from "./callbacks";

export function outer() {
  async function onSubmit() {
    await saveNote();
  }
  takeCallback(onSubmit);
}
