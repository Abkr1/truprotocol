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
  sun: <path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m1.4-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" />,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
};
function Icon({ d, size = 18 }: { d: JSX.Element; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d}
    </svg>
  );
}

/** Click-to-copy wrapper for addresses - no manual selecting hex strings. */
function Copyable({ text, className, title, children }: { text: string; className?: string; title?: string; children?: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <span className={`${className ?? 'mono'} copyable`} title={title ?? 'Click to copy'}
      onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* clipboard blocked */ }
      }}>
      {done ? 'Copied' : (children ?? text)}
    </span>
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
  const [connecting, setConnecting] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [toast, setToast] = useState('');
  const [lastPay, setLastPay] = useState<{ delta: string; at: number } | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (globalThis.localStorage?.getItem('azns.theme') as 'light' | 'dark' | null)
    ?? (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    globalThis.localStorage?.setItem('azns.theme', theme);
  }, [theme]);

  // Auto-connect on load, then watch for incoming private payments in the
  // background - owners never have to "check" anything manually.
  useEffect(() => {
    setConnecting(true);
    azns.connect()
      .then(() => {
        setAccount(azns.accountAddress());
        azns.startPaymentWatcher(
          (delta) => { setToast(`Payment received: +${delta} TRU`); setLastPay({ delta: String(delta), at: Date.now() }); },
          (bal) => setBalance(bal),
        );
      })
      .catch(() => { /* badge stays in network mode; search retries connect */ })
      .finally(() => setConnecting(false));
    return () => azns.stopPaymentWatcher();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand" onClick={() => setTab('search')} role="button">
          <img className="logo" src="/truprotocol-logo-64.png" alt="truProtocol" width={36} height={36} />
          <b>truProtocol</b>
        </div>
        <nav className="tabs">
          <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search</button>
          <button className={tab === 'mine' ? 'on' : ''} onClick={() => { setMineCount(azns.myNames().length); setTab('mine'); }}>
            My names{mineCount ? <span className="pip">{mineCount}</span> : null}
          </button>
        </nav>
        <span className="rc-tags">
          {balance !== null && <span className="badge ghosty" title="Your private token balance (auto-updates)">{String(balance)} TRU</span>}
          {account
            ? <Copyable text={account} className="badge" title="Click to copy your address"><span className="dot" />{short(account)}</Copyable>
            : <span className="badge ghosty">{connecting ? 'Connecting…' : azns.isLocal ? 'Local' : 'Testnet'}</span>}
          <button className="theme-btn" onClick={() => setTheme((t) => t === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}>
            <Icon d={theme === 'light' ? I.moon : I.sun} size={16} />
          </button>
        </span>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}

      {tab === 'search'
        ? <SearchTab setAccount={setAccount} onRegistered={() => setMineCount(azns.myNames().length)} />
        : <Dashboard setAccount={setAccount} lastPay={lastPay} />}

      <footer className="foot">
        Running on {azns.isLocal ? 'a local network' : 'Aztec testnet'}
        {process.env.AZNS_ADDRESS ? <> · registry <span title={process.env.AZNS_ADDRESS}>{short(process.env.AZNS_ADDRESS)}</span></> : null}
        {' '}· unaudited demo
      </footer>
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
        <>
          <div className="features">
            <Feature icon={I.globe} title="Public + multichain" text="ENS-style public names that can point to addresses on Aztec, Bitcoin, Ethereum, and more." />
            <Feature icon={I.shield} title="Stealth" text="Anyone can pay you, while every payment stays hidden and unlinkable on-chain." />
          </div>
          <HowItWorks />
        </>
      )}
    </>
  );
}

