'use client';

import React from 'react';
import {
  Wallet,
  Zap,
  Server,
  DollarSign,
  TrendingUp,
  RefreshCw,
  CheckCircle,
  AlertOctagon,
  Clock,
  ArrowUpRight,
  ShieldCheck,
  Layers,
} from 'lucide-react';
import { AccountData, ProviderStatus, LedgerEntry, HealthResponse } from '../lib/types';

interface OverviewViewProps {
  account: AccountData | null;
  providers: ProviderStatus[];
  ledger: LedgerEntry[];
  health: HealthResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onNavigateToPlayground: () => void;
}

export function OverviewView({
  account,
  providers,
  ledger,
  health,
  loading,
  onRefresh,
  onNavigateToPlayground,
}: OverviewViewProps) {
  // Compute real metrics from ledger and provider data
  const totalCustomerCharges = ledger
    .filter((entry) => entry.type === 'CAPTURE')
    .reduce((sum, entry) => sum + parseFloat(entry.amount), 0);

  const totalProviderCosts = providers.reduce((sum, p) => {
    const reqs = p.metrics?.totalRequests ?? 0;
    return sum + reqs * p.costPerUnit;
  }, 0);

  const totalRequestsAcrossProviders = providers.reduce(
    (sum, p) => sum + (p.metrics?.totalRequests ?? 0),
    0
  );

  const totalSuccesses = providers.reduce(
    (sum, p) => sum + (p.metrics?.totalSuccesses ?? 0),
    0
  );

  const overallSuccessRate =
    totalRequestsAcrossProviders > 0
      ? ((totalSuccesses / totalRequestsAcrossProviders) * 100).toFixed(1)
      : '100.0';

  const recentActivity = ledger.slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Top Welcome & Quick Refresh */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-slate-900/60 p-4 sm:p-6 rounded-2xl border border-slate-800 backdrop-blur">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">System Overview</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Real-time balance, cost-aware provider routing, and ledger activity.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700/80 border border-slate-700 text-xs font-semibold text-slate-200 transition-all shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
            <span>Refresh Data</span>
          </button>
          <button
            onClick={onNavigateToPlayground}
            className="flex items-center space-x-2 px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-xs font-semibold text-white shadow-lg shadow-indigo-500/20 transition-all"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Test in Playground</span>
          </button>
        </div>
      </div>

      {/* Primary KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Available Balance */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Available Prepaid Balance</span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono">
              ${account ? parseFloat(account.availableBalance).toFixed(4) : '0.0000'}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>Reserved: ${account ? parseFloat(account.reservedBalance).toFixed(4) : '0.0000'}</span>
            <span className="text-emerald-400/90 font-medium">Solvent</span>
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-emerald-500/5 rounded-full blur-xl pointer-events-none" />
        </div>

        {/* Card 2: Settled Customer Charges */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Total Customer Charges</span>
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono">
              ${totalCustomerCharges.toFixed(4)}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>Settled Ledger Events</span>
            <span className="text-indigo-400 font-medium">{ledger.filter((e) => e.type === 'CAPTURE').length} captures</span>
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-indigo-500/5 rounded-full blur-xl pointer-events-none" />
        </div>

        {/* Card 3: Upstream Provider Costs */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Total Upstream Cost</span>
            <div className="p-2 rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono">
              ${totalProviderCosts.toFixed(4)}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>Total Dispatches</span>
            <span className="text-violet-400 font-medium">{totalRequestsAcrossProviders} calls</span>
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-violet-500/5 rounded-full blur-xl pointer-events-none" />
        </div>

        {/* Card 4: Provider Health & Success Rate */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Upstream Success Rate</span>
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Server className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono">
              {overallSuccessRate}%
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>Active Providers</span>
            <span className="text-emerald-400 font-medium">{providers.length} Operational</span>
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-amber-500/5 rounded-full blur-xl pointer-events-none" />
        </div>
      </div>

      {/* Provider Health & Resilience Cards */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-indigo-400" />
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
              Provider Fleet & Circuit Breakers
            </h2>
          </div>
          <span className="text-xs text-slate-400">Cheapest eligible provider is auto-selected</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providers.map((p) => {
            const cb = p.circuitBreaker;
            const metrics = p.metrics;
            const isAlpha = p.id === 'provider_alpha';
            const isClosed = cb?.state === 'CLOSED';

            return (
              <div
                key={p.id}
                className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 hover:border-slate-700/80 transition-all shadow-sm space-y-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-semibold text-base text-white">{p.name}</span>
                      <span
                        className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                          isAlpha
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                        }`}
                      >
                        {isAlpha ? 'Budget Tier' : 'Fast Tier'}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400 font-mono mt-0.5 block">{p.id}</span>
                  </div>

                  {/* Circuit Breaker Status Pill */}
                  <div
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                      isClosed
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : cb?.state === 'HALF_OPEN'
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                    }`}
                  >
                    {isClosed ? (
                      <CheckCircle className="w-3.5 h-3.5" />
                    ) : (
                      <AlertOctagon className="w-3.5 h-3.5" />
                    )}
                    <span>{cb?.state || 'CLOSED'}</span>
                  </div>
                </div>

                {/* Key Attributes */}
                <div className="grid grid-cols-3 gap-2 py-2 px-3 rounded-xl bg-slate-950/60 border border-slate-800/80 text-center font-mono">
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase">Price/Call</span>
                    <span className="text-xs font-bold text-indigo-400">${p.costPerUnit.toFixed(4)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase">Latency</span>
                    <span className="text-xs font-bold text-slate-200">
                      {metrics?.ewmaLatencyMs ? `${metrics.ewmaLatencyMs.toFixed(0)}ms` : `${p.baselineLatencyMs}ms`}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase">Capacity</span>
                    <span className="text-xs font-bold text-slate-200">
                      {metrics?.activeConcurrency ?? 0}/{p.maxConcurrency}
                    </span>
                  </div>
                </div>

                {/* Detailed Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-slate-400 pt-1 border-t border-slate-800/60">
                  <div>
                    <span className="text-[10px] text-slate-500 block">Total Requests</span>
                    <span className="font-semibold text-slate-200 font-mono">{metrics?.totalRequests ?? 0}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Successes</span>
                    <span className="font-semibold text-emerald-400 font-mono">{metrics?.totalSuccesses ?? 0}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Rolling Errors</span>
                    <span className="font-semibold text-rose-400 font-mono">
                      {metrics?.rollingFailures ?? 0} ({(metrics?.rollingErrorRate ?? 0).toFixed(0)}%)
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Total Cost</span>
                    <span className="font-semibold text-slate-200 font-mono">
                      ${((metrics?.totalRequests ?? 0) * p.costPerUnit).toFixed(4)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Ledger Activity Stream */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Clock className="w-4 h-4 text-indigo-400" />
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
              Recent Settlement Activity
            </h2>
          </div>
          <span className="text-xs text-slate-400">From append-only financial ledger</span>
        </div>

        <div className="rounded-2xl bg-slate-900/60 border border-slate-800 overflow-hidden">
          {recentActivity.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-xs">
              No recent activity found. Run a request in the Playground to generate live events.
            </div>
          ) : (
            <div className="divide-y divide-slate-800/60">
              {recentActivity.map((entry) => {
                const isCapture = entry.type === 'CAPTURE';
                const isHold = entry.type === 'HOLD';
                const isDeposit = entry.type === 'DEPOSIT';

                return (
                  <div
                    key={entry.id}
                    className="p-3.5 sm:p-4 flex items-center justify-between hover:bg-slate-800/30 transition-colors text-xs"
                  >
                    <div className="flex items-center space-x-3 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                          isCapture
                            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                            : isHold
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : isDeposit
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                        }`}
                      >
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-slate-200">{entry.description}</span>
                          <span
                            className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${
                              isCapture
                                ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
                                : isHold
                                ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                                : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                            }`}
                          >
                            {entry.type}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 font-mono truncate mt-0.5">
                          {entry.requestId ? `Req: ${entry.requestId}` : 'System Deposit'} •{' '}
                          {new Date(entry.createdAt).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>

                    <div className="text-right shrink-0 ml-4 font-mono">
                      <span
                        className={`font-bold ${
                          isCapture
                            ? 'text-indigo-400'
                            : isHold
                            ? 'text-amber-400'
                            : isDeposit
                            ? 'text-emerald-400'
                            : 'text-slate-300'
                        }`}
                      >
                        {isCapture ? `-$${parseFloat(entry.amount).toFixed(4)}` : `+$${parseFloat(entry.amount).toFixed(4)}`}
                      </span>
                      <span className="text-[10px] text-slate-500 block">
                        Bal: ${parseFloat(entry.balanceAfter).toFixed(4)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
