export type ErrorReason =
  | "offline"
  | "asleep_timeout"
  | "auth_error"
  | "command_rejected"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "access_denied"
  | "tesla_error"
  | "tesla_auth_error"
  | "tesla_pairing_required"
  | "tesla_rate_limited"
  | "tesla_upstream_error"
  | "vcp_required"
  | "mobile_access_disabled"
  | "vehicle_asleep_or_offline"
  | "vehicle_not_found"
  | "vehicle_in_service"
  | "auth_expired_or_invalid"
  | "generic_tesla_upstream_error"
  | "server_misconfigured"
  | "auth_upstream_error"
  | "lock_failed"
  | "unknown";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public reason: ErrorReason,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}
