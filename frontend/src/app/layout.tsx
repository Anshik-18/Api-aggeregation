import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'API Aggregation & Resilience Platform',
  description: 'Enterprise API Gateway Dashboard: Routing, Circuit Breakers, Financial Ledger, and Caching',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased selection:bg-indigo-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
