import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Builder Platform — Skill Playground',
  description: 'Standalone Skill Platform Playground (Phase 7)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <nav className="topbar">
          <h1>
            <Link href="/skills">AI Builder Platform</Link>
          </h1>
          <span className="muted">Skill Playground</span>
        </nav>
        {children}
      </body>
    </html>
  );
}
