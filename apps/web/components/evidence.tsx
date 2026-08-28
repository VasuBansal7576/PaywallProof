'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, errorMessage } from '../lib/api';
import type { RunDetail, Scenario } from '../lib/contracts';
import { linkedArtifacts, observationSchema, scenarioEvidence, type Artifact, type EvidenceFacts, type Observation } from '../lib/evidence-presentation';
import { Badge, EmptyState, ErrorNotice, JsonDetails, formatDate, shortId } from './shared';

export function ScenarioEvidence({ detail, scenario }: { detail: RunDetail; scenario: Scenario }) {
  const sources = [
    { source: 'billing_provider', label: detail.run.mode === 'local_replay' ? 'Recorded replay billing' : 'Recorded Polar state' },
    { source: 'application', label: 'Stored application state' },
    { source: 'api_probe', label: 'Ordinary API request' },
    { source: 'browser', label: 'Ordinary browser action' },
  ] satisfies Array<{ source: Observation['source']; label: string }>;
  return <>
    <div className="source-evidence-grid">{sources.map(source => <SourceEvidence key={source.source} title={source.label} evidence={scenarioEvidence(detail, scenario, source.source)} />)}</div>
    <ArtifactGallery detail={detail} observationIds={scenario.observationIds} scenarioId={scenario.id} />
  </>;
}

function SourceEvidence({ title, evidence }: { title: string; evidence: EvidenceFacts }) {
  return <section className="source-evidence"><div className="source-heading"><h4>{title}</h4><Badge tone={evidence.kind === 'recorded' ? 'neutral' : 'amber'}>{evidence.kind === 'recorded' ? 'Recorded' : 'Unavailable'}</Badge></div>{evidence.kind === 'recorded' ? <><dl>{evidence.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><p className="evidence-timestamp"><time dateTime={new Date(evidence.observation.observedAt).toISOString()}>{formatDate(evidence.observation.observedAt)}</time><span>Billing time: {evidence.observation.billingTime === null ? 'Not recorded' : `${evidence.observation.billingTime} Unix seconds`}</span></p><JsonDetails title={`Observation ${shortId(evidence.observation.id)}`} value={evidence.observation} /></> : <p>{evidence.reason}</p>}</section>;
}

export function ArtifactGallery({ detail, observationIds, scenarioId }: { detail: RunDetail; observationIds: string[]; scenarioId?: string }) {
  const { artifacts, invalidCount } = linkedArtifacts(detail, observationIds, scenarioId);
  return <section className="artifact-gallery"><div className="artifact-heading"><h4>Recorded browser screenshots</h4><span>{artifacts.length} linked</span></div>{invalidCount > 0 && <p className="artifact-unavailable" role="status">{invalidCount} malformed or incorrectly scoped artifact receipts are unavailable. They have not been used as screenshots.</p>}{artifacts.length ? artifacts.map(artifact => <ArtifactScreenshot key={`${artifact.id}-${artifact.sha256}`} runId={detail.run.id} artifact={artifact} />) : <p className="artifact-unavailable">No screenshot receipt is linked to these browser observations. No image has been inferred from the scenario result.</p>}</section>;
}

type ImageState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; url: string; size: number } | { kind: 'error'; error: ReturnType<typeof errorMessage> };
export function ArtifactScreenshot({ runId, artifact }: { runId: string; artifact: Artifact }) {
  const [state, setState] = useState<ImageState>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => () => { controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  async function load() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState({ kind: 'loading' });
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (!response.ok) {
        const payload: unknown = await response.json();
        const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(payload);
        throw new ApiError(parsed.success ? parsed.data.error.code : 'ARTIFACT_UNAVAILABLE', parsed.success ? parsed.data.error.message : 'The screenshot could not be retrieved.', response.status);
      }
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'image/png') throw new ApiError('ARTIFACT_CORRUPT', 'The server did not return a PNG screenshot.');
      const declaredSize = Number(response.headers.get('content-length'));
      if (declaredSize > 50 * 1024 * 1024) throw new ApiError('ARTIFACT_TOO_LARGE', 'The screenshot exceeds the preview size limit.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 8 || bytes.byteLength > 50 * 1024 * 1024) throw new ApiError('ARTIFACT_CORRUPT', 'The returned screenshot has an invalid size.');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== artifact.sha256) throw new ApiError('ARTIFACT_CORRUPT', 'The downloaded screenshot does not match its stored receipt.');
      if (request.signal.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      objectUrl.current = url;
      setState({ kind: 'ready', url, size: bytes.byteLength });
    } catch (error) {
      if (!request.signal.aborted) setState({ kind: 'error', error: error instanceof ApiError ? errorMessage(error) : { code: 'ARTIFACT_UNAVAILABLE', message: 'The screenshot request failed. No image has been substituted.' } });
    }
  }
  return <div className="artifact-card"><div className="artifact-heading"><div><strong>{shortId(artifact.id)}</strong><p>Collected {new Date(artifact.collectedAt).toLocaleString()} · Observation {shortId(artifact.observationId)}</p></div>{state.kind === 'ready' ? <a className="button secondary small" href={state.url} download={artifact.id}>Download PNG ↓</a> : <button className="button secondary small" onClick={() => void load()} disabled={state.kind === 'loading'}>{state.kind === 'loading' ? 'Verifying screenshot…' : state.kind === 'error' ? 'Retry screenshot' : 'View screenshot'}</button>}</div>{state.kind === 'error' && <ErrorNotice error={state.error} />}{state.kind === 'ready' && <figure><img src={state.url} alt={`Recorded browser action for observation ${artifact.observationId}`} onError={() => { setState({ kind: 'error', error: { code: 'ARTIFACT_CORRUPT', message: 'The downloaded bytes could not be displayed as a PNG screenshot.' } }); if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; } }} /><figcaption>{state.size.toLocaleString()} bytes · SHA-256 matches the stored screenshot receipt. Image integrity does not establish an access verdict.</figcaption></figure>}<JsonDetails title="Screenshot receipt" value={artifact} /></div>;
}

export function EvidenceLedger({ detail }: { detail: RunDetail }) {
  const ids = detail.observations.flatMap(value => {
    const parsed = observationSchema.safeParse(value);
    return parsed.success ? [parsed.data.id] : [];
  });
  return <section className="panel"><div className="panel-heading"><div><h2>Evidence ledger</h2><p>Persisted, redacted observations. A receipt is not a substitute for its recorded source.</p></div><a className="button secondary small" href={`/api/runs/${encodeURIComponent(detail.run.id)}/report?format=json`} download>Download JSON ↓</a></div><div className="panel-inset"><ArtifactGallery detail={detail} observationIds={ids} />{detail.observations.length ? detail.observations.map((observation, index) => <JsonDetails key={index} title={observationTitle(observation, index)} value={observation} />) : <EmptyState title="No observations collected">No provider snapshot, application state, API response, or browser result has been recorded for this run.</EmptyState>}</div></section>;
}

export function observationTitle(value: unknown, index: number) {
  const metadata = observationSchema.safeParse(value);
  return metadata.success ? `${metadata.data.scenarioId} · ${metadata.data.source} · ${shortId(metadata.data.id)}` : `Observation ${index + 1} · malformed metadata`;
}
