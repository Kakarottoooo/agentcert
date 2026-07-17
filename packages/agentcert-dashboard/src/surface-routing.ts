export type ProductSurface = "home" | "public-evidence" | "pricing" | "security" | "email-verification" | "workspace" | "not-found";

export type ProductPath = "/" | "/evidence" | "/pricing" | "/security" | "/verify-email" | "/app";

export interface SurfaceRoute {
  surface: ProductSurface;
  access: "public" | "authenticated";
  canonicalPath: ProductPath;
  normalizedPath?: ProductPath;
}

export function resolveHostedSurface(pathname: string, hash = ""): SurfaceRoute {
  if (isAuthCallback(hash)) {
    return {
      surface: "workspace",
      access: "authenticated",
      canonicalPath: "/app",
      ...(pathname === "/app" ? {} : { normalizedPath: "/app" as const }),
    };
  }

  if (pathname === "/") {
    return {
      surface: "home",
      access: "public",
      canonicalPath: "/",
    };
  }

  if (pathname === "/evidence" || pathname === "/evidence/" || pathname === "/demo" || pathname === "/demo/") {
    return {
      surface: "public-evidence",
      access: "public",
      canonicalPath: "/evidence",
      ...(pathname === "/evidence" ? {} : { normalizedPath: "/evidence" as const }),
    };
  }

  if (pathname === "/pricing" || pathname === "/pricing/") {
    return {
      surface: "pricing",
      access: "public",
      canonicalPath: "/pricing",
      ...(pathname === "/pricing" ? {} : { normalizedPath: "/pricing" as const }),
    };
  }

  if (pathname === "/security" || pathname === "/security/") {
    return {
      surface: "security",
      access: "public",
      canonicalPath: "/security",
      ...(pathname === "/security" ? {} : { normalizedPath: "/security" as const }),
    };
  }

  if (pathname === "/verify-email" || pathname === "/verify-email/") {
    return {
      surface: "email-verification",
      access: "public",
      canonicalPath: "/verify-email",
      ...(pathname === "/verify-email" ? {} : { normalizedPath: "/verify-email" as const }),
    };
  }

  if (pathname === "/app" || pathname === "/app/") {
    return {
      surface: "workspace",
      access: "authenticated",
      canonicalPath: "/app",
      ...(pathname === "/app" ? {} : { normalizedPath: "/app" as const }),
    };
  }

  return { surface: "not-found", access: "public", canonicalPath: "/" };
}

export function absoluteSurfaceUrl(publicUrl: string, path: ProductPath): string {
  return `${publicUrl.replace(/\/+$/, "")}${path}`;
}

export function isPublicArchiveLocation(location: Pick<Location, "hostname" | "pathname" | "protocol">): boolean {
  return location.protocol === "file:"
    || location.hostname.endsWith("github.io")
    || location.pathname.includes("/public-demo/agentcert-monitor");
}

function isAuthCallback(hash: string): boolean {
  if (!hash) return false;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return params.has("access_token") || params.has("error");
}
