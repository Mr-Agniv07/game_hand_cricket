import { useState } from 'react';
import type { FormEvent } from 'react';
import { apiPost } from '../api';
import './AuthScreen.css';
import type { AuthResponse } from '@cric/types';

type AuthTab = 'login' | 'signup';

interface AuthScreenProps {
  onAuth: (data: AuthResponse) => void;
  onGuest: () => void;
}

export default function AuthScreen({ onAuth, onGuest }: AuthScreenProps) {
  const [tab, setTab] = useState<AuthTab>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (tab === 'signup' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiPost<AuthResponse>(tab === 'login' ? '/api/login' : '/api/signup', {
        username: username.trim(),
        password,
      });
      onAuth(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function switchTab(t: AuthTab) {
    setTab(t);
    setError('');
    setPassword('');
    setConfirm('');
  }

  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <span className="auth-logo">🏏</span>
        <h1 className="auth-title">Cric Flick</h1>
        <p className="auth-sub">Sign in to track your stats</p>
      </div>

      <div className="tabs">
        <button
          className={tab === 'login' ? 'tab active' : 'tab'}
          onClick={() => switchTab('login')}
        >
          Sign In
        </button>
        <button
          className={tab === 'signup' ? 'tab active' : 'tab'}
          onClick={() => switchTab('signup')}
        >
          Sign Up
        </button>
      </div>

      <form className="card form" onSubmit={handleSubmit}>
        <label>Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter username"
          maxLength={20}
          autoFocus
          required
        />

        <label>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter password"
          required
        />

        {tab === 'signup' && (
          <>
            <label>Confirm Password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              required
            />
          </>
        )}

        {error && <p className="auth-error">{error}</p>}

        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Please wait…' : tab === 'login' ? 'Sign In' : 'Create Account'}
        </button>
      </form>

      <button className="guest-btn" onClick={onGuest}>
        Continue as Guest
      </button>
    </div>
  );
}
