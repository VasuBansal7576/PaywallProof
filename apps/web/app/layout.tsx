import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = { title: 'PaywallProof | Know who gets access', description: 'Evidence for your subscription access rules. Verify your protected feature against an approved billing policy.' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
