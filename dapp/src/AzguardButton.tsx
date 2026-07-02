// =============================================================================
//  AzguardButton - opt-in "Connect Azguard" control for the topbar.
// =============================================================================
//  Self-contained + lazy: it imports the Azguard adapter only when used, so the
//  default in-browser wallet path is completely unaffected. Honest about state:
//  it distinguishes "extension not installed" from "installed but this network
//  isn't supported by the wallet build yet" (the mainnet-readiness gate while
//  Azguard catches up to the AZUP-2/v5 protocol line this deployment runs).
// =============================================================================
import { useEffect, useState } from 'react';

type Status =
  | { k: 'checking' }
  | { k: 'absent' }                 // extension not detected
  | { k: 'idle' }                   // present, not connected
  | { k: 'connecting' }
  | { k: 'connected'; address: string; chainSupported: boolean }
  | { k: 'error'; message: string };

const short = (a: string) => a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export default function AzguardButton({ onChanged }: { onChanged?: () => void } = {}) {
  const [s, setS] = useState<Status>({ k: 'checking' });

  useEffect(() => {
    let live = true;
    (async () => {
      const az = await import('./azguard');
      const present = await az.azguardAvailable();
      if (!live) return;
      if (!present) { setS({ k: 'absent' }); return; }
      if (az.azguardWantsReconnect()) {
        setS({ k: 'connecting' });
        try {
          const r = await az.azguardConnect();
          if (live) { setS({ k: 'connected', address: r.address, chainSupported: r.chainSupported }); onChanged?.(); }
        } catch { if (live) setS({ k: 'idle' }); }
      } else {
        setS({ k: 'idle' });
      }
    })();
    return () => { live = false; };
  }, []);

  const connect = async () => {
    setS({ k: 'connecting' });
    try {
      const az = await import('./azguard');
      if (!(await az.azguardAvailable())) { setS({ k: 'absent' }); return; }
      const r = await az.azguardConnect();
      setS({ k: 'connected', address: r.address, chainSupported: r.chainSupported });
      onChanged?.();
    } catch (e: any) {
      setS({ k: 'error', message: String(e?.message ?? e).slice(0, 120) });
    }
  };
  const disconnect = async () => {
    try { const az = await import('./azguard'); await az.azguardDisconnect(); } catch { /* ignore */ }
    setS({ k: 'idle' });
    onChanged?.();
  };

  if (s.k === 'checking') return null; // resolving availability; keep the bar clean
  if (s.k === 'absent') {
    // Clickable retry: the extension's content script can inject late (after our
    // initial ~1.5s check), and a user may install it without reloading.
    return (
      <span className="badge ghosty" role="button" onClick={connect}
        title="Azguard not detected. Install the extension (or click to re-check), then connect.">
        Azguard: not detected
      </span>
    );
  }
  if (s.k === 'connected') {
    return (
      <span
        className="badge"
        role="button"
        onClick={disconnect}
        title={s.chainSupported
          ? `Azguard connected (${s.address}) — click to disconnect`
          : `Azguard connected, but this wallet build doesn't support this network yet — click to disconnect`}
      >
        <span className="dot" style={s.chainSupported ? undefined : { background: '#e0a800' }} />
        Azguard {short(s.address)}{s.chainSupported ? '' : ' · wrong network'}
      </span>
    );
  }
  if (s.k === 'error') {
    return <span className="badge ghosty" role="button" onClick={connect} title={s.message}>Azguard: retry</span>;
  }
  return (
    <button className="theme-btn" onClick={connect} disabled={s.k === 'connecting'} title="Connect the Azguard external wallet">
      {s.k === 'connecting' ? 'Connecting…' : 'Connect Azguard'}
    </button>
  );
}
