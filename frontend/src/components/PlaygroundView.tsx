'use client';

import React, { useState } from 'react';
import {
  Send,
  Sparkles,
  Zap,
  Clock,
  Database,
  Coins,
  Copy,
  Check,
  RotateCcw,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Hash,
} from 'lucide-react';
import { executeGatewayRequest } from '../lib/api';
import { ExecuteResult } from '../lib/types';

interface PlaygroundViewProps {
  apiKey: string;
  onExecutionSuccess?: () => void;
}

const TEMPLATES = [
  {
    name: 'Chat Completion',
    endpoint: '/v1/chat/completions',
    body: JSON.stringify(
      {
        prompt: 'Explain how deterministic provider routing and circuit breakers work.',
      },
      null,
      2
    ),
    cacheEligible: false,
  },
  {
    name: 'Cacheable Market Quote',
    endpoint: '/v1/data/market',
    body: JSON.stringify(
      {
        ticker: 'MSFT',
        interval: '1d',
      },
      null,
      2
    ),
    cacheEligible: true,
  },
  {
    name: 'Heavy Prompt (Idempotency Test)',
    endpoint: '/v1/chat/completions',
    body: JSON.stringify(
      {
        prompt: 'Process transaction payload with durable idempotency guarantee.',
      },
      null,
      2
    ),
    cacheEligible: false,
  },
];

