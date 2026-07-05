import { buildGreeting } from "./greeting";

export function buildApiSummary(name: string): string {
  return buildGreeting(name);
}
