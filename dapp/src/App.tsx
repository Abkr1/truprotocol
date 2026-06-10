import { useEffect, useState } from 'react';
import * as azns from './aztec';
import type { SearchResult } from './aztec';
import { priceUsdForMode, type ModeName } from './lib';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- inline icon set (no emoji) ---------------------------------------------
const I = {
  globe: <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c2.5 2.6 4 6.2 4 10s-1.5 7.4-4 10c-2.5-2.6-4-6.2-4-10s1.5-7.4 4-10ZM2.5 9h19M2.5 15h19" />,
  eye: <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
  shield: <path d="M12 2 4 5.5V11c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5.5L12 2Z" />,
  card: <path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm4 5h4M7 15h7" />,
  check: <path d="M4.5 12.5 10 18 19.5 6.5" />,
  send: <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7Z" />,
  warn: <path d="M12 3 2.5 20h19L12 3Zm0 7v4m0 3v.5" />,
  key: <path d="M15 9a6 6 0 1 0-5.7 6L11 13.3V11h2.3l1-1H15ZM9 15l-6 6m3-3 2 2" />,
  user: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0" />,
};
function Icon({ d, size = 18 }: { d: JSX.Element; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d}
    </svg>
  );
}

const fmtDate = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtRel = (secs: number) => {
  const days = Math.round((secs * 1000 - Date.now()) / 86400000);
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return 'today';
  if (days < 45) return `in ${days}d`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  const yrs = days / 365;
  return `in ${yrs.toFixed(yrs < 2 ? 1 : 0)}y`;
};

type Tab = 'search' | 'mine';

export default function App() {
  const [tab, setTab] = useState<Tab>('search');
  const [account, setAccount] = useState<string | null>(azns.accountAddress());
  const [mineCount, setMineCount] = useState(azns.myNames().length);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand" onClick={() => setTab('search')} role="button">
          <span className="logo">A</span><b>AZNS</b>
        </div>
        <nav className="tabs">
          <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search</button>
          <button className={tab === 'mine' ? 'on' : ''} onClick={() => { setMineCount(azns.myNames().length); setTab('mine'); }}>
            My names{mineCount ? <span className="pip">{mineCount}</span> : null}
          </button>
        </nav>
        {account
          ? <span className="badge" title={account}><span className="dot" />{short(account)}</span>
          : <span className="badge ghosty">{azns.isLocal ? 'Local' : 'Testnet'}</span>}
      </div>

      {tab === 'search'
        ? <SearchTab setAccount={setAccount} onRegistered={() => setMineCount(azns.myNames().length)} />
        : <Dashboard setAccount={setAccount} />}

      <footer className="foot">Running on {azns.isLocal ? 'a local network' : 'Aztec testnet'} · unaudited demo</footer>
    </div>
  );
}

function SearchTab({ setAccount, onRegistered }: { setAccount: (a: string | null) => void; onRegistered: () => void }) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');

  async function doSearch(raw: string) {
    const label = raw.trim();
    if (!label) return;
    setSearching(true); setError(''); setResult(null);
    try { setResult(await azns.search(label)); setAccount(azns.accountAddress()); }
    catch (e: any) { setError(e?.message ?? 'Something went wrong. Please try again.'); }
    finally { setSearching(false); }
  }

  return (
    <>
      <header className="hero">
        <h1>Your name on <span className="tld">.tru</span></h1>
        <p className="sub">Search for a name and claim it. Private by design, on Aztec.</p>
        <form className="search" onSubmit={(e) => { e.preventDefault(); doSearch(query); }}>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a name" spellCheck={false} autoComplete="off" />
          <span className="search-tld">.tru</span>
          <button type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
      </header>

      {error && <div className="notice err">{error}</div>}
      {result && <ResultCard result={result} onChanged={() => doSearch(query)} setAccount={setAccount} onRegistered={onRegistered} />}
      {!result && !error && (
        <div className="features">
          <Feature icon={I.globe} title="Public + multichain" text="ENS-style public names that can point to addresses on Aztec, Ethereum, and more." />
          <Feature icon={I.eye} title="Selective & stealth" text="Show a different address per viewer, or accept private payments to a hidden address." />
          <Feature icon={I.user} title="One human, one name" text="Sybil-resistant: registration is gated by a proof of personhood." />
        </div>
      )}
    </>
  );
}

