import { type TargetTransport } from '#integrations/network';

export type AdapterDoctorResponse = Readonly<{
  status: number;
  body: unknown;
  headers: Readonly<{ cacheControl: string | null; contentType: string | null }>;
}>;

export interface AdapterDoctorTarget {
  describe(input: {
    credential: 'configured' | 'omitted';
    signal?: AbortSignal;
  }): Promise<AdapterDoctorResponse>;
  featureWithAdapterCredential(input: {
    path: string;
    signal?: AbortSignal;
  }): Promise<AdapterDoctorResponse>;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export class HttpAdapterDoctorTarget implements AdapterDoctorTarget {
  readonly #transport: TargetTransport;
  readonly #adapterToken: string;

  constructor(input: { transport: TargetTransport; adapterToken: string }) {
    this.#transport = input.transport;
    this.#adapterToken = input.adapterToken;
  }

  async #get(input: {
    path: string;
    credential: 'configured' | 'omitted';
    signal?: AbortSignal;
  }): Promise<AdapterDoctorResponse> {
    const deadline = AbortSignal.timeout(5_000);
    const response = await this.#transport.request(input.path, {
      method: 'GET',
      ...(input.credential === 'configured'
        ? { headers: { Authorization: `Bearer ${this.#adapterToken}` } }
        : {}),
      signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
    });
    return {
      status: response.status,
      body: response.body,
      headers: {
        cacheControl: firstHeader(response.headers['cache-control']),
        contentType: firstHeader(response.headers['content-type']),
      },
    };
  }

  describe(input: {
    credential: 'configured' | 'omitted';
    signal?: AbortSignal;
  }): Promise<AdapterDoctorResponse> {
    return this.#get({ path: '/staging/describe', ...input });
  }

  featureWithAdapterCredential(input: {
    path: string;
    signal?: AbortSignal;
  }): Promise<AdapterDoctorResponse> {
    return this.#get({ ...input, credential: 'configured' });
  }
}
