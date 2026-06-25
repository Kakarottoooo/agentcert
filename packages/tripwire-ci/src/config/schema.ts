import { z } from "zod";
import type { TripwireConfig } from "../types.js";

const captureSchema = z
  .object({
    intervalMs: z.number().int().positive().default(1000),
    screenshots: z.boolean().default(true),
    domSnapshots: z.boolean().default(true),
    accessibilitySnapshots: z.boolean().default(false)
  })
  .default({ intervalMs: 1000, screenshots: true, domSnapshots: true, accessibilitySnapshots: false });

const agentSchema = z.object({
  command: z.string().min(1, "agent.command is required"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({})
});

const assertionSchema = z.object({
  type: z.enum([
    "url_contains",
    "text_exists",
    "text_not_exists",
    "element_exists",
    "element_not_exists",
    "network_call_made",
    "network_call_not_made",
    "max_steps",
    "no_console_error",
    "no_sensitive_text_in_output"
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
});

const faultBase = {
  name: z.string().min(1, "fault.name is required"),
  optional: z.boolean().optional()
};

const faultSchema = z.discriminatedUnion("type", [
  z.object({ ...faultBase, type: z.literal("none") }),
  z.object({ ...faultBase, type: z.literal("modal_overlay"), delayMs: z.number().int().nonnegative().optional() }),
  z.object({
    ...faultBase,
    type: z.literal("slow_network"),
    delayMs: z.number().int().nonnegative().default(1000),
    match: z.string().optional()
  }),
  z.object({
    ...faultBase,
    type: z.literal("http_failure"),
    status: z.number().int().min(300).max(599).default(500),
    match: z.string().optional()
  }),
  z.object({
    ...faultBase,
    type: z.literal("changed_button_text"),
    from: z.string().min(1),
    to: z.string().min(1)
  }),
  z.object({ ...faultBase, type: z.literal("prompt_injection_banner"), text: z.string().min(1) }),
  z.object({ ...faultBase, type: z.literal("misleading_button"), text: z.string().min(1).default("Submit") }),
  z.object({
    ...faultBase,
    type: z.literal("disabled_submit"),
    buttonText: z.string().min(1).default("Submit"),
    delayMs: z.number().int().nonnegative().default(3000)
  }),
  z.object({
    ...faultBase,
    type: z.literal("layout_shift"),
    delayMs: z.number().int().nonnegative().default(500),
    heightPx: z.number().int().positive().default(240)
  })
]);

const defaultsSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(60_000),
    headless: z.boolean().default(true),
    capture: captureSchema
  })
  .default({
    timeoutMs: 60_000,
    headless: true,
    capture: { intervalMs: 1000, screenshots: true, domSnapshots: true, accessibilitySnapshots: false }
  });

const rawScenarioSchema = z.object({
  name: z.string().min(1, "scenario.name is required"),
  startUrl: z.string().url("scenario.startUrl must be a valid URL"),
  agent: agentSchema,
  success: z.array(assertionSchema).default([]),
  faults: z.array(faultSchema).min(1).default([{ name: "clean", type: "none" }]),
  timeoutMs: z.number().int().positive().optional(),
  headless: z.boolean().optional(),
  capture: captureSchema.optional()
});

export const tripwireConfigSchema = z
  .object({
    version: z.string().default("0.1"),
    project: z.string().min(1).default("tripwire-project"),
    defaults: defaultsSchema,
    gate: z.object({ failUnder: z.number().min(0).max(1).default(0.8) }).default({ failUnder: 0.8 }),
    scenarios: z.array(rawScenarioSchema).min(1, "At least one scenario is required")
  })
  .transform((config) => {
    const defaults = config.defaults;
    return {
      ...config,
      scenarios: config.scenarios.map((scenario) => ({
        ...scenario,
        timeoutMs: scenario.timeoutMs ?? defaults.timeoutMs,
        headless: scenario.headless ?? defaults.headless,
        capture: { ...defaults.capture, ...(scenario.capture ?? {}) }
      }))
    };
  });

export function formatConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export type ParsedTripwireConfig = TripwireConfig;
