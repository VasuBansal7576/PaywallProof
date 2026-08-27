import Link from 'next/link';

export default function Home() {
  return <main className="welcome"><div className="brand"><span className="brand-mark">L</span> Ledger &amp; co.</div><p className="eyebrow">PaywallProof reference application</p><h1>Your work.<br />A little clearer.</h1><p className="intro">A small workspace with one Pro feature, a protected data export. This application is separate from the checker that tests it.</p><Link className="button" href="/dashboard">Open workspace <span aria-hidden="true">↗</span></Link><p className="fine-print">Test environment · No checkout · No real charges</p></main>;
}
