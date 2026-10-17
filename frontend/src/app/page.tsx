'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/Header';
import { OverviewView } from '../components/OverviewView';
import { PlaygroundView } from '../components/PlaygroundView';
import { BillingView } from '../components/BillingView';
import { fetchHealth, fetchAccount, fetchProviders, fetchLedger } from '../lib/api';
import { HealthResponse, AccountData, ProviderStatus, LedgerEntry, DEMO_API_KEYS } from '../lib/types';
import { AlertCircle, RefreshCw } from 'lucide-react';

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'playground' | 'billing'>('overview');
  const [apiKey, setApiKey] = useState<string>(DEMO_API_KEYS[0].key);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [healthLoading, setHealthLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load API key from localStorage if available
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedKey = localStorage.getItem('gateway_api_key');
      if (savedKey) {
        setApiKey(savedKey);
      }
    }
  }, []);

  const handleApiKeyChange = (newKey: string) => {
    setApiKey(newKey);
    if (typeof window !== 'undefined') {
      localStorage.setItem('gateway_api_key', newKey);
    }
  };

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const data = await fetchHealth();
      setHealth(data);
    } catch {
      // Degraded health
      setHealth({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        components: {
          database: { isHealthy: false, error: 'Connection failure' },
          redis: { isHealthy: false, error: 'Connection failure' },
        },
      });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const loadDashboardData = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      const [acc, provs, ledg] = await Promise.all([
        fetchAccount(apiKey).catch((err) => {
          // Unfunded or invalid accounts might return 402/404, capture gracefully
          return null;
        }),
        fetchProviders(apiKey).catch(() => []),
        fetchLedger(apiKey).catch(() => []),
      ]);

      setAccount(acc);
      setProviders(provs);
      setLedger(ledg);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load gateway data');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 15000);
    return () => clearInterval(interval);
  }, [loadHealth]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Header */}
      <Header
        currentTab={activeTab}
        onTabChange={setActiveTab}
        apiKey={apiKey}
        onApiKeyChange={handleApiKeyChange}
        health={health}
        healthLoading={healthLoading}
        onRefreshHealth={loadHealth}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Error Notification Banner */}
        {errorMsg && (
          <div className="mb-6 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
            <button
              onClick={loadDashboardData}
              className="flex items-center space-x-1 underline hover:text-white"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Tab Views */}
        {activeTab === 'overview' && (
          <OverviewView
            account={account}
            providers={providers}
            ledger={ledger}
            health={health}
            loading={loading}
            onRefresh={loadDashboardData}
            onNavigateToPlayground={() => setActiveTab('playground')}
          />
        )}

        {activeTab === 'playground' && (
          <PlaygroundView
            apiKey={apiKey}
            onExecutionSuccess={loadDashboardData}
          />
        )}

        {activeTab === 'billing' && (
          <BillingView
            account={account}
            ledger={ledger}
            apiKey={apiKey}
            loading={loading}
            onRefresh={loadDashboardData}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-500 font-mono">
        API Aggregation Gateway • Fastify Backend (Port 3000) • Next.js Frontend (Port 3001)
      </footer>
    </div>
  );
}