function Dashboard({ setAccount, lastPay }: { setAccount: (a: string | null) => void; lastPay?: { delta: string; at: number } | null }) {
  const [names, setNames] = useState(azns.myNames());
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  const [statuses, setStatuses] = useState<Record<string, { status: number; expiry: number | null }>>({});
  const [restoring, setRestoring] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const [cardEpoch, setCardEpoch] = useState(0); // bump remounts cards -> statuses re-fetch

  // Pull any names registered elsewhere (another browser/device) from the
  // on-chain label backups, then re-check every card against the chain.
  async function refreshList() {
    setRefreshing(true); setRefreshMsg('');
    try {
      const added = await azns.restoreMyNames();
      setNames(azns.myNames());
      setCardEpoch((e) => e + 1);
      setRefreshMsg(added > 0 ? `${added} name${added === 1 ? '' : 's'} added from the chain.` : 'Up to date.');
    } catch (e: any) { setRefreshMsg(e?.message ?? 'Refresh failed — try again.'); }
    finally { setRefreshing(false); }
  }

  // Renewal radar: anything in grace, or expiring within 30 days.
  const DAYS_30 = 30 * 86400;
  const needsRenewal = names.filter((n) => {
    const s = statuses[n.label];
    if (!s) return false;
    return s.status === 2 || (s.status === 1 && s.expiry !== null && s.expiry - Date.now() / 1000 < DAYS_30);
  });

  useEffect(() => {
    (async () => {
      try {
        await azns.connect(); setAccount(azns.accountAddress()); setReady(true);
        // Fresh browser/device? Rebuild the list from the encrypted on-chain
        // label backups - the list follows the account, not the browser.
        if (azns.myNames().length === 0) {
          setRestoring(true);
          try { if (await azns.restoreMyNames() > 0) setNames(azns.myNames()); }
          finally { setRestoring(false); }
        }
      } catch (e: any) { setErr(e?.message ?? 'Could not connect.'); }
    })();
  }, [setAccount]);

  if (names.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon"><Icon d={I.card} size={40} /></div>
        <h2>{restoring || refreshing ? 'Looking for your names…' : 'No names yet'}</h2>
        <p className="muted">{restoring || refreshing
          ? 'Checking the chain for names registered with this account.'
          : "Register a name from the Search tab and it'll show up here to manage. Already own one? Search for it — names you own are added back automatically."}</p>
        {!restoring && (
          <button className="ghost" onClick={refreshList} disabled={refreshing}>
            {refreshing ? 'Checking…' : 'Refresh list'}
          </button>
        )}
        {refreshMsg && <p className="muted small">{refreshMsg}</p>}
      </div>
    );
  }
  return (
    <div className="dash">
      <div className="dash-head">
        <h2 className="dash-title">My names <span className="muted">({names.length})</span></h2>
        <button className="ghost" onClick={refreshList} disabled={refreshing} title="Re-check the chain for names registered on other devices and refresh every card">
          {refreshing ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>
      {refreshMsg && <p className="muted small">{refreshMsg}</p>}
      {lastPay && <p className="muted small">Last payment received: <b>+{lastPay.delta} TRU</b> · {new Date(lastPay.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
      {err && <div className="notice err">{err}</div>}
      {!ready && <p className="muted small">connecting…</p>}
      {needsRenewal.length > 0 && (
        <div className="notice warn">
          <Icon d={I.warn} size={14} /> <b>Renew soon:</b>{' '}
          {needsRenewal.map((n) => `${n.label}.tru${statuses[n.label]?.status === 2 ? ' (in grace)' : ''}`).join(', ')}
          {' '}— use the Renew button on the card below.
        </div>
      )}
      {names.map((n) => (
        <OwnedCard key={`${n.label}:${cardEpoch}`} label={n.label} name={`${n.label}.tru`} mode={n.mode}
          expiry={azns.estimatedExpiry(n)}
          onStatus={(label, s) => setStatuses((prev) => ({ ...prev, [label]: { status: s.status, expiry: s.expiry } }))}
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

/** Plain-words story of each mode, starring Bob and his payers. */
function HowItWorks() {
  const stories: { icon: JSX.Element; mode: ModeName; title: string; who: string; story: JSX.Element }[] = [
    {
      icon: I.globe, mode: 'PUBLIC', title: 'Public', who: 'Anyone can find him',
      story: <>Bob opens a bakery and registers <b>bobsbakery.tru</b> as Public. Alice, Carol — anyone —
        can look it up and pay him on Aztec, Bitcoin or Ethereum. The address is out in the open like a
        shop sign, but the payments themselves stay private.</>,
    },
    {
      icon: I.shield, mode: 'STEALTH', title: 'Stealth', who: 'No one — money still arrives',
      story: <>Bob collects tips at <b>ghostline.tru</b> in Stealth mode. Anyone can pay without asking —
        Alice today, a stranger tomorrow — and each payment lands at a fresh address only Bob can find.
        Even payers comparing notes learn nothing.</>,
    },
  ];
  return (
    <section className="how">
      <h2 className="how-title">How the two modes work</h2>
      <p className="muted center how-sub">Same names, two privacy levels — here's Bob using each one.</p>
      {stories.map((s) => (
        <div className="how-card" key={s.mode}>
          <div className="how-head">
            <span className="fi"><Icon d={s.icon} size={20} /></span>
            <b>{s.title}</b>
            <em className="mode-price">${priceUsdForMode(s.mode)}/yr</em>
            <span className="who">{s.who}</span>
          </div>
          <p>{s.story}</p>
        </div>
      ))}
      <p className="muted small center">In every mode, Aztec keeps the payment itself private — no sender,
        recipient or amount ever appears on-chain.</p>
    </section>
  );
}

const MODES: { key: ModeName; label: string; hint: string }[] = [
  { key: 'PUBLIC', label: 'Public', hint: 'Anyone can look it up' },
  { key: 'STEALTH', label: 'Stealth', hint: 'Anyone pays; each payment hidden & unlinkable' },
];

function ResultCard({ result, onChanged, setAccount, onRegistered }: { result: SearchResult; onChanged: () => void; setAccount: (a: string | null) => void; onRegistered?: () => void }) {
  const [mode, setMode] = useState<ModeName>('PUBLIC');
  const [years, setYears] = useState(1);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [done, setDone] = useState<{ mode: ModeName } | null>(null);

  if (result.tooShort || result.tooLong) {
    return <div className="result-card"><div className="rc-head"><span className="rc-name">{result.name}</span></div>
      <p className="muted">{result.tooShort
        ? 'Names need at least 3 characters. Try a longer one.'
        : `Names can be at most 31 characters — this one is ${result.len}. Try a shorter one.`}</p></div>;
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
        <RecordsView label={result.label} />
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

      <TokenBar />

      <button className="cta" disabled={busy} onClick={claim}>
        {busy ? (step || 'Working…') : `Register for $${total}`}
      </button>
      {!busy && <p className="muted small center">Your keys stay in your browser. Network fees are{' '}
        {azns.feeMode()?.funded ? 'paid from your account’s fee juice' : 'sponsored'} — the registration price is paid in the registry’s token.</p>}
      {busy && <p className="muted small center">{mode === 'STEALTH'
        ? 'Registering and publishing your stealth key automatically — two private proofs, this can take a few minutes.'
        : 'This can take a minute while your registration is proven privately.'}</p>}
    </div>
  );
}

const STATUS_LABEL = ['Available', 'Active', 'In grace'];
function OwnedCard({ name, label, justClaimed, mode, expiry, onStatus, onChanged, onForget }: { name: string; label: string; justClaimed?: boolean; mode?: ModeName; expiry?: number | null; onStatus?: (label: string, s: { status: number; expiry: number | null }) => void; onChanged: () => void; onForget?: () => void }) {
  const [target, setTarget] = useState('');
  const [points, setPoints] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [info, setInfo] = useState<{ status: number; mine: boolean; mode: ModeName | null; expiry: number | null } | null>(null);
  // (isPublic derives from liveMode below, after on-chain state loads)
  const [keyPublished, setKeyPublished] = useState<boolean | null>(null);

  const refresh = () => azns.nameStatus(label).then((s) => { setInfo(s); onStatus?.(label, { status: s.status, expiry: s.expiry }); }).catch(() => {});
  useEffect(() => { refresh(); }, [label]);

  const status = info?.status ?? null;
  const owned = justClaimed === true || info?.mine === true;
  const checkedNotMine = info !== null && !owned;
  // On-chain mode/expiry win over whatever local storage remembered.
  const liveMode: ModeName = info?.mode ?? mode ?? 'PUBLIC';
  const liveExpiry = info?.expiry ?? expiry ?? null;
  const isPublic = liveMode === 'PUBLIC';

  useEffect(() => {
    if (liveMode === 'STEALTH') azns.hasStealthKey(label).then(setKeyPublished).catch(() => {});
  }, [label, liveMode]);

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
    try { await azns.renew(label, liveMode, 1, setStep); setStep('Renewed +1 year.'); refresh(); onChanged(); }
    catch (e: any) { setStep(`Couldn't renew: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function publishStealth() {
    setBusy(true); setStep('');
    try { await azns.publishStealth(label, setStep); setKeyPublished(true); refresh(); }
    catch (e: any) { setStep(`Couldn't publish: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="result-card owned">
      <div className="rc-head">
        <span className="rc-name">{name}</span>
        <span className="rc-tags">
          {status !== null && <span className={`tag ${status === 1 ? 'avail' : 'taken'}`}>{STATUS_LABEL[status] ?? '—'}</span>}
          <span className="mode-chip">{liveMode.toLowerCase()}</span>
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
              : (liveExpiry ? <p className="muted small">Expires <b>{fmtDate(liveExpiry)}</b> · {fmtRel(liveExpiry)}</p> : null)
          )}

          {isPublic ? (
            <>
              <p className="muted small">Points to <b>you</b> by default — repoint it below anytime.</p>
              <label className="field">Aztec address it points to
                <div className="row">
                  <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x… address, or a public name.tru" disabled={busy} />
                  <button onClick={save} disabled={busy || !target.trim()}>Save</button>
                </div>
              </label>
              {points && <p className="result">Aztec <Copyable text={points} /></p>}
              <RecordsManager label={label} />
              <div className="row">
                <button className="ghost" onClick={lookup} disabled={busy}>Look up Aztec</button>
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year (${priceUsdForMode(liveMode)})</button>
              </div>
            </>
          ) : liveMode === 'STEALTH' ? (
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
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year (${priceUsdForMode(liveMode)})</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">This name uses a retired mode. You can keep or renew it; per-mode management
                isn't available.</p>
              <div className="row">
                <button className="ghost" onClick={renew} disabled={busy}>Renew +1 year (${priceUsdForMode(liveMode)})</button>
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

/** Owner-side multichain records: point one name at Bitcoin, EVM chains,
 *  Solana and Aztec at the same time - one record per chain. */
function RecordsManager({ label }: { label: string }) {
  const [chainKey, setChainKey] = useState('BTC');
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [records, setRecords] = useState<{ chain: azns.Chain; address: string }[] | null>(null);
  const chain = azns.CHAINS.find((c) => c.key === chainKey)!;

  async function loadAll() {
    setBusy(true); setMsg('');
    try { setRecords(await azns.getAllRecords(label)); }
    catch (e: any) { setMsg(e?.message ?? 'could not load records'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMsg('');
    try {
      await azns.setRecord(label, chainKey, addr.trim(), setMsg);
      setAddr('');
      await loadAll();
      setMsg(`${chain.label} record saved.`);
    } catch (e: any) { setMsg(`Couldn't save: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="records">
      <div className="pay-head">
        <b><Icon d={I.globe} size={14} /> Multichain records</b>
        <button className="ghost" onClick={loadAll} disabled={busy}>{records === null ? 'Show records' : 'Refresh'}</button>
      </div>
      <p className="muted small">Point this name at addresses on many chains at once — one record per chain.</p>
      <div className="row">
        <select value={chainKey} onChange={(e) => setChainKey(e.target.value)} disabled={busy}>
          {azns.CHAINS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={chain.placeholder} disabled={busy} />
        <button onClick={save} disabled={busy || !addr.trim()}>Save</button>
      </div>
      {records !== null && (
        records.length === 0
          ? <p className="muted small">No records yet.</p>
          : <RecordList records={records} />
      )}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

/** Read-only records list shown to anyone on a taken name. */
function RecordsView({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<{ chain: azns.Chain; address: string }[] | null>(null);
  const [msg, setMsg] = useState('');
  async function load() {
    setBusy(true); setMsg('');
    try {
      const r = await azns.getAllRecords(label);
      setRecords(r);
      if (r.length === 0) setMsg('This name has no multichain records.');
    } catch (e: any) { setMsg(e?.message ?? 'could not load records'); }
    finally { setBusy(false); }
  }
  return (
    <div className="accessbox">
      <div className="pay-head">
        <b><Icon d={I.globe} size={14} /> Where does it point?</b>
        <button className="ghost" onClick={load} disabled={busy}>{busy ? 'Loading…' : records === null ? 'View records' : 'Refresh'}</button>
      </div>
      {records !== null && records.length > 0 && <RecordList records={records} />}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

function RecordList({ records }: { records: { chain: azns.Chain; address: string }[] }) {
  return (
    <div className="rec-list">
      {records.map((r) => (
        <div className="rec-row" key={r.chain.key}>
          <span className="rec-chain">{r.chain.label}</span>
          <Copyable text={r.address} />
        </div>
      ))}
    </div>
  );
}

// The test/payment token is 18-decimal (see deploy_testnet.ts). Show balances
// and take amounts in WHOLE tokens; convert to/from base units at the edges.
const TOKEN_UNIT = 10n ** 18n;
function fmtTok(base: bigint | null): string {
  if (base === null) return '—';
  const whole = base / TOKEN_UNIT;
  const cents = (base % TOKEN_UNIT) * 100n / TOKEN_UNIT;
  return cents > 0n ? `${whole}.${cents.toString().padStart(2, '0')}` : `${whole}`;
}

// Balance + faucet affordance. Registration is paid in the registry's token, so
// this lets a user top up right where they need it. The faucet only works where
// this account may mint the token (local dev / operator); elsewhere it surfaces
// a clear message and the user funds the account with the token instead.
function TokenBar({ onChanged }: { onChanged?: () => void }) {
  const [bal, setBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const refresh = async () => { try { setBal(await azns.tokenBalance()); } catch { /* not connected */ } };
  useEffect(() => { refresh(); }, []);
  async function faucet() {
    setBusy(true); setMsg('');
    try { await azns.getTestTokens(1000n * TOKEN_UNIT, setMsg); await refresh(); setMsg('Added 1000 test tokens.'); onChanged?.(); }
    catch (e: any) { setMsg(e?.message ?? 'Faucet failed.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="token-bar">
      <span className="muted small">Balance: {fmtTok(bal)} test tokens</span>
      <button type="button" className="ghost" onClick={faucet} disabled={busy}>{busy ? (msg || 'Working…') : 'Get test tokens'}</button>
      {!busy && msg && <span className="muted small">{msg}</span>}
    </div>
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
    try { await azns.getTestTokens(1000n * TOKEN_UNIT, setMsg); await refresh(); setMsg('Added 1000 test tokens.'); }
    catch (e: any) { setMsg(`Faucet failed: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  async function pay() {
    setBusy(true); setMsg('');
    try { await azns.payPrivately(label, BigInt(amount || '0') * TOKEN_UNIT, setMsg); await refresh(); setMsg(`Sent ${amount} tokens privately to ${name}.`); }
    catch (e: any) { setMsg(`Couldn't pay: ${e?.message ?? 'try again'}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="paybox">
      <div className="pay-head">
        <b><Icon d={I.send} size={14} /> Send privately to {name}</b>
        <span className="bal">balance: {fmtTok(bal)} tokens</span>
      </div>
      <div className="row">
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="amount (tokens)" disabled={busy} />
        <button onClick={pay} disabled={busy || !amount}>Send privately</button>
        <button className="ghost" onClick={faucet} disabled={busy}>Get test tokens</button>
      </div>
      <p className="muted small">Always a private transfer — the amount &amp; recipient never appear on the explorer.{busy ? ` ${msg || 'Working…'}` : msg ? ` ${msg}` : ''}</p>
    </div>
  );
}

