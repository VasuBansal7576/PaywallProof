import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'Ledger & co. | Reference workspace',
  description: 'The PaywallProof reference target. An ordinary workspace with a server protected Pro export.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
