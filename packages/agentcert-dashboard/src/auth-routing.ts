export type AuthMode = "signin" | "signup";

export function resolveAuthMode(search: string): AuthMode {
  return new URLSearchParams(search).get("mode") === "signup" ? "signup" : "signin";
}
