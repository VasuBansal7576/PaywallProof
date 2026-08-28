'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setState('copied'); }
    catch { setState('failed'); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 3500);
  }
  return <span className="copy-control"><button type="button" className="icon-button" aria-label={label} title={label} onClick={() => void copy()}>{state === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}</button><span className={state === 'failed' ? 'copy-feedback error-text' : 'sr-only'} role="status">{state === 'copied' ? `${label}: copied` : state === 'failed' ? 'Clipboard unavailable. Select and copy the text.' : ''}</span></span>;
}
