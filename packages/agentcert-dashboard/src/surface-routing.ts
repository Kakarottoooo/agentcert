export type ProductSurface = "public-demo" | "workspace" | "not-found";

export interface SurfaceRoute {
  surface: ProductSurface;
  access: "public" | "authenticated";
  canonicalPath: "/demo" | "/app";
  normalizedPath?: "/demo" | "/app";
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

  if (pathname === "/" || pathname === "/demo" || pathname === "/demo/") {
    return {
      surface: "public-demo",
      access: "public",
      canonicalPath: "/demo",
      ...(pathname === "/demo" ? {} : { normalizedPath: "/demo" as const }),
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

  return { surface: "not-found", access: "public", canonicalPath: "/demo" };
}

export function absoluteSurfaceUrl(publicUrl: string, path: "/demo" | "/app"): string {
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
