export function buildGreeting(name: string): string {
  const trimmed = name.trim();
  return `Hello, ${trimmed.length > 0 ? trimmed : "there"}`;
}
