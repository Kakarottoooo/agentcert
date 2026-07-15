import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface StoredArtifact {
  objectKey: string;
  bytes: Buffer;
  contentType: string;
}

export interface ArtifactStore {
  put(objectKey: string, bytes: Buffer, contentType: string): Promise<void>;
  get(objectKey: string): Promise<StoredArtifact | undefined>;
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();

  async put(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    this.artifacts.set(objectKey, { objectKey, bytes: Buffer.from(bytes), contentType });
  }

  async get(objectKey: string): Promise<StoredArtifact | undefined> {
    return this.artifacts.get(objectKey);
  }
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(objectKey: string, bytes: Buffer, _contentType: string): Promise<void> {
    const path = safeLocalPath(this.root, objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(objectKey: string): Promise<StoredArtifact | undefined> {
    try {
      return { objectKey, bytes: await readFile(safeLocalPath(this.root, objectKey)), contentType: "application/octet-stream" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class SupabaseArtifactStore implements ArtifactStore {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string,
  ) {}

  async put(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await fetch(this.objectUrl(objectKey), {
      method: "POST",
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": contentType,
        "x-upsert": "true",
      },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw new Error(`Object storage upload failed (${response.status}): ${await response.text()}`);
    }
  }

  async get(objectKey: string): Promise<StoredArtifact | undefined> {
    const response = await fetch(this.objectUrl(objectKey), {
      headers: { apikey: this.serviceRoleKey, authorization: `Bearer ${this.serviceRoleKey}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Object storage read failed (${response.status}).`);
    return {
      objectKey,
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private objectUrl(objectKey: string): string {
    const segments = objectKey.split("/").map(encodeURIComponent).join("/");
    return `${this.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(this.bucket)}/${segments}`;
  }
}

function safeLocalPath(root: string, objectKey: string): string {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, objectKey);
  if (path !== resolvedRoot && !path.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Artifact path must stay within the configured artifact root.");
  }
  return path;
}
