import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { formatConfigError, tripwireConfigSchema } from "./schema.js";
import type { TripwireConfig } from "../types.js";

export async function loadConfig(file: string): Promise<TripwireConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Could not read config file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse YAML in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return tripwireConfigSchema.parse(parsed) as TripwireConfig;
  } catch (error) {
    throw new Error(`Invalid Tripwire config ${file}:\n${formatConfigError(error)}`);
  }
}
