import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

/** Last-resort error boundary: a crash anywhere in the tree shows a friendly
 *  reload card instead of a blank page. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="wrap">
        <div className="result-card" style={{ marginTop: 80, textAlign: 'center' }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p className="muted">{String(this.state.error?.message ?? this.state.error)}</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
