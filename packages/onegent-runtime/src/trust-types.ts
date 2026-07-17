import type {
  ActionExecutionSummary,
  ActionIntent,
  ActionType,
  CreateActionIntentInput,
  LocalActionAdapter,
  VerificationResult,
} from "./types.js";

export const EVIDENCE_STRENGTH_LEVELS = [
  "reported",
  "recorded",
  "enforced",
  "outcome_verified",
  "independently_reviewed",
] as const;

export type EvidenceStrengthLevel = (typeof EVIDENCE_STRENGTH_LEVELS)[number];

export interface EvidenceStrengthAssessment {
  schemaVersion: "agentcert.evidence_strength.v0.1";
  level: EvidenceStrengthLevel;
  claims: string[];
  limitations: string[];
}

export interface CollectorIdentity {
  id: string;
  version: string;
  keyId: string;
  publicKeySha256: string;
  environment: string;
}

export interface SourceSigner {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem?: string;
}

export interface SourceSignature {
  algorithm: "Ed25519";
  keyId: string;
  signature: string;
}

export interface ActionMandateScope {
  actionTypes: ActionType[];
  targetSystems: string[];
  permissions: string[];
  businessObjectIds?: string[];
  recipients?: string[];
  currencies?: string[];
  maxAmount?: number;
}

export interface ActionMandatePayload {
  schemaVersion: "agentcert.action_mandate.v0.1";
  mandateId: string;
  issuer: { id: string; type: "human" | "organization" | "service" };
  subject: { principalId: string; agentVersion?: string };
  scope: ActionMandateScope;
  expectedOutcome?: Record<string, unknown>;
  policySha256: string;
  validFrom: string;
  expiresAt: string;
  issuedAt: string;
}

export interface ActionMandate extends ActionMandatePayload {
  digestSha256: string;
  sourceSignature: SourceSignature;
}

export interface CreateActionMandateInput extends Omit<ActionMandatePayload, "schemaVersion" | "issuedAt"> {
  issuedAt?: string;
}

export interface MandateVerification {
  valid: boolean;
  digestMatches: boolean;
  signatureMatches: boolean;
  active: boolean;
  errors: string[];
}

export interface MandateStore {
  readonly name: string;
  get(mandateId: string): Promise<ActionMandate | undefined>;
  put(mandate: ActionMandate): Promise<ActionMandate>;
  list(): Promise<ActionMandate[]>;
}

export type TrustedRecordType =
  | "RUN_STARTED"
  | "JOURNAL_RECOVERED"
  | "EVENTS_DROPPED"
  | "MANDATE_BOUND"
  | "ACTION_CAPTURED"
  | "APPROVAL_REQUESTED"
  | "ACTION_APPROVED"
  | "ACTION_REJECTED"
  | "EXECUTION_STARTED"
  | "EXECUTION_COMPLETED"
  | "OUTCOME_OBSERVED"
  | "VERIFICATION_PASSED"
  | "VERIFICATION_FAILED"
  | "RUN_COMPLETED";

export interface TrustedActionRecord {
  schemaVersion: "agentcert.trusted_action_record.v0.1";
  recordId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type: TrustedRecordType;
  collector: CollectorIdentity;
  previousEventHash?: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  eventHash: string;
  sourceSignature: SourceSignature;
}

export interface JournalGap {
  afterSequence: number;
  beforeSequence: number;
  missing: number;
  declared: boolean;
}

export interface JournalValidation {
  valid: boolean;
  complete: boolean;
  sourceSigned: boolean;
  gaps: JournalGap[];
  duplicateSequences: number[];
  duplicateRecordIds: string[];
  hashMismatches: number[];
  signatureFailures: number[];
  droppedEventCount: number;
  recoveredTailBytes: number;
  errors: string[];
}

export interface TrustedRunReceipt {
  schemaVersion: "agentcert.trusted_run_receipt.v0.1";
  runId: string;
  collector: CollectorIdentity;
  startedAt: string;
  completedAt: string;
  eventCount: number;
  droppedEventCount: number;
  firstEventHash: string;
  lastEventHash: string;
  mandateDigests: string[];
  actionIds: string[];
  journal: JournalValidation;
  evidenceStrength: EvidenceStrengthAssessment;
  sourcePublicKeyPem: string;
  receiptSha256: string;
  sourceSignature: SourceSignature;
}

export interface TrustedRecorderSink {
  name: string;
  write(record: TrustedActionRecord): Promise<void>;
}

export interface ControlledAdapterBoundary {
  mode: "agentcert_gateway";
  credentials: "gateway_managed";
  bypassPrevention: "credentials_unavailable_to_agent";
  allowedActionTypes: ActionType[];
  allowedTargetSystems: string[];
}

export interface ControlledActionAdapter extends LocalActionAdapter {
  control: ControlledAdapterBoundary;
}

export interface OutcomeObservation {
  observationId: string;
  observedAt: string;
  observedState: Record<string, unknown>;
  source: string;
}

export interface IndependentOutcomeProbe {
  name: string;
  independent: true;
  observe(action: ActionIntent, execution: ActionExecutionSummary): Promise<OutcomeObservation>;
}

export interface TrustedActionEvidence {
  schemaVersion: "agentcert.trusted_action_evidence.v0.1";
  mandate: ActionMandate;
  runReceipt: TrustedRunReceipt;
  outcomeObservation?: OutcomeObservation;
  verification?: VerificationResult;
  evidenceStrength: EvidenceStrengthAssessment;
}

export interface TrustedCaptureInput {
  action: CreateActionIntentInput;
  mandateId: string;
}