function Dashboard({ setAccount }: { setAccount: (a: string | null) => void }) {
  const [names, setNames] = useState(azns.myNames());
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try { await azns.connect(); setAccount(azns.accountAddress()); setReady(true); }
      catch (e: any) { setErr(e?.message ?? 'Could not connect.'); }
    })();
  }, [setAccount]);

  if (names.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon"><Icon d={I.card} size={40} /></div>
        <h2>No names yet</h2>
        <p className="muted">Register a name from the Search tab and it'll show up here to manage.</p>
      </div>
    );
  }
  return (
    <div className="dash">
      <h2 className="dash-title">My names <span className="muted">({names.length})</span></h2>
      {err && <div className="notice err">{err}</div>}
      {!ready && <p className="muted small">connecting…</p>}
      {names.map((n) => (
        <OwnedCard key={n.label} label={n.label} name={`${n.label}.tru`} mode={n.mode}
          expiry={azns.estimatedExpiry(n)}
          onChanged={() => setNames(azns.myNames())}
          onForget={() => { azns.forgetName(n.label); setNames(azns.myNames()); }} />
      ))}
    </div>
  );
}

function Feature({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <div className="feature">
      <div className="fi"><Icon d={icon} size={22} /></div>
      <div><h3>{title}</h3><p>{text}</p></div>
    </div>
  );
}

const MODES: { key: ModeName; label: string; hint: string }[] = [
  { key: 'PUBLIC', label: 'Public', hint: 'Anyone can look it up' },
  { key: 'SELECTIVE', label: 'Selective', hint: 'Show a different result per viewer' },
  { key: 'STEALTH', label: 'Stealth', hint: 'Anyone pays; each payment hidden & unlinkable' },
];

function ResultCard({ result, onChanged, setAccount, onRegistered }: { result: SearchResult; onChanged: () => void; setAccount: (a: string | null) => void; onRegistered?: () => void }) {
  const [mode, setMode] = useState<ModeName>('PUBLIC');
  const [years, setYears] = useState(1);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [done, setDone] = useState<{ mode: ModeName } | null>(null);

  if (result.tooShort) {
    return <div className="result-card"><div className="rc-head"><span className="rc-name">{result.name}</span></div>
      <p className="muted">Names need at least 3 letters. Try a longer one.</p></div>;
  }

  async function claim() {
    setBusy(true); setStep('');
    try {
      await azns.register(result.label, mode, years, setStep);
      setAccount(azns.accountAddress());
      onRegistered?.();
      setDone({ mode });
    } catch (e: any) {
      setStep(`Couldn't complete: ${e?.message ?? 'please try again'}`);
    } finally { setBusy(false); }
  }

  if (done) {
    return <OwnedCard name={result.name} label={result.label} justClaimed mode={done.mode} onChanged={onChanged} />;
  }
  if (result.mine) {
    return <OwnedCard name={result.name} label={result.label} onChanged={onChanged} />;
  }

  if (!result.available) {
    return (
      <div className="result-card">
        <div className="rc-head">
          <span className="rc-name">{result.name}</span>
          <span className="tag taken">Taken</span>
        </div>
        <p className="muted">{result.status === 2 ? 'In its grace period — the current owner can still renew it.' : 'This name is already registered.'}</p>
        <PayBox label={result.label} name={result.name} />
        <AccessCheck label={result.label} name={result.name} />
      </div>
    );
  }

  const priceUsd = priceUsdForMode(mode);
  const total = priceUsd * years;
  return (
    <div className="result-card">
      <div className="rc-head">
        <span className="rc-name">{result.name}</span>
        <span className="tag avail">Available</span>
      </div>

      <div className="price-row">
        <div><span className="price">${priceUsd}</span><span className="per"> / year · {mode.toLowerCase()}</span></div>
        <div className="years">
          <span>Register for</span>
          <button type="button" className="step-btn" disabled={busy || years <= 1} onClick={() => setYears((y) => Math.max(1, y - 1))}>−</button>
          <b>{years} {years === 1 ? 'year' : 'years'}</b>
          <button type="button" className="step-btn" disabled={busy} onClick={() => setYears((y) => y + 1)}>+</button>
        </div>
      </div>

      <div className="modes">
        {MODES.map((m) => (
          <button type="button" key={m.key}
            className={`mode ${mode === m.key ? 'on' : ''}`}
            disabled={busy}
            onClick={() => setMode(m.key)}>
            <b>{m.label}<em className="mode-price">${priceUsdForMode(m.key)}/yr</em></b>
            <span>{m.hint}</span>
          </button>
        ))}
      </div>

      <button className="cta" disabled={busy} onClick={claim}>
        {busy ? (step || 'Working…') : `Register for $${total}`}
      </button>
      {!busy && <p className="muted small center">{azns.feeMode()?.funded
        ? 'Fees paid from the demo wallet’s fee juice — registration runs on testnet.'
        : 'No wallet needed — keys are created in your browser, fees are sponsored.'}</p>}
      {busy && <p className="muted small center">This can take a minute while your registration is proven privately.</p>}
    </div>
  );
}

