import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      'INVALID_RESPONSE',
      'The server returned an unreadable response. No successful result was recorded.',
    );
  }
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    throw new ApiError(
      error.success ? error.data.error.code : `HTTP_${response.status}`,
      error.success ? error.data.error.message : 'The request could not be completed.',
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      'UNSUPPORTED_RESPONSE',
      'The server response does not match this console version. No result has been inferred.',
    );
  return parsed.data;
}

export async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  try {
    return await parseResponse(
      await fetch(`/api${path}`, { cache: 'no-store', credentials: 'same-origin' }),
      schema,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'WORKER_UNREACHABLE',
      'The worker is unreachable. Your saved runs have not been changed.',
    );
  }
}

export async function login(token: string): Promise<string> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token }),
  });
  return (await parseResponse(response, z.object({ csrfToken: z.string() }))).csrfToken;
}

export class ApiSession {
  private readonly requestIds = new Map<string, string>();
  constructor(private readonly csrfToken: string) {}
  async mutate<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const encoded = JSON.stringify(body);
    const identity = `${path}\n${encoded}`;
    const requestId = this.requestIds.get(identity) ?? crypto.randomUUID();
    this.requestIds.set(identity, requestId);
    try {
      const result = await parseResponse(
        await fetch(`/api${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': this.csrfToken,
            'x-request-id': requestId,
          },
          body: encoded,
        }),
        schema,
      );
      this.requestIds.delete(identity);
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        // A definite precondition rejection can be retried as a new action after its blocker is fixed.
        // Lost or unparseable responses keep their ID because the mutation may already have happened.
        if (
          error.httpStatus &&
          error.httpStatus < 500 &&
          ![
            'OPERATION_OUTCOME_UNKNOWN',
            'OPERATION_IN_FLIGHT',
            'RUNTIME_APPROVAL_PENDING',
          ].includes(error.code)
        )
          this.requestIds.delete(identity);
        throw error;
      }
      throw new ApiError(
        'REQUEST_UNCERTAIN',
        'The response was lost. Retrying this action will reuse its request ID so the worker can reconcile it.',
      );
    }
  }
}

export function errorMessage(error: unknown): { code: string; message: string } {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'REQUEST_FAILED',
        message: 'This action could not be completed. No successful result was recorded.',
      };
}
