/** An HTTP refusal produced by an approver policy check. */
export interface Rejection {
  status: 400 | 401 | 409 | 503;
  body: { error: string } & Record<string, unknown>;
}

export const reject = (
  error: string,
  status: Rejection["status"] = 409,
  extra?: Record<string, unknown>,
): Rejection => ({ status, body: { error, ...extra } });
