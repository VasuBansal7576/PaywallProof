import { handleReferenceRequest } from '../../../server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = handleReferenceRequest;
export const POST = handleReferenceRequest;
export const DELETE = handleReferenceRequest;
