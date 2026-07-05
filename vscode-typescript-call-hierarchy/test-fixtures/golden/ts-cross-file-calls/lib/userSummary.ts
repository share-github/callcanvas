import { buildGreeting } from "./greeting";

export function getDisplayName(raw: string): string {
  const t = raw.trim();
  return t.length > 0 ? t : "Guest";
}

export function buildUserSummary(name: string): string {
  return buildGreeting(getDisplayName(name));
}