const STATUS_LABEL = ['Available', 'Active', 'In grace'];
function OwnedCard({ name, label, justClaimed, mode, expiry, onChanged, onForget }: { name: string; label: string; justClaimed?: boolean; mode?: ModeName; expiry?: number | null; onChanged: () => void; onForget?: () => void }) {
  const [target, setTarget] = useState('');
  const [points, setPoints] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [info, setInfo] = useState<{ status: number; mine: boolean } | null>(null);
  const isPublic = mode === undefined || mode === 'PUBLIC';

  const [viewer, setViewer] = useState('');
  const [grantTarget, setGrantTarget] = useState('');
  const [keyPublished, setKeyPublished] = useState<boolean | null>(null);

  const refresh = () => azns.nameStatus(label).then(setInfo).catch(() => {});
  useEffect(() => { refresh(); }, [label]);
  useEffect(() => {
    if (mode === 'STEALTH') azns.hasStealthKey(label).then(setKeyPublished).catch(() => {});
  }, [label, mode]);

  const status = info?.status ?? null;
  const owned = justClaimed === true || info?.mine === true;
  const checkedNotMine = info !== null && !owned;

  async function save() {
    setBusy(true); setStep('');
    try { await azns.setPublicTarget(label, target.trim(), setStep); setPoints(target.trim()); setStep('Saved.'); refresh(); onChanged(); }
    catch (e: any) { setStep(`Couldn't save: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function lookup() {
    setBusy(true); setStep('');
    try { setPoints(await azns.resolvePublic(label)); }
    catch (e: any) { setStep(e?.message ?? 'lookup failed'); }
    finally { setBusy(false); }
  }
  async function renew() {
    setBusy(true); setStep('');
    try { await azns.renew(label, mode ?? 'PUBLIC', 1, setStep); setStep('Renewed +1 year.'); refresh(); onChanged(); }
    catch (e: any) { setStep(`Couldn't renew: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function publishStealth() {
    setBusy(true); setStep('');
    try { await azns.publishStealth(label, setStep); setKeyPublished(true); refresh(); }
    catch (e: any) { setStep(`Couldn't publish: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function doGrant() {
    setBusy(true); setStep('');
    try { await azns.grantAccess(label, viewer.trim(), grantTarget.trim(), setStep); setStep(`Access granted to ${short(viewer.trim())}.`); }
    catch (e: any) { setStep(`Couldn't grant: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function doRevoke() {
    setBusy(true); setStep('');
    try { await azns.revokeAccess(label, viewer.trim(), setStep); setStep(`Access revoked for ${short(viewer.trim())}.`); }
    catch (e: any) { setStep(`Couldn't revoke: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="result-card owned">
      <div className="rc-head">
        <span className="rc-name">{name}</span>
        <span className="rc-tags">
          {status !== null && <span className={`tag ${status === 1 ? 'avail' : 'taken'}`}>{STATUS_LABEL[status] ?? '—'}</span>}
          <span className="mode-chip">{(mode ?? 'PUBLIC').toLowerCase()}</span>
          {owned && <span className="tag mine"><Icon d={I.check} size={12} />{justClaimed ? 'Registered' : 'Yours'}</span>}
        </span>
      </div>

      {checkedNotMine ? (
        <div className="notice warn">
          {status === 0
            ? <>This name has <b>expired</b> and is available to register again from the Search tab.</>
            : <>This name is registered to a <b>different account</b> (not this browser's wallet).</>}
        </div>
      ) : (
        <>
          {owned && (
            (status === 2)
              ? <p className="grace"><Icon d={I.warn} size={14} /> Expired — in its grace period. Renew now to keep it.</p>
              : (expiry ? <p className="muted small">Expires <b>{fmtDate(expiry)}</b> · {fmtRel(expiry)}</p> : null)
          )}

          {isPublic ? (
            <>
              <p className="muted small">Points to <b>you</b> by default — repoint it below anytime.</p>
              <label className="field">Aztec address it points to
                <div className="row">
                  <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x… Aztec address (defaults to you)" disabled={busy} />
                  <button onClick={save} disabled={busy || !target.trim()}>Save</button>
                </div>
              </label>
              {points && <p className="result">Aztec <span className="mono">{points}</span></p>}
              <EthRecordRow label={label} />
              <div className="row">
                <button className="ghost" onClick={lookup} disabled={busy}>Look up Aztec</button>
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year (${priceUsdForMode(mode ?? 'PUBLIC')})</button>
              </div>
            </>
          ) : mode === 'STEALTH' ? (
            <>
              <p className="muted">A <b>stealth</b> name accepts payments from anyone while keeping every payment
                off the explorer. Publish your stealth key so wallets can derive fresh, unlinkable payment
                details for each sender.</p>
              <div className="keyline">
                <Icon d={I.key} size={15} />
                {keyPublished === null ? 'Checking key…'
                  : keyPublished ? <>Stealth key <b>published</b> — this name can receive payments.</>
                  : <>No stealth key yet — publish one to start receiving.</>}
              </div>
              <div className="row">
                {!keyPublished && <button onClick={publishStealth} disabled={busy}>Publish stealth key</button>}
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year (${priceUsdForMode(mode ?? 'PUBLIC')})</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">A <b>selective</b> name resolves only for viewers you choose. Grants are private
                notes — nothing about who can resolve this name ever appears on-chain.</p>
              <label className="field">Grant access
                <div className="row">
                  <input value={viewer} onChange={(e) => setViewer(e.target.value)} placeholder="0x… viewer's Aztec address" disabled={busy} />
                </div>
                <div className="row">
                  <input value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} placeholder="0x… address they should see" disabled={busy} />
                  <button onClick={doGrant} disabled={busy || !viewer.trim() || !grantTarget.trim()}>Grant</button>
                  <button className="ghost" onClick={doRevoke} disabled={busy || !viewer.trim()}>Revoke</button>
                </div>
              </label>
              <div className="row">
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year (${priceUsdForMode(mode ?? 'PUBLIC')})</button>
              </div>
            </>
          )}
        </>
      )}
      {step && <p className="muted small">{step}</p>}
      {onForget && <button className="forget" onClick={onForget} title="Remove from this list (does not affect on-chain ownership)">Remove from list</button>}
    </div>
  );
}

function EthRecordRow({ label }: { label: string }) {
  const [eth, setEth] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function save() {
    setBusy(true); setMsg('');
    try { await azns.setAddr(label, azns.COIN.ETHEREUM, eth.trim(), setMsg); setSaved(eth.trim()); setMsg('Saved.'); }
    catch (e: any) { setMsg(`Couldn't save: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function lookup() {
    setBusy(true); setMsg('');
    try { const a = await azns.getAddr(label, azns.COIN.ETHEREUM); setSaved(a || '(none set)'); }
    catch (e: any) { setMsg(e?.message ?? 'lookup failed'); }
    finally { setBusy(false); }
  }
  return (
    <label className="field">Ethereum address (multichain)
      <div className="row">
        <input value={eth} onChange={(e) => setEth(e.target.value)} placeholder="0x… Ethereum address" disabled={busy} />
        <button onClick={save} disabled={busy || !eth.trim()}>Save</button>
        <button className="ghost" onClick={lookup} disabled={busy}>Look up</button>
      </div>
      {saved && <p className="result">Ethereum <span className="mono">{saved}</span></p>}
      {msg && <p className="muted small">{msg}</p>}
    </label>
  );
}

function PayBox({ label, name }: { label: string; name: string }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [bal, setBal] = useState<bigint | null>(null);
  const refresh = async () => { try { setBal(await azns.tokenBalance()); } catch { /* not connected yet */ } };
  useEffect(() => { refresh(); }, []);

  async function faucet() {
    setBusy(true); setMsg('');
    try { await azns.getTestTokens(1000n, setMsg); await refresh(); setMsg('Got 1000 test TRU.'); }
    catch (e: any) { setMsg(`Faucet failed: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function pay() {
    setBusy(true); setMsg('');
    try { await azns.payPrivately(label, BigInt(amount || '0'), setMsg); await refresh(); setMsg(`Sent ${amount} TRU privately to ${name}.`); }
    catch (e: any) { setMsg(`Couldn't pay: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="paybox">
      <div className="pay-head">
        <b><Icon d={I.send} size={14} /> Send privately to {name}</b>
        <span className="bal">balance: {bal === null ? '—' : `${bal} TRU`}</span>
      </div>
      <div className="row">
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="amount" disabled={busy} />
        <button onClick={pay} disabled={busy || !amount}>Send privately</button>
        <button className="ghost" onClick={faucet} disabled={busy}>Get test tokens</button>
      </div>
      <p className="muted small">Always a private transfer — the amount &amp; recipient never appear on the explorer.{busy ? ` ${msg || 'Working…'}` : msg ? ` ${msg}` : ''}</p>
    </div>
  );
}

/** Viewer-side selective resolution: shows what this name resolves to FOR YOU. */
function AccessCheck({ label, name }: { label: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  async function check() {
    setBusy(true); setMsg(''); setOut(null);
    try {
      const addr = await azns.myAccess(label);
      if (addr) setOut(addr);
      else setMsg(`${name} doesn't resolve for your account — if it's a selective name, ask the owner for access.`);
    } catch (e: any) { setMsg(e?.message ?? 'Could not check access.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="accessbox">
      <div className="pay-head">
        <b><Icon d={I.eye} size={14} /> Selective access</b>
        <button className="ghost" onClick={check} disabled={busy}>{busy ? 'Checking…' : 'What does it resolve to for me?'}</button>
      </div>
      {out && <p className="result">For you <span className="mono">{out}</span></p>}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
