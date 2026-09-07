// Minimal className join: drop falsy values, space-separate the rest.
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
