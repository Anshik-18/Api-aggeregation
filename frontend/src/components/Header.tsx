'use client';

import React, { useState } from 'react';
import { Activity, Shield, Key, RefreshCw, CheckCircle2, AlertTriangle, Layers, Terminal, Receipt } from 'lucide-react';
import { HealthResponse, DEMO_API_KEYS } from '../lib/types';

interface HeaderProps {
  currentTab: 'overview' | 'playground' | 'billing';
  onTabChange: (tab: 'overview' | 'playground' | 'billing') => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  health: HealthResponse | null;
  healthLoading: boolean;
  onRefreshHealth: () => void;
}

export function Header({
  currentTab,
  onTabChange,
  apiKey,
  onApiKeyChange,
  health,
  healthLoading,
  onRefreshHealth,
}: HeaderProps) {
  const [showKeyPicker, setShowKeyPicker] = useState(false);
  const [customKeyInput, setCustomKeyInput] = useState('');

  const activePreset = DEMO_API_KEYS.find((k) => k.key === apiKey);

  const handleSelectPreset = (key: string) => {
    onApiKeyChange(key);
    setShowKeyPicker(false);
  };

  const handleApplyCustomKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (customKeyInput.trim()) {
      onApiKeyChange(customKeyInput.trim());
      setCustomKeyInput('');
      setShowKeyPicker(false);
    }
  };

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand & Title */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 ring-1 ring-white/20">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-lg text-white tracking-tight">API Gateway</span>
                <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  Resilience & Billing
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Cost-aware routing • Durable idempotency • Redis caching
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center space-x-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => onTabChange('overview')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentTab === 'overview'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Overview</span>
            </button>
            <button
              onClick={() => onTabChange('playground')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentTab === 'playground'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Playground</span>
            </button>
            <button
              onClick={() => onTabChange('billing')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                currentTab === 'billing'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <Receipt className="w-3.5 h-3.5" />
              <span>Usage & Ledger</span>
            </button>
          </nav>

          {/* Right Side: Health & Key Picker */}
          <div className="flex items-center space-x-3">
            {/* System Health */}
            <div className="hidden md:flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-slate-800/60 border border-slate-700/60 text-xs">
              <button
                onClick={onRefreshHealth}
                title="Refresh health"
                className="text-slate-400 hover:text-white transition-colors"
                disabled={healthLoading}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${healthLoading ? 'animate-spin' : ''}`} />
              </button>
              {health?.status === 'healthy' ? (
                <div className="flex items-center space-x-1.5 text-emerald-400 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Healthy</span>
                  <span className="text-[10px] text-slate-400">
                    (DB: {health.components.database.latencyMs ?? 0}ms • Redis: {health.components.redis.latencyMs ?? 0}ms)
                  </span>
                </div>
              ) : health?.status === 'degraded' ? (
                <div className="flex items-center space-x-1.5 text-amber-400 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Degraded</span>
                </div>
              ) : (
                <span className="text-slate-400">Connecting...</span>
              )}
            </div>

            {/* API Key Selector Button */}
            <div className="relative">
              <button
                onClick={() => setShowKeyPicker(!showKeyPicker)}
                className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700/80 border border-slate-700 text-xs font-medium text-slate-200 transition-all shadow-sm"
              >
                <Key className="w-3.5 h-3.5 text-indigo-400" />
                <span className="max-w-[120px] truncate sm:max-w-[160px]">
                  {activePreset ? activePreset.badge : `${apiKey.slice(0, 10)}...`}
                </span>
                <span className="text-[10px] text-slate-400 font-mono">▼</span>
              </button>

              {/* Key Picker Dropdown Modal */}
              {showKeyPicker && (
                <div className="absolute right-0 mt-2 w-80 rounded-xl bg-slate-900 border border-slate-800 shadow-2xl p-3 z-50 animate-in fade-in zoom-in-95 duration-100">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800 mb-2">
                    <span className="text-xs font-semibold text-slate-300">Select API Key Preset</span>
                    <span className="text-[10px] text-slate-500 font-mono">Stored in session</span>
                  </div>

                  <div className="space-y-1.5">
                    {DEMO_API_KEYS.map((preset) => (
                      <button
                        key={preset.key}
                        onClick={() => handleSelectPreset(preset.key)}
                        className={`w-full text-left p-2 rounded-lg text-xs transition-all border ${
                          apiKey === preset.key
                            ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-200'
                            : 'bg-slate-950/40 border-slate-800 hover:border-slate-700 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="font-semibold">{preset.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                            {preset.badge}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400">{preset.description}</p>
                      </button>
                    ))}
                  </div>

                  {/* Custom Key Input */}
                  <form onSubmit={handleApplyCustomKey} className="mt-3 pt-2 border-t border-slate-800">
                    <label className="text-[11px] text-slate-400 block mb-1">Or enter custom key:</label>
                    <div className="flex space-x-1.5">
                      <input
                        type="text"
                        placeholder="ak_live_..."
                        value={customKeyInput}
                        onChange={(e) => setCustomKeyInput(e.target.value)}
                        className="flex-1 px-2.5 py-1 text-xs rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                      />
                      <button
                        type="submit"
                        className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition-colors"
                      >
                        Set
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
