export const privacyRequestStatuses = [
  "created",
  "identity_verification_pending",
  "identity_verified",
  "planning",
  "awaiting_approval",
  "execution_authorized",
  "executing",
  "needs_review",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
] as const;

export type PrivacyRequestStatus = (typeof privacyRequestStatuses)[number];
