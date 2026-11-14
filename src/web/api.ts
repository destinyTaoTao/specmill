export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message); }
}

export async function responseError(response: Response, fallback: string): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
      const id = 'requestId' in body && typeof body.requestId === 'string' ? `（请求编号：${body.requestId}）` : '';
      return new ApiError(`${body.message}${id}`, 'code' in body && typeof body.code === 'string' ? body.code : undefined, response.status);
    }
  } catch { /* Invalid or empty error bodies use the fallback. */ }
  return new ApiError(fallback, undefined, response.status);
}

export async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await responseError(response, fallback);
  return await response.json() as T;
}