export function PlaygroundView({ apiKey, onExecutionSuccess }: PlaygroundViewProps) {
  const [endpoint, setEndpoint] = useState('/v1/chat/completions');
  const [method, setMethod] = useState<'POST' | 'GET'>('POST');
  const [bodyText, setBodyText] = useState(TEMPLATES[0].body);
  const [cacheEligible, setCacheEligible] = useState(false);
  const [cacheBypass, setCacheBypass] = useState(false);
  const [preferredProvider, setPreferredProvider] = useState('auto');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [lastUsedKey, setLastUsedKey] = useState('');

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'body' | 'headers'>('body');

  const handleApplyTemplate = (tpl: typeof TEMPLATES[0]) => {
    setEndpoint(tpl.endpoint);
    setBodyText(tpl.body);
    setCacheEligible(tpl.cacheEligible);
  };

  const handleGenerateIdempotencyKey = () => {
    const key = `key_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setIdempotencyKey(key);
  };

  const handleReuseLastKey = () => {
    if (lastUsedKey) {
      setIdempotencyKey(lastUsedKey);
    }
  };

  const handleExecute = async () => {
    setLoading(true);
    setErrorMsg(null);

    let parsedBody: any = undefined;
    if (bodyText.trim()) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch (err: any) {
        setErrorMsg(`JSON Parse Error: ${err.message}`);
        setLoading(false);
        return;
      }
    }

    try {
      const res = await executeGatewayRequest(apiKey, {
        endpoint,
        method,
        body: parsedBody,
        cacheEligible,
        cacheBypass,
        preferredProviderId: preferredProvider,
        idempotencyKey: idempotencyKey.trim() || undefined,
      });

      setResult(res);
      if (idempotencyKey.trim()) {
        setLastUsedKey(idempotencyKey.trim());
      }
      if (res.ok && onExecutionSuccess) {
        onExecutionSuccess();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Execution failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyResult = () => {
    if (result?.body) {
      navigator.clipboard.writeText(JSON.stringify(result.body, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Request Builder */}
      <div className="lg:col-span-5 space-y-4">
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center space-x-2">
              <Sliders className="w-4 h-4 text-indigo-400" />
              <span>Request Builder</span>
            </h2>
            <span className="text-[11px] text-slate-500 font-mono">POST /v1/gateway/execute</span>
          </div>

          {/* Preset Template Pills */}
          <div>
            <label className="text-[11px] font-medium text-slate-400 block mb-1.5">Presets & Scenarios:</label>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.name}
                  onClick={() => handleApplyTemplate(tpl)}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700/80 text-slate-300 border border-slate-700/60 transition-colors"
                >
                  {tpl.name}
                </button>
              ))}
            </div>
          </div>

          {/* Endpoint & Method */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-slate-400 block">Target Upstream Endpoint</label>
            <div className="flex space-x-2">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as any)}
                className="px-3 py-2 text-xs rounded-xl bg-slate-950 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="/v1/chat/completions"
                className="flex-1 px-3 py-2 text-xs rounded-xl bg-slate-950 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Request Body JSON */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-slate-400">Request Body (JSON)</label>
              <button
                onClick={() => {
                  try {
                    setBodyText(JSON.stringify(JSON.parse(bodyText), null, 2));
                  } catch {}
                }}
                className="text-[10px] text-indigo-400 hover:underline"
              >
                Format JSON
              </button>
            </div>
            <textarea
              rows={6}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              className="w-full p-3 text-xs rounded-xl bg-slate-950 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500 resize-none leading-relaxed"
            />
          </div>

          {/* Gateway Routing & Caching Directives */}
          <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
            <span className="text-[11px] font-semibold text-slate-300 block uppercase tracking-wider">
              Gateway Directives
            </span>

            {/* Provider Preference */}
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Provider Selection</label>
              <select
                value={preferredProvider}
                onChange={(e) => setPreferredProvider(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-slate-900 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
              >
                <option value="auto">Auto (Lowest-cost eligible provider)</option>
                <option value="provider_alpha">Force Provider Alpha (Budget Tier - $0.001)</option>
                <option value="provider_beta">Force Provider Beta (Fast Tier - $0.003)</option>
              </select>
            </div>

            {/* Caching Toggles */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <label className="flex items-center space-x-2 p-2 rounded-lg bg-slate-900 border border-slate-800 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={cacheEligible}
                  onChange={(e) => setCacheEligible(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-700 text-indigo-600 focus:ring-0"
                />
                <span className="text-slate-300 font-medium">Cache Eligible</span>
              </label>

              <label className="flex items-center space-x-2 p-2 rounded-lg bg-slate-900 border border-slate-800 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={cacheBypass}
                  onChange={(e) => setCacheBypass(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-700 text-indigo-600 focus:ring-0"
                />
                <span className="text-slate-300 font-medium">Bypass Cache</span>
              </label>
            </div>

            {/* Idempotency Key */}
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-slate-400">Idempotency Key (Optional)</label>
                <div className="flex items-center space-x-2 text-[10px]">
                  <button
                    onClick={handleGenerateIdempotencyKey}
                    className="text-indigo-400 hover:text-indigo-300 font-medium"
                  >
                    Generate
                  </button>
                  {lastUsedKey && (
                    <button
                      onClick={handleReuseLastKey}
                      className="text-amber-400 hover:text-amber-300 font-medium"
                    >
                      Reuse Last
                    </button>
                  )}
                </div>
              </div>
              <input
                type="text"
                placeholder="Leave blank for unique request"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-slate-900 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Execute Button */}
          <button
            onClick={handleExecute}
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold text-xs shadow-lg shadow-indigo-500/25 flex items-center justify-center space-x-2 transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <RotateCcw className="w-4 h-4 animate-spin" />
                <span>Executing via Gateway...</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>Execute Gateway Request</span>
              </>
            )}
          </button>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Execution Results & Telemetry */}
      <div className="lg:col-span-7 space-y-4">
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm space-y-4 min-h-[500px] flex flex-col">
          {/* Header & Status */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center space-x-3">
              <span className="text-sm font-semibold text-white uppercase tracking-wider">
                Execution Telemetry
              </span>
              {result && (
                <div
                  className={`flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                    result.ok
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : result.statusCode === 402
                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                      : result.statusCode === 429
                      ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                  }`}
                >
                  {result.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5" />
                  )}
                  <span>HTTP {result.statusCode}</span>
                </div>
              )}
            </div>

            {result && (
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setActiveTab('body')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    activeTab === 'body'
                      ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Body
                </button>
                <button
                  onClick={() => setActiveTab('headers')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    activeTab === 'headers'
                      ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Headers
                </button>
                <button
                  onClick={handleCopyResult}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                  title="Copy response JSON"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
          </div>

          {!result ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-500 space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-slate-800/40 border border-slate-800 flex items-center justify-center text-slate-400">
                <Sparkles className="w-6 h-6" />
              </div>
              <p className="text-xs max-w-sm">
                Configure your request on the left and click <strong>Execute Gateway Request</strong> to inspect routing, customer charges, and response payloads.
              </p>
            </div>
          ) : (
            <div className="space-y-4 flex-1 flex flex-col">
              {/* Telemetry Metric Badges */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono">
                {/* Provider Card */}
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="flex items-center space-x-1.5 text-slate-400 text-[10px] uppercase">
                    <Database className="w-3 h-3 text-indigo-400" />
                    <span>Provider</span>
                  </div>
                  <span className="text-xs font-bold text-slate-200 mt-1 block truncate">
                    {result.meta.providerId || 'N/A'}
                  </span>
                </div>

                {/* Upstream Latency Card */}
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="flex items-center space-x-1.5 text-slate-400 text-[10px] uppercase">
                    <Clock className="w-3 h-3 text-indigo-400" />
                    <span>Upstream Latency</span>
                  </div>
                  <span className="text-xs font-bold text-slate-200 mt-1 block">
                    {result.meta.latencyMs !== undefined ? `${result.meta.latencyMs}ms` : `${result.durationMs}ms`}
                  </span>
                </div>

                {/* Cache Status Card */}
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="flex items-center space-x-1.5 text-slate-400 text-[10px] uppercase">
                    <Zap className="w-3 h-3 text-indigo-400" />
                    <span>Cache</span>
                  </div>
                  <div className="flex items-center space-x-1 mt-1">
                    <span
                      className={`text-xs font-bold px-1.5 py-0.2 rounded ${
                        result.meta.cacheHeader === 'HIT'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : result.meta.cacheHeader === 'BYPASS'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {result.meta.cacheHeader || (result.meta.cached ? 'HIT' : 'MISS')}
                    </span>
                    {result.meta.coalesced && (
                      <span className="text-[10px] text-purple-300 font-semibold">(Coalesced)</span>
                    )}
                  </div>
                </div>

                {/* Customer Charge Card */}
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="flex items-center space-x-1.5 text-slate-400 text-[10px] uppercase">
                    <Coins className="w-3 h-3 text-emerald-400" />
                    <span>Charge</span>
                  </div>
                  <span className="text-xs font-bold text-emerald-400 mt-1 block">
                    {result.meta.customerCharge ? `$${result.meta.customerCharge}` : '$0.0000'}
                  </span>
                </div>
              </div>

              {/* Response Viewer */}
              <div className="flex-1 rounded-xl bg-slate-950 border border-slate-800 p-3.5 font-mono text-xs overflow-auto max-h-[420px]">
                {activeTab === 'body' ? (
                  <pre className="text-slate-300 leading-relaxed">
                    {typeof result.body === 'object'
                      ? JSON.stringify(result.body, null, 2)
                      : String(result.body)}
                  </pre>
                ) : (
                  <div className="space-y-1.5">
                    {Object.entries(result.headers).map(([k, v]) => (
                      <div key={k} className="flex items-start text-[11px]">
                        <span className="text-indigo-400 w-44 shrink-0 font-medium">{k}:</span>
                        <span className="text-slate-300 break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
