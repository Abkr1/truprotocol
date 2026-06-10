import { useEffect, useState } from 'react';
import * as azns from './aztec';
import type { SearchResult } from './aztec';
import type { ModeName } from './lib';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
          <Feature icon="🌍" title="Public + multichain" text="ENS-style public names that can point to addresses on Aztec, Ethereum, and more." />
          <Feature icon="🎭" title="Selective & stealth" text="Show a different address per viewer, or accept private payments to a hidden address." />
          <Feature icon="🧍" title="One human, one name" text="Sybil-resistant: registration is gated by a proof of personhood." />
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
        <div className="empty-emoji">🪪</div>
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

function Feature({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="feature">
      <div className="fi">{icon}</div>
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
      </div>
    );
  }

  const total = (result.priceUsd ?? 0) * years;
  return (
    <div className="result-card">
      <div className="rc-head">
        <span className="rc-name">{result.name}</span>
        <span className="tag avail">Available</span>
      </div>

      <div className="price-row">
        <div><span className="price">${result.priceUsd}</span><span className="per"> / year</span></div>
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
            <b>{m.label}</b><span>{m.hint}</span>
          </button>
        ))}
      </div>

      <button className="cta" disabled={busy} onClick={claim}>
        {busy ? (step || 'Working…') : `Register for $${total}`}
      </button>
      {!busy && <p className="muted small center">No wallet needed — your keys are created in your browser, fees are sponsored.</p>}
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

  const refresh = () => azns.nameStatus(label).then(setInfo).catch(() => {});
  useEffect(() => { refresh(); }, [label]);

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
    try { await azns.renew(label, 1, setStep); setStep('Renewed +1 year.'); refresh(); onChanged(); }
    catch (e: any) { setStep(`Couldn't renew: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function publishStealth() {
    setBusy(true); setStep('');
    try { await azns.publishStealth(label, setStep); refresh(); }
    catch (e: any) { setStep(`Couldn't publish: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="result-card owned">
      <div className="rc-head">
        <span className="rc-name">{name}</span>
        <span className="rc-tags">
          {status !== null && <span className={`tag ${status === 1 ? 'avail' : 'taken'}`}>{STATUS_LABEL[status] ?? '—'}</span>}
          <span className="mode-chip">{(mode ?? 'PUBLIC').toLowerCase()}</span>
          {owned && <span className="tag mine">{justClaimed ? '🎉 Yours' : 'Yours'}</span>}
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
              ? <p className="grace">⚠ Expired — in its grace period. Renew now to keep it.</p>
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
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year</button>
              </div>
            </>
          ) : (
            <>
              {mode === 'STEALTH'
                ? <p className="muted">This is a <b>stealth</b> name — publish a stealth key and anyone can pay it, with every payment landing on a fresh, unlinkable one-time address. (Per-payment derivation + scanning/sweep is experimental; see docs/stealth-mode.md.)</p>
                : <p className="muted">This is a <b>selective</b> name — its resolution is private to the specific viewers you grant.</p>}
              <div className="row">
                {mode === 'STEALTH' && <button onClick={publishStealth} disabled={busy}>Publish stealth key</button>}
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year</button>
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
        <b>💸 Send privately to {name}</b>
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
