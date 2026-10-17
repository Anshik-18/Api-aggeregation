'use client';

import React, { useState } from 'react';
import {
  Wallet,
  Receipt,
  Lock,
  RefreshCw,
  Search,
  Filter,
  CheckCircle,
  ShieldAlert,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  Sparkles,
  Layers,
} from 'lucide-react';
import { AccountData, LedgerEntry, LedgerEntryType } from '../lib/types';
import { reconcileLeases } from '../lib/api';

interface BillingViewProps {
  account: AccountData | null;
  ledger: LedgerEntry[];
  apiKey: string;
  loading: boolean;
  onRefresh: () => void;
}

export function BillingView({
  account,
  ledger,
  apiKey,
  loading,
  onRefresh,
}: BillingViewProps) {
  const [filterType, setFilterType] = useState<LedgerEntryType | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{ reconciledCount: number } | null>(null);

  const handleReconcile = async () => {
    setReconciling(true);
    setReconcileResult(null);
    try {
      const res = await reconcileLeases(apiKey);
      setReconcileResult(res);
      onRefresh();
    } catch (err: any) {
      alert(`Reconciliation error: ${err.message}`);
    } finally {
      setReconciling(false);
    }
  };

  const filteredEntries = ledger.filter((entry) => {
    if (filterType !== 'ALL' && entry.type !== filterType) return false;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchDesc = entry.description.toLowerCase().includes(query);
      const matchReq = entry.requestId?.toLowerCase().includes(query);
      const matchIdemp = entry.idempotencyKey?.toLowerCase().includes(query);
      return matchDesc || matchReq || matchIdemp;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Top Banner & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-slate-900/60 p-4 sm:p-6 rounded-2xl border border-slate-800 backdrop-blur">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Usage & Financial Ledger</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Prepaid double-entry accounting with atomic holds, captures, and immutable audit events.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700/80 border border-slate-700 text-xs font-semibold text-slate-200 transition-all shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleReconcile}
            disabled={reconciling}
            className="flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-amber-300 border border-amber-500/30 transition-all"
            title="Scan and release expired in-flight request holds"
          >
            <Clock className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
            <span>Reconcile Leases</span>
          </button>
        </div>
      </div>

      {reconcileResult && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <CheckCircle className="w-4 h-4 text-amber-400" />
            <span>
              Reconciliation scan complete: <strong>{reconcileResult.reconciledCount}</strong> expired leases recovered.
            </span>
          </div>
          <button
            onClick={() => setReconcileResult(null)}
            className="text-amber-400 hover:text-amber-300 text-xs underline font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Account Balances Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Available Balance */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Available Balance</span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-emerald-400 font-mono">
              ${account ? parseFloat(account.availableBalance).toFixed(4) : '0.0000'}
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500 font-mono">
            {account ? account.availableMicros : '0'} micros
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-emerald-500/5 rounded-full blur-xl pointer-events-none" />
        </div>

        {/* Reserved Balance (Holds) */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Reserved (Pre-Flight Holds)</span>
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Lock className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-amber-400 font-mono">
              ${account ? parseFloat(account.reservedBalance).toFixed(4) : '0.0000'}
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500 font-mono">
            {account ? account.reservedMicros : '0'} micros locked
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-amber-500/5 rounded-full blur-xl pointer-events-none" />
        </div>

        {/* Settled Account Balance */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Settled Account Balance</span>
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Receipt className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-mono">
              ${account ? parseFloat(account.balance).toFixed(4) : '0.0000'}
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500 font-mono truncate">
            Org: {account ? account.orgId : 'N/A'}
          </div>
          <div className="absolute -bottom-6 -right-6 w-24 h-24 bg-indigo-500/5 rounded-full blur-xl pointer-events-none" />
        </div>
      </div>

      {/* Ledger Table Container */}
      <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm space-y-4">
        {/* Table Filters & Search */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          {/* Event Type Filter Pills */}
          <div className="flex flex-wrap gap-1.5">
            {(['ALL', 'CAPTURE', 'HOLD', 'RELEASE', 'DEPOSIT'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                  filterType === type
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-700/80'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative w-full md:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search request or key..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>
        </div>

        {/* Scrollable Table */}
        <div className="rounded-xl border border-slate-800 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-mono text-[10px] tracking-wider border-b border-slate-800">
              <tr>
                <th className="p-3">Type</th>
                <th className="p-3">Amount</th>
                <th className="p-3">Balance After</th>
                <th className="p-3">Reserved After</th>
                <th className="p-3">Description</th>
                <th className="p-3">Identifiers</th>
                <th className="p-3">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500 text-xs">
                    No ledger entries match the selected criteria.
                  </td>
                </tr>
              ) : (
                filteredEntries.map((entry) => {
                  const isCapture = entry.type === 'CAPTURE';
                  const isHold = entry.type === 'HOLD';
                  const isDeposit = entry.type === 'DEPOSIT';
                  const isRelease = entry.type === 'RELEASE';

                  return (
                    <tr key={entry.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                            isCapture
                              ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30'
                              : isHold
                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                              : isDeposit
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                              : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                          }`}
                        >
                          {entry.type}
                        </span>
                      </td>

                      <td className="p-3 font-semibold">
                        <span
                          className={
                            isCapture
                              ? 'text-indigo-400'
                              : isHold
                              ? 'text-amber-400'
                              : isDeposit
                              ? 'text-emerald-400'
                              : 'text-slate-400'
                          }
                        >
                          {isCapture ? `-$${parseFloat(entry.amount).toFixed(4)}` : `+$${parseFloat(entry.amount).toFixed(4)}`}
                        </span>
                      </td>

                      <td className="p-3 text-slate-300">${parseFloat(entry.balanceAfter).toFixed(4)}</td>
                      <td className="p-3 text-slate-400">${parseFloat(entry.reservedAfter).toFixed(4)}</td>

                      <td className="p-3 font-sans text-slate-200 max-w-xs truncate" title={entry.description}>
                        {entry.description}
                      </td>

                      <td className="p-3 text-[11px] text-slate-400 max-w-[180px] truncate">
                        {entry.requestId ? (
                          <div title={`Request: ${entry.requestId}`}>Req: {entry.requestId.slice(0, 16)}...</div>
                        ) : null}
                        {entry.idempotencyKey ? (
                          <div className="text-slate-500" title={`Key: ${entry.idempotencyKey}`}>
                            Idemp: {entry.idempotencyKey.slice(0, 16)}...
                          </div>
                        ) : null}
                        {!entry.requestId && !entry.idempotencyKey && <span className="text-slate-600">-</span>}
                      </td>

                      <td className="p-3 text-slate-500 text-[11px] whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleDateString()} {new Date(entry.createdAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
